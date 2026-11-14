import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendError, SnapshotFailed, type Backend, type CopyHooks, type GpuHandoff, type GpuPart, type Guest, type GuestIdentity, type BoxIdentity, type SnapshotHooks, type SnapshotRef } from "../src/backends/types.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { COMMAND, THREAD, armedWorld, readyBox, rejection, standing, untilHeld, type World } from "./snapshot-world.ts";

const CARD_A = "card-a";
const CARD_B = "card-b";

interface FakeClaim {
  readonly part: GpuPart;
  readonly card: string | null;
  readonly generation: number;
}

const never = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));

class FakeCards {
  readonly claims = new Map<string, FakeClaim>();
  readonly lines = new Map<string, string | null>();
  readonly onboot = new Map<string, boolean>();
  readonly pins = new Map<string, string>();
  readonly taken = new Map<string, number>();
  readonly snapshotLines = new Map<string, string | null>();
  readonly events: string[] = [];
  readonly failing = new Set<string>();
  readonly hanging = new Set<string>();
  readonly hangingAfter = new Set<string>();
  readonly bootAtStart = new Map<string, boolean | undefined>();
  copyLines: string | null = null;
  seenAtArm: { readonly onboot: boolean | undefined; readonly lines: string | null | undefined } | null = null;
  #generation = 10;

  give(ref: string, part: GpuPart, card: string | null): void {
    this.claims.set(ref, { part, card: part === "none" ? null : card, generation: ++this.#generation });
    this.lines.set(ref, part === "none" ? null : card);
  }

  holdersOf(card: string): string[] {
    return [...this.claims].filter(([, claim]) => claim.part !== "none" && claim.card === card).map(([ref]) => ref);
  }

  restarted(state: World): void {
    this.pins.clear();
    this.attach(state);
  }

  async #step(name: string, guest: Guest, signal?: AbortSignal): Promise<void> {
    this.events.push(`${name} ${guest.ref}`);
    if (this.hanging.delete(name)) await never(signal);
    if (this.failing.delete(name)) throw new Error(`the host's GPU helper did not answer the ${name} within 10 s`);
  }

  attach(state: World): void {
    const backend = state.backend as unknown as Record<string, unknown> & Backend;
    const start = backend.start!.bind(backend);
    const powerOff = backend.powerOff!.bind(backend);
    const rollback = backend.rollbackSnapshot!.bind(backend);
    const adopt = backend.adoptCopy!.bind(backend);
    const boxOf = (guest: Guest) => String(guest.data?.box);
    backend.readGpuClaim = async (guest: Guest): Promise<GpuHandoff | null> => {
      const claim = this.claims.get(guest.ref);
      return claim ? { ...claim, index: claim.card === CARD_A ? 0 : claim.card === CARD_B ? 1 : null } : null;
    };
    backend.keepGpuClaim = async (guest: Guest, held: GpuHandoff, signal?: AbortSignal) => {
      await this.#step("keep", guest, signal);
      this.give(guest.ref, held.part, held.card);
    };
    backend.bootsWithNode = async (guest: Guest) => this.onboot.get(guest.ref) ?? true;
    backend.releaseGpuClaim = async (guest: Guest, signal?: AbortSignal) => {
      await this.#step("release", guest, signal);
      this.give(guest.ref, "none", null);
      this.onboot.set(guest.ref, false);
      if (this.hangingAfter.delete("release")) await never(signal);
    };
    backend.armAdopted = async (guest: Guest, held: GpuHandoff | null, bootsWithNode: boolean | null, signal?: AbortSignal) => {
      this.seenAtArm = { onboot: this.onboot.get(guest.ref), lines: this.lines.get(guest.ref) };
      await this.#step("arm", guest, signal);
      this.give(guest.ref, held?.part ?? "none", held?.card ?? null);
      this.onboot.set(guest.ref, bootsWithNode ?? true);
    };
    backend.armReturned = async (guest: Guest, held: GpuHandoff, bootsWithNode: boolean | null, signal?: AbortSignal) => {
      await this.#step("return", guest, signal);
      this.give(guest.ref, held.part, held.card);
      if (bootsWithNode !== null) this.onboot.set(guest.ref, bootsWithNode);
    };
    backend.holdGpuCard = async (guest: Guest, held: GpuHandoff, signal?: AbortSignal) => {
      await this.#step("hold", guest, signal);
      if (this.pins.get(boxOf(guest)) === held.card) return;
      if ((this.taken.get(held.card!) ?? 0) >= 1) throw new BackendError("no_capacity", `Card ${held.card}, which the box holds, cannot take it now: it has another box of this install, the most a card may have. A restore keeps a box on its card, so BB Box does not move it to another one.`);
      this.pins.set(boxOf(guest), held.card!);
    };
    backend.dropGpuCard = (boxId: string) => {
      if (this.pins.delete(boxId)) this.events.push(`drop ${boxId}`);
    };
    backend.start = async (guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void, answered?: () => Promise<void>) => {
      const pin = this.pins.get(boxOf(guest));
      const claim = this.claims.get(guest.ref);
      if (pin !== undefined) {
        if (claim?.card !== pin || this.lines.get(guest.ref) !== pin) throw new Error(`Container ${guest.ref} was not started: its claim is ${claim?.card ?? "none"}, and the box holds ${pin}.`);
        this.pins.delete(boxOf(guest));
      } else if (claim && claim.part !== "none" && claim.card && (this.taken.get(claim.card) ?? 0) >= 1) {
        const other = claim.card === CARD_A ? CARD_B : CARD_A;
        this.give(guest.ref, claim.part, other);
        this.events.push(`moved ${guest.ref} to ${other}`);
      }
      this.events.push(`start ${guest.ref} on ${this.lines.get(guest.ref) ?? "none"}`);
      this.bootAtStart.set(guest.ref, this.onboot.get(guest.ref));
      return start(guest, signal, timing, answered);
    };
    backend.powerOff = async (guest: Guest, signal?: AbortSignal) => {
      this.events.push(`stop ${guest.ref}`);
      return powerOff(guest, signal);
    };
    backend.rollbackSnapshot = async (guest: Guest, ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal) => {
      await rollback(guest, ref, hooks, signal);
      this.lines.set(guest.ref, this.snapshotLines.get(ref.id) ?? null);
      this.events.push(`rollback ${guest.ref}`);
    };
    backend.adoptCopy = async (copy: Guest, box: BoxIdentity, identity: GuestIdentity, hooks: CopyHooks, signal?: AbortSignal) => {
      if (this.failing.delete("adopt")) throw new SnapshotFailed("Every VMID from 3240 to 3244 is in use.");
      const fresh = await adopt(copy, box, identity, hooks, signal);
      this.lines.set(fresh.ref, this.copyLines);
      this.onboot.set(fresh.ref, false);
      this.events.push(`adopt ${fresh.ref}`);
      return fresh;
    };
  }
}

async function current(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

async function onCardB(): Promise<{ state: World; cards: FakeCards; box: BoxRecord; snapshot: string }> {
  const state = armedWorld();
  const cards = new FakeCards();
  cards.attach(state);
  const box = await readyBox(state);
  cards.give(box.guest!.ref, "shared", CARD_A);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "on card a" })).snapshot!;
  cards.snapshotLines.set(taken.id, CARD_A);
  cards.give(box.guest!.ref, "shared", CARD_B);
  cards.events.length = 0;
  return { state, cards, box, snapshot: taken.id };
}

