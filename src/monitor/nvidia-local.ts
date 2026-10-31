import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { NVIDIA_CARD_ARGS, NVIDIA_DEVICE, NVIDIA_PROCESS_ARGS, NVIDIA_QUERY_SECONDS, gpuReadingOf, parseNvidiaCards, parseNvidiaProcesses, type GpuReading } from "./nvidia.ts";

const BACK_OFF_MS = 5 * 60_000;

let quietUntil = 0;

async function deviceThere(device: string): Promise<boolean> {
  if (platform() === "win32") return true;
  if (platform() !== "linux") return false;
  return access(device).then(() => true, () => false);
}

export interface NvidiaHere {
  readonly inContainer: boolean;
  readonly processes: boolean;
  readonly device?: string;
  readonly timeoutMs?: number;
}

type Answer = { readonly is: "output"; readonly stdout: string; readonly exited: boolean } | { readonly is: "missing" } | { readonly is: "stuck" };

function query(args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const child = execFile("nvidia-smi", [...args], { maxBuffer: 256 * 1024, signal, windowsHide: true, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") settle({ is: "missing" });
      else settle({ is: "output", stdout: typeof stdout === "string" ? stdout : "", exited: error === null });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ is: "stuck" });
    }, timeoutMs);
    timer.unref?.();
  });
}

function quieten(): null {
  quietUntil = Date.now() + BACK_OFF_MS;
  return null;
}

export function forgetQuietNvidia(): void {
  quietUntil = 0;
}

export async function readNvidiaHere(signal: AbortSignal, { inContainer, processes, device = NVIDIA_DEVICE, timeoutMs = NVIDIA_QUERY_SECONDS * 1000 }: NvidiaHere): Promise<GpuReading | null> {
  if (Date.now() < quietUntil || !(await deviceThere(device))) return null;
  const cardsAnswer = await query(NVIDIA_CARD_ARGS, signal, timeoutMs);
  if (cardsAnswer.is !== "output") return quieten();
  const cards = parseNvidiaCards(cardsAnswer.stdout);
  if (!cards) return null;
  if (!processes && !inContainer) return gpuReadingOf(cards, null, inContainer);
  const processAnswer = await query(NVIDIA_PROCESS_ARGS, signal, timeoutMs);
  if (processAnswer.is === "stuck") quieten();
  return gpuReadingOf(cards, processAnswer.is === "output" && processAnswer.exited ? parseNvidiaProcesses(processAnswer.stdout) : null, inContainer);
}
