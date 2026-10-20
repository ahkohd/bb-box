// A guest's CPU weight while bb-box makes it and it starts (#888). A large
// box's first boot, as Windows' with its disk grown, took several cores while
// a busy host's running boxes stalled. So a new guest has a tenth of the
// default weight until it is ready, and warm and spare guests keep it until a
// box takes one. A weight only shares a CPU that two want: on a host with
// room, the guest is as fast (measured 20 October 2026). Proxmox applies
// cpuunits to the running guest's cgroup at once, VM or container.
//
// The tag marks the guests bb-box lowered, so only those go back, and a
// weight set by hand, or by the template, is never touched. The sweep puts
// back a ready box's guest that is still marked, as after a bb-box restart.

import type { GuestSettings, Proxmox } from "./api.ts";
import { parseTags } from "./api.ts";

/** The CPU weight while starting: a tenth of Proxmox's default, 100. */
export const START_CPUUNITS = 10;
/** On a guest whose weight bb-box lowered, until it is put back. */
export const START_TAG = "bb-box-starting";

/**
 * Whether bb-box lowers the guest's weight now, or did before, from its config: when it sets no weight of its own, or
 * the one bb-box gave it, with the tag.
 */
export function startsLow(config: Record<string, unknown>): boolean {
  if (config.cpuunits === undefined || config.cpuunits === null || config.cpuunits === "") return true;
  return Number(config.cpuunits) === START_CPUUNITS && parseTags(config.tags).includes(START_TAG);
}

/** The settings that lower the weight, for a guest that startsLow. */
export const LOW: GuestSettings = { cpuunits: START_CPUUNITS };

/** `tags` with the start tag where `starting`, and without it otherwise. */
export function withStartTag(tags: readonly string[], starting: boolean): string[] {
  const rest = tags.filter((tag) => tag !== START_TAG);
  return starting ? [...rest, START_TAG] : rest;
}

/**
 * Puts the weight of `vmid` back once it is ready: unset, as the default, where bb-box set it and nobody has changed it
 * since; and drops the tag. A guest without the tag is left as it is.
 */
export async function settle(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<void> {
  const config = await api.config(vmid, signal);
  const tags = parseTags(config.tags);
  if (!tags.includes(START_TAG)) return;
  if (Number(config.cpuunits) === START_CPUUNITS) await api.configure(vmid, { delete: ["cpuunits"] }, signal);
  await api.configure(vmid, { tags: withStartTag(tags, false) }, signal);
}