async function heldAt(state: World, cards: FakeCards, box: BoxRecord, ref: string, step: NonNullable<World["holds"]["step"]>): Promise<void> {
  state.holds.step = step;
  const held = state.snapshots.restore(COMMAND, box, standing(box), ref).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  cards.restarted(state);
}

test("071 unit 6, Astra 2: an in-place restore holds the box's card from before its stop to its start, writes the box's claim back after the rollback, and starts on that claim, not the snapshot's card", async () => {
  const { state, cards, box, snapshot } = await onCardB();
  const ref = box.guest!.ref;
  let heldWhileRolledBack: string | undefined;
  const backend = state.backend as unknown as Backend;
  const keep = backend.keepGpuClaim!;
  backend.keepGpuClaim = async (guest: Guest, held: GpuHandoff, signal?: AbortSignal) => {
    heldWhileRolledBack = cards.pins.get(box.id);
    assert.equal(cards.lines.get(ref), CARD_A, "the rollback brought back the snapshot's lines");
    cards.taken.set(CARD_B, 1);
    return keep(guest, held, signal);
  };
  await state.snapshots.restore(COMMAND, box, standing(box), snapshot);
  assert.equal(heldWhileRolledBack, CARD_B, "the card stays held for the box while it is stopped");
  assert.deepEqual(cards.events, [`hold ${ref}`, `stop ${ref}`, `rollback ${ref}`, `keep ${ref}`, `hold ${ref}`, `start ${ref} on ${CARD_B}`]);
  assert.deepEqual(cards.holdersOf(CARD_B), [ref]);
  assert.equal(cards.pins.size, 0, "the start took the held card");
  assert.equal((await current(state, box)).state, "ready");
});

