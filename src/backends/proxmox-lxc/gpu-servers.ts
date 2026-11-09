import { recordInDescription } from "../images.ts";
import type { GpuPart } from "../types.ts";
import { PRODUCT } from "../../brand.ts";


export { CARD_CHECK_COMMAND, CHECK_DONE, DESKTOP_GPU_MIB, SERVER_GPU_MIB, cardFactWords, judgeCardCheck, memoryWords, wrongCardSeen, type CardCheck, type CardReading, type SeenCard } from "../card-check.ts";

export const CARD_CHECK_EVERY_MS = 10 * 60_000;

export function helperMismatches(notes: string): { readonly vmid: number; readonly card: string | null }[] {
  return [...notes.matchAll(/^\s*mismatch (\d+) (\S+)\s*$/gm)].map(([, vmid, card]) => ({ vmid: Number(vmid), card: card === "none" ? null : card!.toLowerCase().replace(/^gpu-/, "") }));
}

export function templateUserspace(config: Readonly<Record<string, unknown>>): string | null {
  return recordInDescription(String(config.description ?? ""))?.nvidia ?? null;
}

export interface Refusal {
  readonly person: string;
  readonly agent: string;
}

export function serverRefusal(node: string, why: string, personFix: string): Refusal {
  return {
    person: `${node} cannot give a server a shared GPU now: ${why}. ${personFix}`,
    agent: `Not made: ${node} cannot give a server a shared GPU now: ${why}. Ask for gpu none, or ask the user. ${PRODUCT} changed nothing.`,
  };
}

export function wholeRefusal(node: string, why: string, personFix: string): Refusal {
  return {
    person: `${node} cannot give a box a whole card now: ${why}. ${personFix}`,
    agent: `Not made: ${node} cannot give a box a whole card now: ${why}. Ask for gpu shared, or ask the user. ${PRODUCT} changed nothing.`,
  };
}
