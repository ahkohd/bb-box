import type { GpuPart } from "../backends/types.ts";

export function capacityReason(words: string): string {
  const reason = words.replace(/(?:^|\s)(?:Release|Use|Ask|Free|Lower|Raise|Widen|Change)\b[\s\S]*$/, "").trim();
  return reason ? /[.!?]$/.test(reason) ? reason : `${reason}.` : "There is no room now.";
}

export function forkCapacityWords(words: string, gpu: GpuPart): string {
  const next = gpu === "none" ? "Try again later, or ask the user." : "Fork it with gpu none, or ask the user.";
  return `Not forked: ${capacityReason(words)} ${next} bb-box copied nothing.`;
}
