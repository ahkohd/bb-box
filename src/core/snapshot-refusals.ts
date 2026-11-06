import type { GpuPart } from "../backends/types.ts";

export function capacityReason(words: string): string {
  const reason = words.replace(/(?:^|\s)(?:Release|Use|Ask|Free|Lower|Raise|Widen|Change)\b[\s\S]*$/, "").trim();
  return reason ? /[.!?]$/.test(reason) ? reason : `${reason}.` : "There is no room now.";
}

function forkInstead(gpu: GpuPart): string {
  if (gpu === "none") return "Try again later, or ask the user.";
  return gpu === "whole" ? "Fork it with gpu shared or none, or ask the user." : "Fork it with gpu none, or ask the user.";
}

export function forkRefusalWords(reason: string, gpu: GpuPart): string {
  const sentence = reason.trim();
  return `Not forked: ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`} ${forkInstead(gpu)} bb-box copied nothing.`;
}

export function forkCapacityWords(words: string, gpu: GpuPart): string {
  return forkRefusalWords(capacityReason(words), gpu);
}
