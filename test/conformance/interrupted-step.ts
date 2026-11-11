import type { Backend, BackendStorage, BoxIdentity, Guest, SnapshotRef, SnapshotTake, TaskRef } from "../../src/backends/types.ts";
import { FileStorage } from "./file-storage.ts";

export interface MakesBackendElsewhere {
  readonly create: (storage: BackendStorage, installId: string, args: readonly string[]) => Backend | Promise<Backend>;
}

export type InterruptedStep =
  | { readonly step: "take"; readonly guest: Guest; readonly take: SnapshotTake }
  | { readonly step: "restore"; readonly guest: Guest; readonly ref: SnapshotRef; readonly box: BoxIdentity };

export interface InterruptedStepInput {
  readonly module: string;
  readonly args: readonly string[];
  readonly storage: string;
  readonly installId: string;
  readonly run: InterruptedStep;
}

export type StepEvent = { readonly task: TaskRef } | { readonly claimed: Guest } | { readonly done: true };

function said(event: StepEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runStep(backend: Backend, run: InterruptedStep): Promise<void> {
  const reports = { submitting: async () => {}, task: async (task: TaskRef) => said({ task }) };
  if (run.step === "take") {
    await backend.snapshot!(run.guest, run.take, reports);
    return;
  }
  await backend.powerOff!(run.guest);
  await backend.adoptSnapshot!(run.ref, run.box, { macs: {}, smbios: null }, { ...reports, claimed: async (made) => said({ claimed: made }) });
}

const input = JSON.parse(process.argv[2]!) as InterruptedStepInput;
const maker = (await import(input.module)) as MakesBackendElsewhere;
const backend = await maker.create(new FileStorage(input.storage), input.installId, input.args);
await runStep(backend, input.run);
said({ done: true });
await backend.dispose?.();
