import type { BoxRecord } from "./boxes.ts";
import type { DoctorCheck } from "../backends/types.ts";
import { PRODUCT } from "../brand.ts";


export type JoinProblem = "dns-timeout" | "dns" | "refused" | "unroutable" | "timeout" | "reset" | "slow";

export interface JoinTries {
  readonly failed: number;
  readonly next: number | null;
  readonly words: string;
  readonly problem: JoinProblem | null;
  readonly setup: boolean;
  readonly machine: string | null;
  readonly since?: number;
}

export type BackendVerdict = "others joined" | "none can reach" | "unknown";

export const JOIN_TRIES = 5;
export const JOIN_WAITS_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
export const JOIN_EVERY_MS = 30 * 60_000;
export const JOIN_GIVE_UP_MS = 24 * 60 * 60_000;

interface ProblemShape {
  readonly problem: JoinProblem;
  readonly matches: RegExp;
  readonly words: string;
}

const PROBLEMS: readonly ProblemShape[] = [
  { problem: "dns-timeout", matches: /Resolving timed out|EAI_AGAIN|Temporary failure in name resolution/i, words: "This box could not look up BB's address in time" },
  { problem: "dns", matches: /curl: \(6\)|Could not resolve host|ENOTFOUND|Name or service not known/i, words: "This box's DNS lookup found no address for BB" },
  { problem: "refused", matches: /Connection refused|ECONNREFUSED/i, words: "This box found BB's address, but nothing there accepted the connection: it was refused" },
  { problem: "unroutable", matches: /No route to host|Network is unreachable|EHOSTUNREACH|ENETUNREACH|Couldn't connect to server/i, words: "This box has no network route to BB's address" },
  { problem: "reset", matches: /Connection reset|ECONNRESET|Empty reply from server|Recv failure|curl: \((52|56)\)/i, words: "The connection from this box to BB was cut off before BB answered" },
  { problem: "timeout", matches: /curl: \(28\)|Connection timed out|Timeout was reached|Operation timed out|ETIMEDOUT|curl: \(7\)/i, words: "This box could not reach BB's address in time: the connection timed out" },
  { problem: "slow", matches: /BB did not finish adding the box as a machine within/i, words: "" },
];

const PROBLEM_LINE = /curl: \(\d+\)[^\n]*/;
const MOST_DETAIL_CHARACTERS = 200;

export interface FoundProblem {
  readonly problem: JoinProblem;
  readonly sentence: string;
}

function detailOf(text: string, matches: RegExp): string {
  const curl = text.match(PROBLEM_LINE)?.[0];
  if (curl) return curl.trim().replace(/\.$/, "");
  const line = text.split("\n").find((each) => matches.test(each)) ?? text;
  return line.trim().replace(/\.$/, "").slice(0, MOST_DETAIL_CHARACTERS);
}

export function joinProblem(text: string): FoundProblem | null {
  const shape = PROBLEMS.find((each) => each.matches.test(text));
  if (!shape) return null;
  if (!shape.words) return { problem: shape.problem, sentence: sentence(detailOf(text, shape.matches)) };
  const plain = `${shape.words} (`;
  const plainEnd = text.startsWith(plain) ? text.indexOf(").", plain.length) : -1;
  if (plainEnd >= 0) return { problem: shape.problem, sentence: text.slice(0, plainEnd + 2) };
  return { problem: shape.problem, sentence: `${shape.words} (${detailOf(text, shape.matches)}).` };
}

export function plainJoinFailure(text: string): string {
  return joinProblem(text)?.sentence ?? text;
}

export function reachesBb(problem: JoinProblem): boolean {
  return problem !== "slow";
}

function clearlySetup(problem: JoinProblem): boolean {
  return problem === "refused" || problem === "unroutable";
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function firstTry(box: BoxRecord): boolean {
  return box.enrol.state === "enrolling" && !box.joinTries;
}

function cannotReach(box: BoxRecord): boolean {
  return !!box.joinTries?.problem && reachesBb(box.joinTries.problem) && (box.enrol.state === "failed" || box.enrol.state === "enrolling");
}

export function backendVerdict(box: BoxRecord, all: readonly BoxRecord[]): BackendVerdict {
  const peers = all.filter((other) => other.id !== box.id && other.backend === box.backend && other.state === "ready" && other.role !== "machine");
  if (peers.some((peer) => peer.enrol.state === "enrolled")) return "others joined";
  if (peers.some(firstTry)) return "unknown";
  return peers.every((peer) => cannotReach(peer) || peer.enrol.state === "off" || (peer.enrol.state === "failed" && !peer.joinTries)) ? "none can reach" : "unknown";
}

export interface NextTry {
  readonly gaveUp: boolean;
  readonly next: number | null;
  readonly setup: boolean;
}

export function nextTry(input: { readonly failed: number; readonly problem: JoinProblem; readonly verdict: BackendVerdict; readonly now: number; readonly since: number; readonly waits?: readonly number[] }): NextTry {
  const everyBox = reachesBb(input.problem) && input.verdict === "none can reach";
  const gaveUp = input.failed >= JOIN_TRIES || (everyBox && clearlySetup(input.problem));
  const waits = input.waits ?? JOIN_WAITS_MS;
  const wait = gaveUp ? (waits.at(-1) ?? JOIN_EVERY_MS) : (waits[input.failed - 1] ?? waits.at(-1) ?? JOIN_EVERY_MS);
  const next = input.now + wait;
  return { gaveUp, next: gaveUp && next - input.since > JOIN_GIVE_UP_MS ? null : next, setup: gaveUp && everyBox };
}

function tries(count: number): string {
  return count === 1 ? "1 try" : `${count} tries`;
}

export function gaveUpWords(input: { readonly sentence: string; readonly failed: number; readonly verdict: BackendVerdict; readonly backendLabel: string; readonly setup: boolean; readonly stopped: boolean }): string {
  const after = `It failed ${tries(input.failed)}.`;
  const blame = input.setup
    ? `No box on ${input.backendLabel} can reach BB, so BB's address is likely one its boxes cannot reach: turn the tailnet on in BB Box's settings, or give BB a URL its boxes can reach (docs/guide/tailnet.md).`
    : input.verdict === "others joined"
      ? `Other boxes on ${input.backendLabel} joined BB, so BB's setup is fine: the fault is in this box's network.`
      : "";
  const next = input.stopped
    ? `${PRODUCT} gave up after ${JOIN_GIVE_UP_MS / 3_600_000} hours of tries; Join BB again starts a new round.`
    : `${PRODUCT} tries again every ${JOIN_EVERY_MS / 60_000} minutes for up to ${JOIN_GIVE_UP_MS / 3_600_000} hours; Join BB again tries at once.`;
  return [input.sentence, after, blame, next].filter(Boolean).join(" ");
}

export function failedBeforeTries(box: BoxRecord): boolean {
  return box.state === "ready" && box.role !== "machine" && box.capabilities.enrol && box.enrol.state === "failed" && !box.joinTries && joinProblem(box.enrol.error ?? "") !== null;
}

export function waitingToJoin(box: BoxRecord): boolean {
  return !!box.joinTries && box.joinTries.next !== null && ((box.enrol.state === "enrolling" && !box.enrol.hostId) || box.enrol.state === "failed");
}

export function dueToJoin(box: BoxRecord, now: number): boolean {
  return box.state === "ready" && waitingToJoin(box) && box.joinTries!.next! <= now;
}

export function tryWords(failed: number): string {
  return failed < JOIN_TRIES ? `try ${failed + 1} of ${JOIN_TRIES}` : `try ${failed + 1}`;
}

export function waitWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.round(seconds / 60);
  return seconds < 60 ? `${seconds} s` : minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function joiningWords(tries: Pick<JoinTries, "failed" | "next" | "words">, now: number): string {
  const step =
    tries.next === null
      ? `joining BB, ${tryWords(tries.failed)}`
      : tries.next <= now
        ? `joining BB: ${tryWords(tries.failed)} starts now`
        : `joining BB: ${tryWords(tries.failed)} starts in ${waitWords(tries.next - now)}`;
  return tries.failed > 0 && tries.words ? `${step}. Try ${tries.failed} failed: ${tries.words.replace(/\.$/, "")}` : step;
}

export function joinChecks(boxes: readonly BoxRecord[], now: number): DoctorCheck[] {
  return boxes.flatMap((box): DoctorCheck[] => {
    const tries = box.joinTries;
    if (box.state !== "ready" || !tries || (box.enrol.state !== "enrolling" && box.enrol.state !== "failed")) return [];
    const name = `${box.name} joining BB`;
    if (box.enrol.state === "enrolling") {
      return [{ id: `join.${box.name}`, name, status: "warn", detail: `Box ${box.name} on ${box.backendLabel} is ${joiningWords(tries, now)}.`, fix: `${PRODUCT} tries again by itself. Join BB again on the box's page, or bb box enrol, tries at once.` }];
    }
    return [
      tries.setup
        ? { id: `join.${box.name}`, name, status: "fail", detail: box.enrol.error ?? tries.words, fix: "Turn the tailnet on in BB Box's settings, or give BB a URL its boxes can reach. Then Join BB again on the box's page tries at once." }
        : { id: `join.${box.name}`, name, status: "warn", detail: box.enrol.error ?? tries.words, fix: "Look at the box's network and DNS, or release it and make another." },
    ];
  });
}