test("071 unit 6, Astra 2: a restore whose box's card has no room for it now is refused before the stop, with nothing changed, rather than moved to another card", async () => {
  const { state, cards, box, snapshot } = await onCardB();
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  cards.taken.set(CARD_B, 1);
  cards.events.length = 0;
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), snapshot));
  assert.equal(refused.code, "no_capacity");
  assert.match(refused.message, new RegExp(`^BB Box did not restore box ${box.name}: Card card-b, which the box holds, cannot take it now: .* BB Box does not move it to another one\\. BB Box changed nothing\\.$`));
  assert.deepEqual(cards.events, [`hold ${box.guest!.ref}`]);
  assert.equal(cards.claims.get(box.guest!.ref)?.card, CARD_B);
  const operation = state.store.operations({ box: box.id, kind: "restore" })[0]!;
  assert.equal(operation.state, "failed");
  assert.equal((await current(state, box)).restoring ?? null, null);
});

test("071 unit 8, round 4: a restore the backend refuses before the stop, as the box's whole card cannot be asked for whole again, says why to each audience, and changes nothing", async () => {
  const { state, cards, box, snapshot } = await onCardB();
  const backend = state.backend as unknown as Backend;
  const person = "Card 1 is the box's whole card, which a restore asks the host's GPU helper for again: pve cannot give a box a whole card now, as its GPU helper is bb-box-gpu 0.4.2. Upgrade the helper.";
  const agent = "Card 1 is the box's whole card, which a restore asks the host's GPU helper for again: pve cannot give a box a whole card now, as its GPU helper is bb-box-gpu 0.4.2. Ask the user.";
  backend.holdGpuCard = async (guest: Guest) => {
    cards.events.push(`hold ${guest.ref}`);
    throw new BackendError("no_capacity", person, agent);
  };
  const refused = await rejection(state.snapshots.restore(COMMAND, box, standing(box), snapshot));
  assert.equal(refused.code, "no_capacity");
  assert.equal(refused.message, `BB Box did not restore box ${box.name}: ${person} BB Box changed nothing.`);
  assert.equal(refused.agentMessage, `BB Box did not restore box ${box.name}: ${agent} BB Box changed nothing.`);
  assert.deepEqual(cards.events, [`hold ${box.guest!.ref}`], "nothing was stopped, cleared or kept");
  assert.equal(cards.claims.get(box.guest!.ref)?.card, CARD_B);
  assert.equal((await current(state, box)).state, "ready");
});

test("071 unit 6, Fable 5: a restart between the rollback and the re-tag, and one at claim-kept, finish on the box's own card; a card taken meanwhile leaves the box stopped, never moved", async () => {
  {
    const { state, cards, box, snapshot } = await onCardB();
    const ref = box.guest!.ref;
    await heldAt(state, cards, box, snapshot, "rolled-back");
    assert.equal(cards.lines.get(ref), CARD_A, "the crash left the snapshot's lines");
    assert.equal(cards.claims.get(ref)?.card, CARD_B, "and the claim of record on the box's card");
    cards.events.length = 0;
    assert.equal(await state.snapshots.recover(), 1);
    assert.deepEqual(cards.events, [`keep ${ref}`, `hold ${ref}`, `start ${ref} on ${CARD_B}`]);
    assert.equal((await current(state, box)).state, "ready");
  }
  {
    const { state, cards, box, snapshot } = await onCardB();
    const ref = box.guest!.ref;
    await heldAt(state, cards, box, snapshot, "claim-kept");
    assert.equal(cards.lines.get(ref), CARD_B, "claim-kept wrote the claim back");
    cards.taken.set(CARD_B, 1);
    cards.events.length = 0;
    assert.equal(await state.snapshots.recover(), 1);
    assert.deepEqual(cards.events, [`hold ${ref}`], "no keep again, and no start");
    const after = await current(state, box);
    assert.equal(after.state, "stopped");
    assert.match(after.error ?? "", /cannot take it now: .* BB Box does not move it to another one/);
    assert.equal(cards.claims.get(ref)?.card, CARD_B, "the box keeps its claim, and is not moved");
    assert.equal(state.store.operations({ box: box.id, kind: "restore" })[0]!.state, "failed");
  }
});

