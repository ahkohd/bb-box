// The doctor's check that a host holds boxes of the kinds it offers at
// their sizes (#74). A host too small for a kind's default size takes a box
// of the kind only at a smaller size asked for, and one too small for every
// preset only at a custom size, so the doctor warns and says which fit.

import type { CheckId } from "../core/checks.ts";
import { describeSize, fits, formatMiB } from "../core/sizes.ts";
import type { MachineSize, DoctorCheck, KindSettings } from "./types.ts";

/** A kind a host offers, and the largest box of it the host holds while it runs nothing else. */
import { PRODUCT } from "../brand.ts";
export interface KindRoom {
  readonly kind: string;
  readonly settings: KindSettings;
  readonly largest: MachineSize;
}

export interface HostRoom {
  readonly id: CheckId;
  readonly name: string;
  /** The host as the doctor names it. */
  readonly host: string;
  /** What it has, for example "8 cores and 16 GiB memory". */
  readonly has: string;
  /** The memory it keeps free for itself, in MiB. */
  readonly keepsMiB: number;
  readonly kinds: readonly KindRoom[];
}

/**
 * Whether the host holds a box of each kind it offers that is on at the
 * kind's default size, and if not, at which presets it does. Null when it
 * offers no kind that is on.
 */
export function sizesCheck(room: HostRoom): DoctorCheck | null {
  const { id, name, host } = room;
  const on = room.kinds.filter((kind) => kind.settings.enabled);
  if (!on.length) return null;
  const short = on.filter(({ settings, largest }) => !fits(settings.defaultSize, largest));
  if (!short.length) {
    return { id, name, status: "ok", detail: `${host} holds ${list(on.map((kind) => kind.kind), "and")} boxes at the default size${on.length === 1 ? "" : "s"}.`, fix: null };
  }
  const found = short.map(({ kind, settings, largest }) => {
    const held = settings.presets.filter((size) => fits(size, largest));
    return held.length
      ? `It cannot hold a ${kind} box at its default size, ${describeSize(settings.defaultSize)}, only at ${list(held.map(describeSize), "or")}.`
      : `It cannot hold a ${kind} box at any of its presets, the smallest ${describeSize(settings.presets[0]!)}.`;
  });
  const binds = (part: (size: MachineSize) => number | null) =>
    short.some(({ settings, largest }) => (part(settings.defaultSize) ?? 0) > (part(largest) ?? Infinity));
  const more = [
    ...(binds((size) => size.cores) ? ["cores"] : []),
    ...(binds((size) => size.memoryMiB) ? ["memory"] : []),
    ...(binds((size) => size.diskGiB) ? ["disk"] : []),
  ];
  const keeps = room.keepsMiB ? `, and keeps ${formatMiB(room.keepsMiB)} free` : "";
  const lower = room.keepsMiB && more.includes("memory") ? ", lower the memory kept free" : "";
  return {
    id,
    name,
    status: "warn",
    detail: `${host} has ${room.has}${keeps}. ${found.join(" ")}`,
    fix: `Give ${host} more ${list(more, "and")}${lower}, or make the presets of ${list(short.map((kind) => kind.kind), "and")} smaller in ${PRODUCT}'s settings, under Kinds.`,
  };
}

/** For example "a, b and c". */
function list(items: readonly string[], last: "and" | "or"): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}
