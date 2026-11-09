import { ProxmoxError, type PoolGuest, type Proxmox } from "../proxmox/api.ts";
import { isEarlierGuest, isHeldCopy } from "../proxmox/copies.ts";
import { NoLongerOurs, OwnedGuests, sameGuestOwner } from "./owned.ts";
import { installTag, ownerFromDescription, ownerFromTags } from "../proxmox/owner.ts";
import type { GpuMarkAnswer, GpuMarkGuest, GpuMarkRequest, GpuMarking } from "../types.ts";
import { judgeGpuHelper, parseGpuHelper, tooOldForWhole } from "./gpu-helper.ts";
import {
  NO_HELPER_LINES,
  answerTo,
  boxOf,
  cardName,
  gpuTagsOf,
  markerTag,
  parseHelperLines,
  planMark,
  planUnmark,
  releasedAt,
  tagsOf,
  withMarker,
  type GuestLook,
  type HelperLines,
  type MarkAnswer,
  type MarkContext,
  type MarkPlan,
  type UnmarkPlan,
} from "./gpu-marking.ts";
import { PRODUCT } from "../../brand.ts";


const ANSWER_POLLS = 10;
const ANSWER_POLL_MS = 1_000;
const WRITE_TRIES = 2;
const LOOKS_AT_ONCE = 8;
export const RELEASING_HELPER = "0.3.0";

