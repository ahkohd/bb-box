import { randomBytes } from "node:crypto";
import type { BackendContext } from "../types.ts";
import { NO_SUCH, type ContainerInfo, type DockerCli } from "./cli.ts";
import type { RestorableSnapshot } from "./snapshot-engine.ts";
import { COPY_FOR, COPY_INTO, COPY_OP, copyIntoName, SNAPSHOT_INSTALL } from "./snapshots.ts";

export const COPY_CREATE_LIMIT_MS = 120_000;
const COPY_RUN_LIMIT_MS = 15 * 60_000;
export const RESTORE_COPY_NOTES = "docker-restore-copy:";
export const REMOVALS_FAILED_BEFORE_DOCTOR_WARNS = 3;

export interface CopyFence {
  readonly op: string;
  readonly volume: string;
  readonly container: string;
  readonly createBy: number;
  readonly failedRemovals?: number;
}

export interface VolumeLeftByACopy {
  readonly volume: string;
  readonly failedRemovals: number;
}

function fenceKey(volume: string): string {
  return `${RESTORE_COPY_NOTES}${volume}`;
}

function copyCreateArgs(snapshot: RestorableSnapshot & { readonly volume: string }, fence: CopyFence, installId: string): readonly string[] {
  return [
    "container", "create", "--name", copyIntoName(fence.volume), "--pull", "never", "--privileged", "--network", "none",
    "--label", `${SNAPSHOT_INSTALL}=${installId}`, "--label", `bbbox.snapshot=${snapshot.id}`,
    "--label", `${COPY_INTO}=${fence.volume}`, "--label", `${COPY_FOR}=${fence.container}`, "--label", `${COPY_OP}=${fence.op}`,
    "--entrypoint", "cp",
    "--volume", `${snapshot.volume}:/from:ro`, "--volume", `${fence.volume}:/to`,
    snapshot.image, "-a", "--reflink=auto", "/from/.", "/to/",
  ];
}

function isGoneAlready(stderr: string): boolean {
  return NO_SUCH.test(stderr) || /already in progress/i.test(stderr);
}

export class RestoreCopies {
  readonly #cli: DockerCli;
  readonly #context: BackendContext;
  readonly #now: () => number;

  constructor(cli: DockerCli, context: BackendContext, now: () => number) {
    this.#cli = cli;
    this.#context = context;
    this.#now = now;
  }

  async copy(snapshot: RestorableSnapshot, into: string, container: string, signal?: AbortSignal): Promise<void> {
    if (!snapshot.volume) return;
    const fence: CopyFence = { op: randomBytes(8).toString("hex"), volume: into, container, createBy: this.#now() + COPY_CREATE_LIMIT_MS };
    await this.#context.storage.set(fenceKey(into), fence);

    const created = await this.#cli.run(copyCreateArgs({ ...snapshot, volume: snapshot.volume }, fence, this.#context.installId), { timeoutMs: COPY_CREATE_LIMIT_MS, signal });
    if (created.exitCode !== 0) throw this.#cli.error("docker container create, for the copy of the snapshot's Docker data", created);
    const id = created.stdout.trim();

    try {
      const ran = await this.#cli.run(["container", "start", "--attach", id], { timeoutMs: COPY_RUN_LIMIT_MS, signal });
      if (ran.exitCode !== 0) throw this.#cli.error("copying the snapshot's Docker data", ran);
    } finally {
      await this.#removeContainer(id);
      await this.#context.storage.delete(fenceKey(into));
    }
  }

  fenceOf(volume: string): Promise<CopyFence | undefined> {
    return this.#context.storage.get<CopyFence>(fenceKey(volume));
  }

  mayStillAppear(fence: CopyFence, removedOps: ReadonlySet<string>): boolean {
    return !removedOps.has(fence.op) && this.#now() < fence.createBy;
  }

  async settle(fence: CopyFence): Promise<void> {
    await this.#context.storage.delete(fenceKey(fence.volume));
  }

  async removeCopiesInto(volume: string, signal?: AbortSignal): Promise<Set<string>> {
    const copies = await this.#cli.list({ [SNAPSHOT_INSTALL]: this.#context.installId, [COPY_INTO]: volume }, signal);
    for (const copy of copies) await this.#removeContainer(copy.id, signal);
    return new Set(copies.map((copy) => copy.labels[COPY_OP] ?? ""));
  }

  async sweep(making: ReadonlySet<string>, dropMadeAgain: (volume: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const removedOps = await this.#removeEndedCopies(making, signal);

    for (const key of await this.#context.storage.list(RESTORE_COPY_NOTES)) {
      const fence = await this.#context.storage.get<CopyFence>(key);
      if (!fence || making.has(fence.container) || this.mayStillAppear(fence, removedOps)) continue;
      await this.#dropVolumeOrCountTheFailure(fence, dropMadeAgain);
    }
  }

  async volumesLeft(): Promise<VolumeLeftByACopy[]> {
    const left: VolumeLeftByACopy[] = [];
    for (const key of await this.#context.storage.list(RESTORE_COPY_NOTES)) {
      const fence = await this.#context.storage.get<CopyFence>(key);
      const failedRemovals = fence?.failedRemovals ?? 0;
      if (fence && failedRemovals >= REMOVALS_FAILED_BEFORE_DOCTOR_WARNS) left.push({ volume: fence.volume, failedRemovals });
    }
    return left;
  }

  async #removeEndedCopies(making: ReadonlySet<string>, signal?: AbortSignal): Promise<Set<string>> {
    const copies = (await this.#cli.list({ [SNAPSHOT_INSTALL]: this.#context.installId }, signal)).filter(isRestoreCopy);
    const removedOps = new Set<string>();
    for (const copy of copies.filter((each) => !making.has(each.labels[COPY_FOR]!))) {
      try {
        await this.#rememberTheVolumeOf(copy);
        await this.#removeContainer(copy.id, signal);
        removedOps.add(copy.labels[COPY_OP]!);
      } catch (error) {
        this.#context.logError(`removing the copy ${copy.name} of a snapshot's Docker data`, error);
      }
    }
    return removedOps;
  }

  async #rememberTheVolumeOf(copy: ContainerInfo): Promise<void> {
    const volume = copy.labels[COPY_INTO]!;
    if (await this.fenceOf(volume)) return;
    const alreadyPastItsCreate = this.#now();
    const fence: CopyFence = { op: copy.labels[COPY_OP]!, volume, container: copy.labels[COPY_FOR]!, createBy: alreadyPastItsCreate };
    await this.#context.storage.set(fenceKey(volume), fence);
  }

  async #dropVolumeOrCountTheFailure(fence: CopyFence, dropMadeAgain: (volume: string) => Promise<void>): Promise<void> {
    try {
      await dropMadeAgain(fence.volume);
    } catch (error) {
      await this.#context.storage.set(fenceKey(fence.volume), { ...fence, failedRemovals: (fence.failedRemovals ?? 0) + 1 });
      this.#context.logError(`removing the Docker volume ${fence.volume}, which a copy of a snapshot's Docker data made again`, error);
      return;
    }
    await this.settle(fence);
  }

  async #removeContainer(id: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#cli.run(["container", "rm", "--force", id], { timeoutMs: 60_000, signal });
    if (result.exitCode !== 0 && !isGoneAlready(result.stderr)) throw this.#cli.error("docker container rm, for a copy of a snapshot's Docker data", result);
  }
}

function isRestoreCopy(container: ContainerInfo): boolean {
  return Boolean(container.labels[COPY_INTO] && container.labels[COPY_FOR] && container.labels[COPY_OP]);
}
