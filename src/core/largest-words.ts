import { KIND_INFO, kindInfo } from "../backends/kinds.ts";

export type LargestPart = "cores" | "memory" | "disk";

export const RAISE_LARGEST = "To allow more, raise";

const LARGEST_FLAGS: Readonly<Record<LargestPart, string>> = {
  cores: "--largest-cores <cores>",
  memory: "--largest-memory-gib <GiB>",
  disk: "--largest-disk-gib <GiB>",
};

export function kindNameInSettings(kind: string): string {
  const info = kindInfo(kind);
  const twins = Object.values(KIND_INFO).filter((other) => other.label === info.label);
  return twins.length < 2 ? info.label : `${info.label} (${info.gpu ? "GPU" : "CPU"})`;
}

export function raiseLargestWords(kind: string, over: readonly LargestPart[]): string {
  const flags = (over.length ? over : (["cores", "memory", "disk"] as const)).map((part) => LARGEST_FLAGS[part]).join(" ");
  return `${RAISE_LARGEST} the kind's largest size in BB Box settings, under Kinds, ${kindNameInSettings(kind)}, Sizes, or run bb box kind set ${kind} ${flags}.`;
}

export function withoutRaiseLargest(text: string): string {
  const at = text.indexOf(` ${RAISE_LARGEST} `);
  return at < 0 ? text : text.slice(0, at);
}