export function helperAtLeast(version: string | null, least: string): boolean {
  if (version === null || !/^\d+(?:\.\d+)*$/.test(version)) return false;
  const have = version.split(".").map(Number);
  const want = least.split(".").map(Number);
  for (let at = 0; at < Math.max(have.length, want.length); at++) {
    const difference = (have[at] ?? 0) - (want[at] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

export interface MarkingSetup {
  readonly backend: string;
  readonly label: string;
  readonly pool: string;
  readonly installId: string;
  readonly reportVm: string;
  readonly madeAndRemovedByBbBox: (tags: readonly string[]) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly ago: (ms: number) => string;
}

export function isOurGuest(guest: PoolGuest, setup: Pick<MarkingSetup, "installId" | "madeAndRemovedByBbBox">, node: string): boolean {
  return (
    guest.type === "lxc" &&
    !guest.template &&
    (!guest.node || guest.node === node) &&
    guest.tags.includes(installTag(setup.installId)) &&
    !isHeldCopy(guest.tags) &&
    !isEarlierGuest(guest.tags) &&
    !setup.madeAndRemovedByBbBox(guest.tags)
  );
}

export async function lookAt(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<GuestLook> {
  const [config, pending] = await Promise.all([api.currentConfig(vmid, signal), api.pendingChanges(vmid, signal)]);
  return { vmid, config, pending };
}

export async function lookAtEach(api: Proxmox, guests: readonly PoolGuest[], signal?: AbortSignal): Promise<GuestLook[]> {
  const looks: GuestLook[] = [];
  for (let at = 0; at < guests.length; at += LOOKS_AT_ONCE) looks.push(...(await Promise.all(guests.slice(at, at + LOOKS_AT_ONCE).map((guest) => lookAt(api, guest.vmid, signal)))));
  return looks;
}

function boxIdOf(look: GuestLook): string | null {
  return (ownerFromTags(tagsOf(look)) ?? ownerFromDescription(look.config.description))?.boxId ?? null;
}

function boxesNamed(looks: readonly GuestLook[]): Map<string, number[]> {
  const named = new Map<string, number[]>();
  for (const look of looks) {
    const box = boxOf(typeof look.config.description === "string" ? look.config.description : "");
    if (box !== null) named.set(box, [...(named.get(box) ?? []), look.vmid]);
  }
  return named;
}

type Plan = MarkPlan | UnmarkPlan;
type Planned = { readonly guest: PoolGuest; readonly look: GuestLook; readonly plan: Plan; readonly wrote: boolean; readonly failed: string | null; readonly cleared?: boolean };

function nextTags(look: GuestLook, plan: Plan): string[] | null {
  if (plan.is === "mark") return withMarker(tagsOf(look), plan.marker);
  if (plan.is === "release" && !plan.asked) return withMarker(tagsOf(look), plan.marker);
  if (plan.is === "unmark") return tagsOf(look).filter((tag) => tag !== plan.marker);
  return null;
}

async function planAndWrite(api: Proxmox, installId: string, guest: PoolGuest, first: GuestLook, request: GpuMarkRequest, plan: (look: GuestLook) => Plan, signal?: AbortSignal): Promise<Planned> {
  const owner = sameGuestOwner(installId, first.config);
  let look = first;
  for (let tries = 1; ; tries++) {
    const decided = plan(look);
    const next = nextTags(look, decided);
    if (!next || request.check) return { guest, look, plan: decided, wrote: false, failed: null };
    if (typeof look.config.digest !== "string" || !look.config.digest) {
      return { guest, look, plan: decided, wrote: false, failed: `Proxmox gave no digest with its config, so ${PRODUCT} does not write its tags.` };
    }
    try {
      await new OwnedGuests(api).writeOn(guest.vmid, owner, look.config, { tags: next }, signal);
      return { guest, look, plan: decided, wrote: true, failed: null };
    } catch (error) {
      if (error instanceof NoLongerOurs) return { guest, look, plan: decided, wrote: false, failed: error.message };
      const meanwhile = error instanceof ProxmoxError && error.changedMeanwhile;
      if (!meanwhile || tries >= WRITE_TRIES) {
        const why = meanwhile ? `Its config kept changing while ${PRODUCT} wrote its tags. Run bb box gpu mark again.` : `Proxmox refused its tags: ${error instanceof Error ? error.message : String(error)}`;
        return { guest, look, plan: decided, wrote: false, failed: why };
      }
      look = await lookAt(api, guest.vmid, signal);
    }
  }
}

function outcomeOf(planned: Planned, check: boolean): Pick<GpuMarkGuest, "outcome" | "why" | "marker" | "card"> {
  const { plan, failed } = planned;
  const gpu = gpuTagsOf(tagsOf(planned.look)).join(" ") || null;
  if (failed) return { outcome: "refused", why: failed, marker: gpu, card: null };
  switch (plan.is) {
    case "release":
      if (check) return { outcome: "would-unmark", why: gpu ? null : "It has no marker, but the helper's ledger holds a claim for it.", marker: gpu, card: null };
      if (planned.cleared) return { outcome: "unmarked", why: gpu ? null : "It had no marker, but the helper's ledger held a claim for it.", marker: gpu, card: null };
      return { outcome: "refused", why: `${markerTag(plan.marker)} is on it, so the helper clears its claim once it answers; run bb box gpu mark --undo again then to take the tag off.`, marker: markerTag(plan.marker), card: null };
    case "mark":
      return { outcome: check ? "would-mark" : "marked", why: plan.why, marker: markerTag(plan.marker), card: cardName(plan.card) };
    case "marked":
    case "waiting":
      return { outcome: "already", why: null, marker: markerTag(plan.marker), card: cardName(plan.card) };
    case "refused":
      return { outcome: "refused", why: plan.why, marker: gpu, card: plan.card ? cardName(plan.card) : null };
    case "unmark":
      return { outcome: check ? "would-unmark" : "unmarked", why: null, marker: plan.marker, card: null };
    case "kept":
      return { outcome: "kept", why: plan.why, marker: gpu, card: null };
    default:
      return { outcome: "unmarked", why: null, marker: null, card: null };
  }
}

async function readLines(api: Proxmox, setup: MarkingSetup, signal?: AbortSignal): Promise<HelperLines | null> {
  const vm = await api.vmNotes(setup.reportVm, signal);
  return vm ? parseHelperLines(vm.notes) : null;
}

function answerOf(lines: HelperLines, planned: Planned): MarkAnswer | null {
  const { plan, wrote, guest } = planned;
  if (plan.is === "mark" && wrote) return answerTo(lines, guest.vmid, plan.marker, false);
  if (plan.is === "marked" || plan.is === "waiting") return answerTo(lines, guest.vmid, plan.marker, true);
  return null;
}

async function answersFor(api: Proxmox, setup: MarkingSetup, planned: readonly Planned[], lines: HelperLines, check: boolean, signal?: AbortSignal): Promise<Map<number, MarkAnswer>> {
  const asked = planned.filter((each) => (each.plan.is === "mark" && each.wrote) || each.plan.is === "marked" || each.plan.is === "waiting");
  const wait = !check && asked.some((each) => each.wrote || each.plan.is === "waiting");
  const answers = new Map<number, MarkAnswer>();
  let latest = lines;
  for (let poll = 0; ; poll++) {
    for (const each of asked) answers.set(each.guest.vmid, answerOf(latest, each)!);
    if (!wait || ![...answers.values()].some((answer) => answer.is === "unanswered") || poll >= ANSWER_POLLS) return answers;
    await setup.sleep(ANSWER_POLL_MS, signal);
    latest = (await readLines(api, setup, signal)) ?? latest;
  }
}

async function clearReleased(api: Proxmox, setup: MarkingSetup, planned: readonly Planned[], first: HelperLines, signal?: AbortSignal): Promise<Planned[]> {
  const asked = (each: Planned) => each.plan.is === "release" && !each.failed && (each.wrote || each.plan.asked);
  let lines = first;
  for (let poll = 0; ; poll++) {
    const waiting = planned.filter((each) => asked(each) && each.plan.is === "release" && !releasedAt(lines, each.guest.vmid, each.plan.marker.generation));
    if (!waiting.length || poll >= ANSWER_POLLS) break;
    await setup.sleep(ANSWER_POLL_MS, signal);
    lines = (await readLines(api, setup, signal)) ?? lines;
  }
  const cleared: Planned[] = [];
  for (const each of planned) {
    if (!asked(each) || each.plan.is !== "release" || !releasedAt(lines, each.guest.vmid, each.plan.marker.generation)) {
      cleared.push(each);
      continue;
    }
    const release = markerTag(each.plan.marker);
    const takenOff = await planAndWrite(api, setup.installId, each.guest, await lookAt(api, each.guest.vmid, signal), { check: false, undo: true, recordedParts: new Map() }, (look) =>
      gpuTagsOf(tagsOf(look)).includes(release) ? { is: "unmark", marker: release } : { is: "unmarked" },
    signal);
    cleared.push({ ...each, cleared: !takenOff.failed, failed: takenOff.failed ? `The helper cleared its claim, but ${takenOff.failed}` : null });
  }
  return cleared;
}

export async function markGpus(api: Proxmox, setup: MarkingSetup, request: GpuMarkRequest, signal?: AbortSignal): Promise<GpuMarking> {
  const node = api.node;
  const base = { backend: setup.backend, label: setup.label, node, check: request.check, undo: request.undo, withoutCards: 0 };
  const refuse = (detail: string, fix: string | null): GpuMarking => ({ ...base, refused: { detail, fix }, guests: [] });
  const vm = await api.vmNotes(setup.reportVm, signal);
  const helper = vm ? parseGpuHelper(vm.notes) : null;
  let lines: HelperLines = vm ? parseHelperLines(vm.notes) : NO_HELPER_LINES;
  {
    if (!vm) return refuse(`The token can read no VM named ${setup.reportVm} on ${node}, so ${PRODUCT} cannot read the GPU helper's report.`, `Run host/setup-gpu-report.sh, then host/setup-gpu.sh, from the setup guide as root on ${node}.`);
    if (!helper) return refuse(`${node} has no GPU helper: VM ${vm.vmid}'s report has no helper line, and only the helper, bb-box-gpu, answers a marker.`, `Run host/setup-gpu.sh from the setup guide as root on ${node}.`);
    const at = /^\s*at (\d+)\s*$/m.exec(vm.notes);
    const verdict = judgeGpuHelper(helper, { node, pool: setup.pool, vmid: vm.vmid, ageMs: at ? setup.now() - Number(at[1]) * 1000 : null, ago: setup.ago });
    if (verdict.status === "fail") return refuse(verdict.detail, verdict.fix);
    if (!lines.cards.length) return refuse(`The GPU helper on ${node} lists no card in VM ${vm.vmid}'s report, so ${PRODUCT} cannot tell which card a guest's lines name.`, `Run systemctl status bb-box-gpu and nvidia-smi as root on ${node}.`);
    if (!lines.ledgerReported) {
      return refuse(
        `bb-box-gpu ${helper.version} on ${node} does not report its ledger, which bb box gpu mark needs to ask above each guest's last answered generation and to read each grant.`,
        `Run host/setup-gpu.sh from this BB Box's setup guide, as root on ${node}, to install bb-box-gpu 0.2.0 or later.`,
      );
    }
    if (lines.omitted.length) return refuse(`VM ${vm.vmid}'s report leaves lines out (${lines.omitted.join("; ")}), so ${PRODUCT} cannot read every claim the helper holds.`, `Read what the helper says with journalctl -u bb-box-gpu on ${node}.`);
    if (request.undo && !helperAtLeast(helper.version, RELEASING_HELPER)) {
      return refuse(
        `bb-box-gpu ${helper.version} on ${node} cannot clear a claim, and --undo clears each claim the helper holds before it takes a marker off.`,
        `Run host/setup-gpu.sh from this BB Box's setup guide, as root on ${node}, to install bb-box-gpu ${RELEASING_HELPER} or later.`,
      );
    }
  }
  const wholeTooOld = tooOldForWhole(node, helper.version);
  const ours = (await api.listPool(setup.pool, signal)).filter((guest) => isOurGuest(guest, setup, node)).sort((a, b) => a.vmid - b.vmid);
  const looks = await lookAtEach(api, ours, signal);
  const boxNamedBy = boxesNamed(looks);
  const context = (look: GuestLook): MarkContext => {
    const box = boxOf(typeof look.config.description === "string" ? look.config.description : "");
    const named = new Map(boxNamedBy);
    for (const [key, vmids] of named) named.set(key, vmids.filter((vmid) => vmid !== look.vmid));
    if (box !== null) named.set(box, [...(named.get(box) ?? []), look.vmid]);
    return { installId: setup.installId, madeAndRemovedByBbBox: setup.madeAndRemovedByBbBox, cards: lines.cards, holders: lines.holders, ledger: lines.ledger, answers: lines.answers, boxNamedBy: named, wholeTooOld };
  };
  const plan = (look: GuestLook): Plan => {
    if (request.undo) return planUnmark(look, setup, lines.ledger);
    const boxId = boxIdOf(look);
    return planMark({ look, recordedPart: boxId === null ? null : (request.recordedParts.get(boxId) ?? null) }, context(look));
  };
  let planned: Planned[] = [];
  for (const [at, guest] of ours.entries()) planned.push(await planAndWrite(api, setup.installId, guest, looks[at]!, request, plan, signal));
  if (planned.some((each) => each.wrote)) lines = (await readLines(api, setup, signal)) ?? lines;
  if (request.undo && !request.check) planned = await clearReleased(api, setup, planned, lines, signal);
  const answers = request.undo ? new Map<number, MarkAnswer>() : await answersFor(api, setup, planned, lines, request.check, signal);
  const shown = planned.filter((each) => each.plan.is !== "no-card" && (each.plan.is !== "unmarked" || each.failed));
  const released = (each: Planned): GpuMarkAnswer | null => (each.plan.is === "release" && !request.check ? (each.cleared ? "released" : "unanswered") : null);
  const guests: GpuMarkGuest[] = shown.map((each) => {
    const answer = answers.get(each.guest.vmid);
    return {
      vmid: each.guest.vmid,
      name: each.guest.name,
      running: each.guest.status === "running",
      ...outcomeOf(each, request.check),
      answer: (answer?.is as GpuMarkAnswer | undefined) ?? released(each),
      answerWhy: answer && "why" in answer ? answer.why : null,
    };
  });
  const withoutCards = planned.filter((each) => each.plan.is === "no-card" || (each.plan.is === "unmarked" && !each.failed)).length;
  return { ...base, refused: null, guests, withoutCards };
}