async function swapOnCardB(): Promise<{ state: World; cards: FakeCards; box: BoxRecord; undo: string; old: string }> {
  const state = armedWorld();
  state.undoByCopy = true;
  const cards = new FakeCards();
  cards.attach(state);
  const box = await readyBox(state);
  cards.give(box.guest!.ref, "shared", CARD_B);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  cards.snapshotLines.set(taken.id, CARD_B);
  const first = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  const now = await current(state, box);
  cards.copyLines = CARD_A;
  cards.events.length = 0;
  return { state, cards, box: now, undo: first.undo!.id, old: now.guest!.ref };
}

test("071 unit 6, Astra 1 and Fable 5: a swap clears the old guest's claim, keeps the new guest from starting at boot until it has the box's claim, and starts it on the box's card", async () => {
  const { state, cards, box, undo, old } = await swapOnCardB();
  await state.snapshots.restore(COMMAND, box, standing(box), undo);
  const fresh = (await current(state, box)).guest!.ref;
  assert.notEqual(fresh, old);
  assert.deepEqual(cards.seenAtArm, { onboot: false, lines: CARD_A }, "made from a held copy with another card's lines, it was not set to start at boot");
  assert.deepEqual(cards.events, [`hold ${old}`, `stop ${old}`, `release ${old}`, `adopt ${fresh}`, `arm ${fresh}`, `hold ${fresh}`, `start ${fresh} on ${CARD_B}`]);
  assert.equal(cards.onboot.get(fresh), true);
  assert.equal(cards.claims.get(old)?.part, "none");
  assert.deepEqual(cards.holdersOf(CARD_B), [fresh]);
  assert.deepEqual(cards.holdersOf(CARD_A), []);
});

test("071 unit 6, Fable 5: a swap cut short at claim-cleared, after its new guest is made, or at claim-given leaves no card with two claims, and recovery finishes it on the box's card", async () => {
  for (const step of ["claim-cleared", "adopted", "claim-given"] as const) {
    const { state, cards, box, undo, old } = await swapOnCardB();
    await heldAt(state, cards, box, undo, step);
    assert.ok(cards.holdersOf(CARD_B).length <= 1, `at ${step}, at most one guest holds the card: ${cards.holdersOf(CARD_B).join(", ")}`);
    assert.equal(cards.claims.get(old)?.part, "none", `at ${step}, the old guest's claim is cleared`);
    assert.equal(cards.onboot.get(old), false, `at ${step}, the old guest does not start with the node`);
    cards.events.length = 0;
    assert.equal(await state.snapshots.recover(), 1, step);
    const after = await current(state, box);
    const fresh = after.guest!.ref;
    assert.equal(after.state, "ready", `${step}: ${after.error ?? ""}`);
    assert.notEqual(fresh, old);
    assert.deepEqual(cards.holdersOf(CARD_B), [fresh], step);
    assert.equal(cards.onboot.get(fresh), true, step);
    assert.equal(cards.events.at(-1), `start ${fresh} on ${CARD_B}`, step);
    assert.ok(!cards.events.some((event) => event.startsWith("moved")), step);
  }
});

