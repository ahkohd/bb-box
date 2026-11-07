import type { GpuPart } from "./types.ts";

export const SERVER_GPU_MIB = 1024;

export const DESKTOP_GPU_MIB = 384;

export const BOXES_PER_CARD = 4;

export const MOST_GPU_MEMORY_MIB = 1_048_576;

const CUDA_INIT = `python3 -c 'import ctypes; print(ctypes.CDLL("libcuda.so.1").cuInit(0))'`;

export const CHECK_DONE = "card check done";

export const CARD_CHECK_COMMAND =
  "nvidia-smi --query-gpu=uuid,name,memory.total --format=csv,noheader,nounits 2>&1 | head -8; " +
  `if command -v python3 >/dev/null 2>&1; then printf 'cuinit %s\\n' "$(${CUDA_INIT} 2>&1 | tail -1)"; else echo 'cuinit no-python'; fi; ` +
  "printf 'userspace %s\\n' \"$(cat /usr/share/bb-box/nvidia-version 2>/dev/null || echo none)\"; " +
  `echo '${CHECK_DONE}'`;

export interface SeenCard {
  readonly uuid: string;
  readonly model: string;
  readonly memoryMiB: number | null;
}

export type CardReading = "cards" | "none" | "unreadable" | "incomplete";

export type CardCheck =
  | { readonly ok: true; readonly card: SeenCard }
  | {
      readonly ok: false;
      readonly why: string;
      readonly seen: readonly string[];
      readonly userspace: string | null;
      readonly reading: CardReading;
      readonly userspaceOff: boolean;
    };

function uuidOf(value: string): string | null {
  const match = /^GPU-([0-9a-f-]{36})$/i.exec(value.split(",")[0]!.trim());
  return match ? match[1]!.toLowerCase() : null;
}

function seenCards(lines: readonly string[]): SeenCard[] {
  return lines.flatMap((line) => {
    const [uuid = "", model = "", memory = ""] = line.split(",").map((part) => part.trim());
    const card = uuidOf(uuid);
    return card ? [{ uuid: card, model, memoryMiB: /^\d+$/.test(memory) ? Number(memory) : null }] : [];
  });
}

function listedWords(seen: readonly string[]): string {
  if (!seen.length) return "no card";
  return seen.length === 1 ? `card ${seen[0]}` : `cards ${seen.join(" and ")}`;
}

function valueAfter(lines: readonly string[], key: string): string | null {
  const line = lines.find((candidate) => candidate === key || candidate.startsWith(`${key} `));
  return line === undefined ? null : line.slice(key.length).trim();
}

export function judgeCardCheck(output: string, card: string, hostDriver: string | null): CardCheck {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const cuinit = valueAfter(lines, "cuinit");
  const userspaceLine = valueAfter(lines, "userspace");
  const userspace = userspaceLine === null || userspaceLine === "none" ? null : userspaceLine;
  const smi = lines.filter((line) => valueAfter([line], "cuinit") === null && valueAfter([line], "userspace") === null && line !== CHECK_DONE);
  const cards = seenCards(smi);
  const seen = cards.map((listed) => listed.uuid);
  const mine = cards.find((listed) => listed.uuid === card);
  const reading: CardReading = cards.length ? "cards" : smi.some((line) => /^No devices were found/.test(line)) ? "none" : "unreadable";
  const failed = (why: string, as: CardReading = reading, userspaceOff = false): CardCheck => ({ ok: false, why, seen, userspace, reading: as, userspaceOff });
  if (!lines.includes(CHECK_DONE) || cuinit === null) return failed("the check in it did not finish", "incomplete");
  if (!mine) {
    if (!cards.length && userspace && hostDriver && userspace !== hostDriver) {
      return failed(`nvidia-smi in it fails: its NVIDIA userspace is ${userspace} and the host's driver ${hostDriver}`, reading, true);
    }
    const said = cards.length ? "" : smi[0] ? ` (${smi[0].replace(/\.$/, "")})` : "";
    return failed(`nvidia-smi in it listed ${listedWords(seen)}, not its card ${card}${said}`);
  }
  if (cuinit === "no-python" || cuinit === "0") return { ok: true, card: mine };
  if (/^-?\d+$/.test(cuinit)) return failed(`CUDA's driver did not initialise in it: cuInit returned ${cuinit}`);
  return failed(`CUDA's driver did not load in it: ${cuinit || "Python gave no answer"}`);
}

export function wrongCardSeen(check: CardCheck, card: string): boolean {
  return !check.ok && !check.userspaceOff && (check.reading === "cards" || check.reading === "none") && !check.seen.includes(card);
}

export function memoryWords(memoryMiB: number | null): string | null {
  if (memoryMiB === null) return null;
  return `${Math.round(memoryMiB / 1024)} GiB`;
}

export function cardFactWords(part: GpuPart, index: number | null, seen: SeenCard | null): string {
  const named = index === null ? "a card" : `card ${index}`;
  return [named, part, ...(seen?.model ? [seen.model] : []), ...(seen && memoryWords(seen.memoryMiB) ? [memoryWords(seen.memoryMiB)!] : [])].join(", ");
}