test("071 unit 6, Astra 4 and Fable 2: a swap whose new guest cannot be made gives the old guest its claim back, confirmed, before it starts it again; when that fails the box stays stopped and the next sweep tries again", async () => {
  {
    const { state, cards, box, undo, old } = await swapOnCardB();
    cards.failing.add("adopt");
    const failed = await rejection(state.snapshots.restore(COMMAND, box, standing(box), undo));
    assert.match(failed.message, /Every VMID from 3240 to 3244 is in use\. Nothing on its disk changed, and BB Box started box \S+ again as it was\./);
    assert.deepEqual(cards.events, [`hold ${old}`, `stop ${old}`, `release ${old}`, `return ${old}`, `hold ${old}`, `start ${old} on ${CARD_B}`]);
    assert.deepEqual(cards.holdersOf(CARD_B), [old]);
    assert.equal(cards.bootAtStart.get(old), true, "it starts with the node again, as before the swap, once its claim is back");
  }
  {
    const { state, cards, box, undo, old } = await swapOnCardB();
    cards.failing.add("adopt");
    cards.failing.add("return");
    const unsure = await rejection(state.snapshots.restore(COMMAND, box, standing(box), undo));
    assert.equal(unsure.code, "unreachable");
    assert.match(unsure.message, /could not give its GPU claim back to its old guest \S+: the host's GPU helper did not answer the return within 10 s\. It stays stopped, as it would start with no card, and BB Box tries again at its next sweep\./);
    assert.ok(!cards.events.some((event) => event.startsWith("start")), "the old guest, with no card, was not started");
    assert.equal(cards.onboot.get(old), false, "nor does it start with the node");
    const stopped = await current(state, box);
    assert.equal(stopped.state, "stopped");
    assert.ok(stopped.restoring, "the box stays held by the restore, so nothing else starts it");
    const operation = state.store.operations({ box: box.id, kind: "restore" }).find((each) => each.state === "unknown")!;
    assert.equal(operation.step, "claim-back");
    await state.restart();
    cards.restarted(state);
    cards.events.length = 0;
    assert.equal(await state.snapshots.recover(), 1);
    assert.deepEqual(cards.events, [`return ${old}`, `hold ${old}`, `start ${old} on ${CARD_B}`]);
    assert.equal(cards.bootAtStart.get(old), true);
    assert.equal((await current(state, box)).state, "ready");
    assert.equal(state.store.operation(operation.id)!.state, "failed");
  }
});

test("071 unit 6, Fable 3: a restore and a swap of a box with no GPU claim never ask the backend to hold, keep, clear or give a card", async () => {
  const state = armedWorld();
  state.undoByCopy = true;
  const cards = new FakeCards();
  cards.attach(state);
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  const first = await state.snapshots.restore(COMMAND, box, standing(box), "one");
  await state.snapshots.restore(COMMAND, await current(state, box), standing(box), first.undo!.id);
  const fresh = (await current(state, box)).guest!.ref;
  assert.deepEqual(cards.events.filter((event) => !/^(stop|rollback|start|adopt) /.test(event)), [`arm ${fresh}`], "only the new guest is armed, with no claim");
  assert.equal(cards.onboot.get(fresh), true);
});

test("071 unit 6, Fable 4: a fork with gpu shared of a box that is not a linux-desktop, or on a backend that gives forks no GPU, is refused before any record is made", async () => {
  const state = armedWorld();
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const records = state.store.records().length;
  const checked = await rejection(state.snapshots.checkFork(COMMAND, box, standing(box), "set up", { gpu: "shared" }));
  assert.equal(checked.code, "unsupported");
  assert.match(checked.message, /^Not forked: a fork of a linux box takes gpu none, as only a linux-desktop fork may have a card now\. Fork it with gpu none\. BB Box copied nothing\.$/);
  const forked = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "set up", { gpu: "shared" }));
  assert.match(forked.message, /a fork of a linux box takes gpu none/);
  const whole = await rejection(state.snapshots.checkFork(COMMAND, box, standing(box), "set up", { gpu: "whole" }));
  assert.equal(whole.message, "Not forked: a fork of a linux box takes gpu none, as only a linux-desktop fork may have a card now. Fork it with gpu none. BB Box copied nothing.", "a whole card is refused as a shared one is, for the kind, not as not offered");
  assert.equal(state.store.records().length, records);
  assert.equal(state.store.operations({ box: box.id, kind: "fork" }).length, 0);
  assert.equal((await state.boxes.list(THREAD)).length, 1, "no fork's box record was made");
  const none = await state.snapshots.checkFork(COMMAND, box, standing(box), "set up", { gpu: "none" });
  assert.equal(none.offersGpu, false);
});

test("071 unit 6 round 2, Astra 2 and Fable 1: a swap cut short after its old guest's claim was cleared, but before the step was recorded, still gives the claim and the start at boot back when it puts the old guest back", async () => {
  const { state, cards, box, undo, old } = await swapOnCardB();
  cards.hangingAfter.add("release");
  const swapping = state.snapshots.restore(COMMAND, box, standing(box), undo).catch((error: unknown) => error);
  const deadline = Date.now() + 30_000;
  while (cards.claims.get(old)?.part !== "none") {
    assert.ok(Date.now() < deadline, "the old guest's claim was never cleared");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const operation = state.store.unsettled().find((each) => each.kind === "restore")!;
  assert.equal(operation.step, "copy-ready", "the clear is not recorded as a step yet");
  assert.equal(cards.onboot.get(old), false);
  await state.restart();
  await swapping;
  cards.restarted(state);
  const copy = state.store.record(operation.undo!)!.livesOn.ref;
  state.provider.copies.delete(copy);
  cards.events.length = 0;
  assert.equal(await state.snapshots.recover(), 1);
  assert.deepEqual(cards.events, [`return ${old}`, `hold ${old}`, `start ${old} on ${CARD_B}`], "its undo went, so it is put back, with its claim");
  assert.equal(cards.bootAtStart.get(old), true);
  assert.deepEqual(cards.holdersOf(CARD_B), [old]);
  assert.equal((await current(state, box)).state, "ready");
});
