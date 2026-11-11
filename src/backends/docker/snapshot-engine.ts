import { randomUUID } from "node:crypto";
import { PRODUCT } from "../../brand.ts";
import { endOfUtcDay, gbWords, utcDay } from "../../core/snapshot.ts";
import { NO_PAUSE, SnapshotFailed, type BoxOwner, type SnapshotStorage, type BackendContext, type DoctorCheck, type Guest, type HeldSnapshot, type MachineSize, type SnapshotHooks, type SnapshotPlan, type SnapshotRef, type SnapshotTake, type SnapshotTaken, type TaskOutcome, type TaskRef } from "../types.ts";
import type { z } from "zod";
import { DockerCli, LABELS, snapshotContainersSchema, snapshotImagesSchema, snapshotVolumesSchema, snapshotStoreSchema } from "./cli.ts";
import { commitChanges, FORK_HOLD_MISSING, holdsForks, keepTagsToRemove, keptTag, keptTagsOf, keptUntilWith, KILL_ABOUT_MS, type KeepChange, layerRefusal, mountRefusal, pauseEstimate, pausedTooLong, restoreAboutMs, retainedOnEngine, sizeFromLabels, sizeTakenAt, snapshotImage, snapshotLabels, snapshotVolume, SNAPSHOT_BOX_NAME, SNAPSHOT_INSTALL, SNAPSHOT_THREAD, takePause, type ImageStore, type RetainedOnEngine } from "./snapshots.ts";

interface TakeState {
  readonly id: string;
  readonly box: string;
  readonly container: string;
  readonly startedAt: number;
  readonly estimateMs: number;
  readonly phase: "taking" | "failed" | "failed-resumed" | "complete";
}

type InspectedContainer = z.infer<typeof snapshotContainersSchema>[number];

export interface RestorableSnapshot {
  readonly id: string;
  readonly image: string;
  readonly volume: string | null;
  readonly volumeBytes: number;
  readonly size: MachineSize | null;
  readonly holdsForks: boolean;
}

type SnapshotImage = z.infer<typeof snapshotImagesSchema>[number];

interface OwnSnapshotImage {
  readonly id: string;
  readonly box: string;
  readonly image: SnapshotImage;
}

function oncePerImage(images: readonly SnapshotImage[]): readonly SnapshotImage[] {
  return [...new Map(images.map((image) => [image.Id, image])).values()];
}

type MeasuredStorage = SnapshotStorage & { readonly totalBytes: number; readonly usedBytes: number };

function ownerTakenFrom(box: string, labels: Readonly<Record<string, string>>): BoxOwner {
  return { boxId: box, threadId: labels[SNAPSHOT_THREAD] || "unknown", name: labels[SNAPSHOT_BOX_NAME] || null, kind: labels["bbbox.snapshot.kind"] || null, createdAt: null };
}

const KEEP_CHANGE_PREFIX = "docker-snapshot-keep:";

const HELPER = ["run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "/bin/sh"];

function keptSpaceWords(retained: readonly (RetainedOnEngine | null)[], one: boolean): string {
  const measured = retained.filter((each): each is RetainedOnEngine => each !== null);
  if (!measured.length || measured.length < retained.length) return `${PRODUCT} could not read how much of Docker's disk ${one ? "it takes" : "they take"}.`;
  const whole = measured.reduce((sum, each) => sum + each.wholeBytes, 0);
  const they = one ? "It takes" : "They take";
  if (measured.some((each) => each.unsharedBytes === null)) return `${they} up to ${gbWords(whole)} of Docker's disk.`;
  const unshared = measured.reduce((sum, each) => sum + each.unsharedBytes!, 0);
  const upTo = whole > unshared ? `, and up to ${gbWords(whole)} if what ${one ? "it shares" : "they share"} is deleted` : "";
  return `${they} about ${gbWords(unshared)} of Docker's disk that no other image or container there uses${upTo}.`;
}

function keptCheck(listed: readonly HeldSnapshot[], retained: readonly (RetainedOnEngine | null)[]): DoctorCheck {
  const kept = listed.filter((held) => held.keptUntil !== null);
  if (!kept.length) return { id: "docker.kept-snapshots", name: "Kept snapshots", status: "ok", detail: "No snapshot here is kept.", fix: null };
  const latest = utcDay(Math.max(...kept.map((held) => held.keptUntil!)));
  const these = kept.length === 1
    ? `1 snapshot is kept, whether its box is released or not, until its keep date, ${latest}.`
    : `${kept.length} snapshots are kept, whether their boxes are released or not, until their keep dates, the latest ${latest}.`;
  return {
    id: "docker.kept-snapshots",
    name: "Kept snapshots",
    status: "ok",
    detail: `${these} ${keptSpaceWords(retained, kept.length === 1)} ${PRODUCT} refuses to remove this backend while it holds them.`,
    fix: "Delete one with bb box snapshot delete <box> <snapshot>, as bb box snapshot list --all names them.",
  };
}

function keepPlan(keepOffBecause: string | null, retained: RetainedOnEngine | null): SnapshotPlan["keep"] {
  return keepOffBecause
    ? { way: "no", why: keepOffBecause, aboutMs: null, bytes: null, price: null }
    : { way: "as-is", why: null, aboutMs: null, bytes: retained && retained.unsharedBytes !== null ? retained.wholeBytes : null, unsharedBytes: retained?.unsharedBytes ?? null, price: null };
}

function forkPlan(refusal: string | null, volumeBytes: number, size: MachineSize | null): SnapshotPlan["fork"] {
  const aboutMs = restoreAboutMs(volumeBytes);
  return refusal ? { ok: false, why: refusal, aboutMs, bytes: null, size: null } : { ok: true, why: null, aboutMs, bytes: volumeBytes, size };
}

export class DockerSnapshotEngine {
  readonly #cli: DockerCli;
  readonly #context: BackendContext;
  readonly #active = new Set<string>();
  readonly #now: () => number;
  readonly #keepOffBecause: string | null;
  #keepTagTurn: Promise<unknown> = Promise.resolve();

  constructor(cli: DockerCli, context: BackendContext, now: () => number = Date.now, keepOffBecause: string | null = null) {
    this.#cli = cli;
    this.#context = context;
    this.#now = now;
    this.#keepOffBecause = keepOffBecause;
  }

  async #container(guest: Guest, signal?: AbortSignal): Promise<InspectedContainer> {
    const values = snapshotContainersSchema.parse(JSON.parse(await this.#cli.ok(["container", "inspect", "--size", guest.ref], { signal })));
    const found = values[0];
    if (!found || found.Config.Labels[LABELS.install] !== this.#context.installId || found.Config.Labels[LABELS.box] !== guest.data?.box) {
      throw new Error("This box is gone. List boxes and choose one that still exists.");
    }
    return found;
  }

  async #facts(guest: Guest, signal?: AbortSignal, measureVolume = true) {
    const container = await this.#container(guest, signal);
    const mounts = container.Mounts.map((mount) => ({ type: mount.Type, name: mount.Name ?? "", destination: mount.Destination, writable: mount.RW }));
    const refusal = mountRefusal(mounts);
    const volume = mounts.find((mount) => mount.type === "volume" && mount.destination === "/var/lib/docker")?.name ?? null;
    const images = snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", container.Image], { signal })));
    const image = images[0];
    if (!image) throw new Error("The box's image is missing. Make a new box before taking a snapshot.");
    const volumeBytes = volume && !refusal && measureVolume
      ? Number((await this.#cli.ok([...HELPER, "--privileged", "--volume", `${volume}:/from:ro`, container.Image, "-c", "du -sk /from"], { signal })).trim().split(/\s+/)[0]) * 1024
      : 0;
    if (!Number.isFinite(volumeBytes + container.SizeRw)) throw new Error("Docker's disk usage could not be read. Check the Docker host's disk and try again.");
    const { store, storage } = await this.#space(container.Image, signal);
    const estimate = pauseEstimate({ layerBytes: container.SizeRw, volumeBytes, store });
    return { container, volume, volumeBytes, store, estimate, storage, refusal: refusal ?? layerRefusal(image.RootFS.Layers.length) };
  }

  async #space(helperImage: string, signal?: AbortSignal): Promise<{ readonly store: ImageStore; readonly storage: MeasuredStorage }> {
    const info = snapshotStoreSchema.parse(JSON.parse(await this.#cli.ok(["info", "--format", "{{json .}}"], { signal })));
    const store: ImageStore = JSON.stringify(info.DriverStatus ?? []).includes("containerd") ? "containerd" : "overlay2";
    const probe = `bbbox-snapshot-space-${this.#context.installId}-${randomUUID()}`;
    await this.#cli.ok(["volume", "create", "--label", `bbbox.snapshot.probe=${this.#context.installId}`, probe], { signal });
    let df: string;
    try {
      df = await this.#cli.ok([...HELPER, "--volume", `${probe}:/space:ro`, helperImage, "-c", "df -Pk /space"], { signal });
    } finally {
      await this.#cli.ok(["volume", "rm", probe]);
    }
    const columns = df.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    const totalBytes = Number(columns[1]) * 1024;
    const usedBytes = Number(columns[2]) * 1024;
    if (![totalBytes, usedBytes].every(Number.isFinite) || totalBytes <= 0) throw new Error("Docker's disk usage could not be read. Check the Docker host's disk and try again.");
    return { store, storage: { key: `docker:${info.ID}`, name: "Docker's disk", type: `docker-${store}`, percentFull: usedBytes / totalBytes * 100, metadataPercentFull: null, metadataUnread: null, totalBytes, usedBytes } };
  }

  async #boxIsGone(guest: Guest, signal?: AbortSignal): Promise<boolean> {
    const found = await this.#cli.run(["container", "inspect", guest.ref], { signal });
    return found.exitCode !== 0 && /no such container/i.test(found.stderr);
  }

  async #planWithoutBox(guest: Guest, target: SnapshotRef, signal?: AbortSignal): Promise<SnapshotPlan> {
    const snapshot = await this.restorable(target, signal);
    const { storage } = await this.#space(snapshot.image, signal);
    const gone = "Its box was released, so only a fork of this snapshot can use it.";
    return {
      storage,
      take: { ok: false, why: gone, aboutMs: 0, memoryAboutMs: null, addsBytes: 0, pause: NO_PAUSE, memory: null, memoryWhy: "Docker snapshots hold the disk and Docker data only." },
      restore: { way: "none", why: gone, undo: "none", undoAboutMs: 0, undoBytes: 0, sizeBack: snapshot.size, leavesOnEarlierGuest: 0, newer: 0, copyAboutMs: null },
      keep: keepPlan(this.#keepOffBecause, await this.#retainedIfKept(snapshot, signal)),
      fork: forkPlan(snapshot.holdsForks ? null : FORK_HOLD_MISSING, snapshot.volumeBytes, snapshot.size ?? guest.size),
      locked: null,
      busy: null,
    };
  }

  async plan(guest: Guest, target: SnapshotRef | null, signal?: AbortSignal): Promise<SnapshotPlan> {
    if (target && (await this.#boxIsGone(guest, signal))) return this.#planWithoutBox(guest, target, signal);
    const facts = await this.#facts(guest, signal);
    const restoring = target ? await this.restorable(target, signal).catch((error: unknown) => error instanceof SnapshotFailed ? error.message : Promise.reject(error)) : null;
    const restoreWhy = typeof restoring === "string" ? restoring : null;
    const restorable = typeof restoring === "string" ? null : restoring;
    return {
      storage: facts.storage,
      take: { ok: !facts.refusal, why: facts.refusal, aboutMs: facts.estimate.pauseMs, memoryAboutMs: null, addsBytes: facts.estimate.addsBytes, pause: takePause({ layerBytes: facts.container.SizeRw, volumeBytes: facts.volumeBytes, store: facts.store }, facts.container.State.Status === "running"), memory: null, memoryWhy: "Docker snapshots hold the disk and Docker data only." },
      restore: {
        way: restoreWhy ? "none" : "new-guest",
        why: restoreWhy,
        undo: restoreWhy ? "none" : "snapshot",
        undoAboutMs: KILL_ABOUT_MS + facts.estimate.pauseMs + restoreAboutMs(restorable?.volumeBytes ?? 0),
        undoBytes: facts.estimate.addsBytes,
        sizeBack: restorable?.size ?? guest.size,
        leavesOnEarlierGuest: 0,
        newer: 0,
        copyAboutMs: null,
      },
      keep: keepPlan(this.#keepOffBecause, restorable ? await this.#retainedIfKept(restorable, signal) : null),
      fork: forkPlan(restoreWhy ?? (restorable && !restorable.holdsForks ? FORK_HOLD_MISSING : null), restorable?.volumeBytes ?? facts.volumeBytes, restorable?.size ?? guest.size),
      locked: null,
      busy: facts.container.State.Paused ? "The box is paused. Unpause it, or wait for its snapshot to finish, then try again." : null,
    };
  }

  async restorable(ref: SnapshotRef, signal?: AbortSignal): Promise<RestorableSnapshot> {
    const box = ref.guest.data?.box;
    if (typeof box !== "string" || ref.ref !== snapshotImage(this.#context.installId, box, ref.id)) throw new SnapshotFailed("That snapshot does not belong to this box and install. Choose one of this box's snapshots.");
    const held = (await this.listed(signal)).find((each) => each.id === ref.id && each.ref === ref.ref);
    if (!held) throw new SnapshotFailed("Docker no longer has this snapshot. Choose another snapshot.");
    if (held.state !== "complete") throw new SnapshotFailed(`Docker has only part of this snapshot. ${held.words ?? "It is not complete."} Choose another snapshot.`);
    const [image] = snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", ref.ref], { signal })));
    const labels = image?.Config.Labels ?? {};
    return {
      id: ref.id,
      image: ref.ref,
      volume: labels["bbbox.snapshot.volume"] || null,
      volumeBytes: Number(labels["bbbox.snapshot.volume-bytes"]) || 0,
      size: sizeTakenAt(labels),
      holdsForks: holdsForks(labels),
    };
  }

  async #layerBytes(ref: string, signal?: AbortSignal): Promise<number[]> {
    const sizes = (await this.#cli.ok(["image", "history", "--human=false", "--format", "{{.Size}}", ref], { signal })).trim().split(/\s+/).map(Number);
    return sizes.filter((bytes) => bytes > 0).reverse();
  }

  async #layersOfOtherImages(except: string, signal?: AbortSignal): Promise<readonly (readonly string[])[]> {
    const ids = [...new Set((await this.#cli.ok(["image", "ls", "--quiet", "--no-trunc"], { signal })).trim().split(/\s+/).filter((id) => id && id !== except))];
    return ids.length ? snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", ...ids], { signal }))).filter((image) => image.Id !== except).map((image) => image.RootFS.Layers) : [];
  }

  async #aContainerUses(imageId: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.#cli.ok(["container", "ls", "--all", "--quiet", "--filter", `ancestor=${imageId}`], { signal })).trim() !== "";
  }

  async #retained(ref: string, signal?: AbortSignal): Promise<RetainedOnEngine | null> {
    try {
      const [image] = snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", ref], { signal })));
      if (!image) return null;
      const labels = image.Config.Labels;
      const layers = { layers: image.RootFS.Layers, layerBytes: await this.#layerBytes(ref, signal), imageBytes: image.Size, store: labels["bbbox.snapshot.store"] === "containerd" ? "containerd" as const : "overlay2" as const, volumeBytes: Number(labels["bbbox.snapshot.volume-bytes"]) || 0 };
      const otherImages = await this.#layersOfOtherImages(image.Id, signal);
      const sharers = (await this.#aContainerUses(image.Id, signal)) ? [...otherImages, image.RootFS.Layers] : otherImages;
      return retainedOnEngine(layers, sharers);
    } catch (error) {
      signal?.throwIfAborted();
      this.#context.logError("reading how much of Docker's disk a snapshot takes", error);
      return null;
    }
  }

  async #retainedIfKept(snapshot: RestorableSnapshot, signal?: AbortSignal): Promise<RetainedOnEngine | null> {
    return this.#keepOffBecause ? null : this.#retained(snapshot.image, signal);
  }

  async copyDockerData(snapshot: RestorableSnapshot, into: string, signal?: AbortSignal): Promise<void> {
    if (!snapshot.volume) return;
    await this.#cli.ok([
      "run", "--rm", "--pull", "never", "--privileged", "--network", "none",
      "--label", `${SNAPSHOT_INSTALL}=${this.#context.installId}`, "--label", `bbbox.snapshot=${snapshot.id}`,
      "--entrypoint", "cp",
      "--volume", `${snapshot.volume}:/from:ro`, "--volume", `${into}:/to`,
      snapshot.image, "-a", "--reflink=auto", "/from/.", "/to/",
    ], { signal, timeoutMs: 15 * 60_000 });
  }

  #key(id: string): string { return `docker-snapshot-take:${id}`; }

  #keepKey(id: string): string { return `${KEEP_CHANGE_PREFIX}${id}`; }

  #oneKeepTagChangeAtATime<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#keepTagTurn.then(work, work);
    this.#keepTagTurn = turn.catch(() => undefined);
    return turn;
  }

  async take(guest: Guest, take: SnapshotTake, hooks: SnapshotHooks, signal?: AbortSignal): Promise<SnapshotTaken> {
    const facts = await this.#facts(guest, signal);
    if (facts.storage.usedBytes + facts.estimate.addsBytes >= facts.storage.totalBytes) throw new Error("Docker has too little free space for this snapshot. Delete snapshots or free disk space first.");
    if (take.box !== guest.data?.box) throw new Error("The snapshot must name this box. Choose the box again.");
    if (take.memory) throw new Error("Docker snapshots cannot hold memory. Leave memory out.");
    if (facts.refusal) throw new Error(facts.refusal);
    if (facts.container.State.Paused) throw new Error("The box is already paused. Unpause it before taking a snapshot.");
    const state: TakeState = { id: take.id, box: take.box, container: guest.ref, startedAt: this.#now(), estimateMs: facts.estimate.pauseMs, phase: "taking" };
    const image = snapshotImage(this.#context.installId, take.box, take.id);
    if ((await this.#cli.run(["image", "inspect", image], { signal })).exitCode === 0) throw new Error("That snapshot already exists. Choose a new snapshot ID.");
    const volume = facts.volume ? snapshotVolume(take.id) : null;
    if (volume) {
      const existing = await this.#cli.run(["volume", "inspect", volume], { signal });
      if (existing.exitCode === 0) throw new Error("That snapshot volume already exists. Delete the earlier snapshot before retrying.");
      if (!/no such volume/i.test(existing.stderr)) throw this.#cli.error("Checking snapshot volume", existing);
    }
    const labels = {
      ...snapshotLabels(this.#context.installId, take.box, take.id),
      "bbbox.snapshot.kind": facts.container.Config.Labels[LABELS.kind] ?? "linux",
      [SNAPSHOT_BOX_NAME]: facts.container.Config.Labels[LABELS.name] ?? "",
      [SNAPSHOT_THREAD]: facts.container.Config.Labels[LABELS.thread] ?? "",
      "bbbox.snapshot.reset": String(take.forkSafe ?? 0),
      "bbbox.snapshot.taken": String(state.startedAt),
      "bbbox.snapshot.cores": String(guest.size?.cores ?? 0),
      "bbbox.snapshot.memory-mib": String(guest.size?.memoryMiB ?? 0),
      "bbbox.snapshot.volume": volume ?? "",
      "bbbox.snapshot.layer-bytes": String(facts.container.SizeRw),
      "bbbox.snapshot.volume-bytes": String(facts.volumeBytes),
      "bbbox.snapshot.store": facts.store,
    };
    await hooks.submitting();
    await this.#context.storage.set(this.#key(take.id), state);
    await hooks.task({ ref: `take:${take.id}@${state.startedAt}`, host: guest.host });
    this.#active.add(take.id);
    let pausedAt: number | null = null;
    let pausedMs = 0;
    let committed = false;
    try {
      if (facts.container.State.Status === "running") {
        pausedAt = this.#now();
        await this.#cli.ok(["pause", guest.ref], { signal });
      }
      if (volume && facts.volume) {
        await this.#cli.ok(["volume", "create", ...Object.entries({ ...snapshotLabels(this.#context.installId, take.box, take.id), "bbbox.snapshot.started": String(state.startedAt), "bbbox.snapshot.estimate-ms": String(state.estimateMs), "bbbox.snapshot.container": guest.ref }).flatMap(([key, value]) => ["--label", `${key}=${value}`]), volume], { signal });
        await this.#cli.ok(["run", "--rm", "--name", `bbbox-snapshot-copy-${take.id}`, "--label", `bbbox.snapshot.install=${this.#context.installId}`, "--label", `bbbox.snapshot=${take.id}`, "--pull", "never", "--privileged", "--network", "none", "--entrypoint", "cp", "--volume", `${facts.volume}:/from:ro`, "--volume", `${volume}:/to`, facts.container.Image, "-a", "--reflink=auto", "/from/.", "/to/"], { signal, timeoutMs: 15 * 60_000 });
      }
      await this.#cli.ok(["container", "commit", "--pause=false", ...commitChanges(facts.container.Config.Labels, labels).flatMap((change) => ["--change", change]), guest.ref, image], { signal, timeoutMs: 15 * 60_000 });
      committed = true;
    } catch (error) {
      await this.#context.storage.set(this.#key(take.id), { ...state, phase: "failed" });
      throw error;
    } finally {
      this.#active.delete(take.id);
      if (pausedAt !== null) {
        const current = (await this.#cli.inspect([guest.ref]))[0];
        if (current?.status === "paused" && current.labels[LABELS.install] === this.#context.installId && current.labels[LABELS.box] === take.box) await this.#cli.ok(["unpause", guest.ref]);
        pausedMs = this.#now() - pausedAt;
        this.#context.log?.(`Docker snapshot ${take.id} paused box ${take.box} for ${pausedMs} ms.`);
      }
      await this.#context.storage.set(this.#key(take.id), { ...state, phase: committed ? "complete" : "failed-resumed" });
      if (!committed) await this.#discard(state).catch((error) => this.#context.logError("cleaning a failed Docker snapshot", error));
    }
    return { ref: image, holds: "disk", capturedAt: state.startedAt, size: { bytes: facts.estimate.addsBytes, means: "own", estimated: true }, pausedMs };
  }

  async #discard(state: TakeState): Promise<void> {
    const helper = (await this.#cli.inspect([`bbbox-snapshot-copy-${state.id}`]))[0];
    if (helper?.labels[SNAPSHOT_INSTALL] === this.#context.installId && helper.labels["bbbox.snapshot"] === state.id) await this.#cli.ok(["container", "rm", "--force", helper.id]);
    const removed = await this.#cli.run(["image", "rm", "--force", snapshotImage(this.#context.installId, state.box, state.id)]);
    if (removed.exitCode !== 0 && !/no such image/i.test(removed.stderr)) throw this.#cli.error("Removing failed snapshot image", removed);
    await this.#removeVolume(state.id, state.box);
  }

  async settle(task: TaskRef): Promise<TaskOutcome> {
    const match = /^take:([^@]+)@(\d+)$/.exec(task.ref);
    if (!match) return { state: "missing", words: "This is not a Docker snapshot task." };
    const state = await this.#context.storage.get<TakeState>(this.#key(match[1]!));
    if (!state) return { state: "missing", words: "The Docker snapshot task record is missing." };
    if (this.#active.has(state.id)) return { state: "running" };
    if (state.phase === "complete") return { state: "ok" };
    if (state.phase === "failed-resumed") {
      await this.#discard(state);
      await this.#context.storage.delete(this.#key(state.id));
      return { state: "failed", words: "The snapshot was interrupted. Its partial copy was removed." };
    }
    const complete = (await this.listed()).some((held) => held.id === state.id && held.state === "complete");
    if (state.phase !== "failed" && complete) {
      const container = (await this.#cli.inspect([state.container]))[0];
      if (container?.status === "paused" && container.labels[LABELS.install] === this.#context.installId && container.labels[LABELS.box] === state.box) await this.#cli.ok(["unpause", state.container]);
      await this.#context.storage.set(this.#key(state.id), { ...state, phase: "complete" });
      return { state: "ok" };
    }
    if (state.phase !== "failed" && !pausedTooLong(state, this.#now())) return { state: "running" };
    await this.#context.storage.set(this.#key(state.id), { ...state, phase: "failed" });
    const container = (await this.#cli.inspect([state.container]))[0];
    if (container?.status === "paused" && container.labels[LABELS.install] === this.#context.installId && container.labels[LABELS.box] === state.box) await this.#cli.ok(["unpause", state.container]);
    await this.#context.storage.set(this.#key(state.id), { ...state, phase: "failed-resumed" });
    await this.#discard(state);
    return { state: "failed", words: "The snapshot was interrupted. Its partial copy was removed and the box was unpaused." };
  }

  async #volumes(signal?: AbortSignal): Promise<readonly { Name: string; Labels: Record<string, string> }[]> {
    const names = (await this.#cli.ok(["volume", "ls", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`, "--format", "{{.Name}}"], { signal })).trim().split(/\s+/).filter(Boolean);
    return names.length ? snapshotVolumesSchema.parse(JSON.parse(await this.#cli.ok(["volume", "inspect", ...names], { signal }))) : [];
  }

  async listed(signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    return this.#listed(await this.#volumes(signal), signal);
  }

  async #snapshotImages(signal?: AbortSignal): Promise<readonly OwnSnapshotImage[]> {
    const ids = (await this.#cli.ok(["image", "ls", "--quiet", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`], { signal })).trim().split(/\s+/).filter(Boolean);
    const images = ids.length ? oncePerImage(snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", ...new Set(ids)], { signal })))) : [];
    return images.flatMap((image) => {
      const labels = image.Config.Labels;
      const id = labels["bbbox.snapshot"];
      const box = labels["bbbox.snapshot.box"];
      if (labels[SNAPSHOT_INSTALL] !== this.#context.installId || !id || !box || !image.RepoTags.includes(snapshotImage(this.#context.installId, box, id))) return [];
      return [{ id, box, image }];
    });
  }

  async #listed(volumes: readonly { Name: string; Labels: Record<string, string> }[], signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    const images = await this.#snapshotImages(signal);
    const volumesByName = new Map(volumes.map((volume) => [volume.Name, volume.Labels]));
    const result: HeldSnapshot[] = [];

    for (const { id, box, image } of images) {
      const labels = image.Config.Labels;
      const takenAt = Number(labels["bbbox.snapshot.taken"]);
      if (!Number.isFinite(takenAt) || takenAt <= 0) continue;
      const state = await this.#context.storage.get<TakeState>(this.#key(id));
      const volume = labels["bbbox.snapshot.volume"];
      const owned = volume ? volumesByName.get(volume) : null;
      const exists = !volume || (volume === snapshotVolume(id) && owned?.[SNAPSHOT_INSTALL] === this.#context.installId && owned["bbbox.snapshot"] === id && owned["bbbox.snapshot.box"] === box);
      result.push({
        id, box,
        ref: snapshotImage(this.#context.installId, box, id),
        owner: ownerTakenFrom(box, labels),
        guest: { ref: state?.container ?? `bbbox-${box}`, host: null, address: null, size: null, data: { box } },
        where: "current",
        state: state?.phase.startsWith("failed") || !exists ? "incomplete" : this.#active.has(id) ? "in-progress" : "complete",
        words: state?.phase.startsWith("failed") ? "The snapshot's take failed." : exists ? null : "The snapshot's Docker data is missing.",
        holds: "disk",
        takenAt,
        keptUntil: keptUntilWith(image.RepoTags, this.#context.installId, id, (await this.#context.storage.get<KeepChange>(this.#keepKey(id))) ?? null),
        storage: { name: "Docker's disk", type: `docker-${labels["bbbox.snapshot.store"]}` },
        forkSafe: Number(labels["bbbox.snapshot.reset"]) || null,
        size: sizeFromLabels(labels),
      });
    }

    for (const volume of volumes) {
      const labels = volume.Labels;
      const id = labels["bbbox.snapshot"];
      const box = labels["bbbox.snapshot.box"];
      if (!id || !box || labels[SNAPSHOT_INSTALL] !== this.#context.installId || volume.Name !== snapshotVolume(id) || result.some((held) => held.id === id)) continue;
      result.push({
        id, box,
        ref: snapshotImage(this.#context.installId, box, id),
        owner: null,
        guest: { ref: labels["bbbox.snapshot.container"] ?? `bbbox-${box}`, host: null, address: null, size: null, data: { box } },
        where: "current",
        state: this.#active.has(id) ? "in-progress" : "incomplete",
        words: "The snapshot has Docker data but no completed disk image.",
        holds: "disk",
        takenAt: Number(labels["bbbox.snapshot.started"]) || null,
        keptUntil: null,
        storage: { name: "Docker's disk", type: "docker" },
      });
    }
    return result;
  }

  async doctor(signal?: AbortSignal): Promise<readonly DoctorCheck[]> {
    const containers = await this.#cli.list({ [LABELS.install]: this.#context.installId }, signal);
    const box = containers.find((container) => container.labels[LABELS.box]);
    const pending: string[] = [];
    for (const key of await this.#context.storage.list("docker-snapshot-take:")) {
      const state = await this.#context.storage.get<TakeState>(key);
      if (state?.phase === "taking") pending.push(state.id);
    }
    const listed = await this.listed(signal);
    const incomplete = listed.filter((held) => held.state === "incomplete");
    const dangling = (await this.#cli.ok(["image", "ls", "--quiet", "--filter", "dangling=true", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`], { signal })).trim().split(/\s+/).filter(Boolean);
    const deep: string[] = [];
    for (const container of containers) {
      const images = snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", container.imageId], { signal })));
      if ((images[0]?.RootFS.Layers.length ?? 0) >= 110) deep.push(container.name);
    }
    const facts = box ? await this.#facts({ ref: box.name, host: null, address: null, size: null, data: { box: box.labels[LABELS.box] } }, signal, false) : null;
    const retained = await this.#retainedOfKept(listed, signal);
    return [
      { id: "docker.snapshots", name: "Snapshots", status: facts ? facts.storage.percentFull >= 85 ? "warn" : "ok" : "skipped", detail: facts ? `${facts.store}: allow about ${facts.store === "containerd" ? "twice" : "once"} the changed disk bytes. ${facts.volume ? "Add the box's Docker data." : "This box has no Docker volume: snapshots hold its disk only."} Docker's disk is ${facts.storage.percentFull.toFixed(1)}% full.` : "Make a box to measure snapshot space on this engine.", fix: null },
      { id: "docker.snapshot-leftovers", name: "Snapshot leftovers", status: pending.length || incomplete.length || dangling.length ? "warn" : "ok", detail: pending.length || incomplete.length || dangling.length ? `${pending.length} snapshot tasks await recovery; ${incomplete.length} copies are incomplete; images without tags: ${dangling.length}. Maintenance unpauses interrupted takes after their time bound and prunes images no container uses.` : "No snapshot tasks await recovery.", fix: null },
      keptCheck(listed, retained),
      { id: "docker.snapshot-layers", name: "Snapshot layers", status: deep.length ? "warn" : "ok", detail: deep.length ? `Images near the layer limit: ${deep.join(", ")}. Make new boxes and move their files.` : "No box image has 110 or more layers.", fix: null },
    ];
  }

  async #retainedOfKept(listed: readonly HeldSnapshot[], signal?: AbortSignal): Promise<readonly (RetainedOnEngine | null)[]> {
    const kept = listed.filter((held) => held.keptUntil !== null);
    const retained: (RetainedOnEngine | null)[] = [];
    for (const held of kept) retained.push(await this.#retained(held.ref, signal));
    return retained;
  }

  async maintain(): Promise<void> {
    const volumes = await this.#volumes();
    const complete = new Set((await this.#listed(volumes)).filter((held) => held.state === "complete").map((held) => held.id));
    for (const volume of volumes) {
      const labels = volume.Labels;
      const id = labels["bbbox.snapshot"];
      const box = labels["bbbox.snapshot.box"];
      const container = labels["bbbox.snapshot.container"];
      const startedAt = Number(labels["bbbox.snapshot.started"]);
      const estimateMs = Number(labels["bbbox.snapshot.estimate-ms"]);
      if (!id || !box || !container || volume.Name !== snapshotVolume(id) || !Number.isFinite(startedAt) || !Number.isFinite(estimateMs)) continue;
      if (!complete.has(id) && pausedTooLong({ startedAt, estimateMs }, this.#now()) && !(await this.#context.storage.get(this.#key(id)))) await this.#context.storage.set(this.#key(id), { id, box, container, startedAt, estimateMs, phase: "failed-resumed" });
    }
    for (const key of await this.#context.storage.list("docker-snapshot-take:")) {
      const state = await this.#context.storage.get<TakeState>(key);
      try {
        if (state && state.phase !== "complete") await this.settle({ ref: `take:${state.id}@${state.startedAt}`, host: null });
      } catch (error) {
        this.#context.logError("recovering a Docker snapshot take", error);
      }
    }
    await this.#settleKeepTags().catch((error) => this.#context.logError("settling Docker snapshots' keep tags", error));
    await this.#cli.ok(["image", "prune", "--force", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`]);
  }

  #settleKeepTags(): Promise<void> {
    return this.#oneKeepTagChangeAtATime(async () => {
      const images = await this.#snapshotImages();
      for (const { id, image } of images) {
        const change = (await this.#context.storage.get<KeepChange>(this.#keepKey(id))) ?? null;
        for (const tag of keepTagsToRemove(image.RepoTags, this.#context.installId, id, change)) await this.#untag(tag);
        if (change) await this.#context.storage.delete(this.#keepKey(id));
      }
      const held = new Set(images.map(({ id }) => this.#keepKey(id)));
      for (const key of await this.#context.storage.list(KEEP_CHANGE_PREFIX)) if (!held.has(key)) await this.#context.storage.delete(key);
    });
  }

  async #removeVolume(id: string, box: string, signal?: AbortSignal): Promise<void> {
    const volume = snapshotVolume(id);
    const result = await this.#cli.run(["volume", "inspect", volume], { signal });
    if (result.exitCode !== 0) {
      if (/no such volume/i.test(result.stderr)) return;
      throw this.#cli.error("Reading snapshot volume", result);
    }
    const entries = snapshotVolumesSchema.parse(JSON.parse(result.stdout));
    const labels = entries[0]?.Labels;
    if (labels?.[SNAPSHOT_INSTALL] !== this.#context.installId || labels["bbbox.snapshot"] !== id || labels["bbbox.snapshot.box"] !== box) throw new Error("The snapshot volume belongs to another box or install. Check its labels before deleting it.");
    await this.#cli.ok(["volume", "rm", volume], { signal });
  }

  async #ownImage(ref: SnapshotRef, signal?: AbortSignal): Promise<SnapshotImage | null> {
    const found = await this.#cli.run(["image", "inspect", ref.ref], { signal });
    if (found.exitCode !== 0) {
      if (/no such image/i.test(found.stderr)) return null;
      throw this.#cli.error("Reading the snapshot image", found);
    }
    const [image] = snapshotImagesSchema.parse(JSON.parse(found.stdout));
    const labels = image?.Config.Labels ?? {};
    return image && labels[SNAPSHOT_INSTALL] === this.#context.installId && labels["bbbox.snapshot"] === ref.id && image.RepoTags.includes(ref.ref) ? image : null;
  }

  async #untag(tag: string, signal?: AbortSignal): Promise<void> {
    const removed = await this.#cli.run(["image", "rm", tag], { signal });
    if (removed.exitCode !== 0 && !/no such image/i.test(removed.stderr)) throw this.#cli.error("Removing a keep date from a snapshot", removed);
  }

  async keep(ref: SnapshotRef, day: string | null, signal?: AbortSignal): Promise<void> {
    if (this.#keepOffBecause) throw new SnapshotFailed(`${PRODUCT} keeps no snapshot here past its box's release: ${this.#keepOffBecause}.`);
    if (day !== null && endOfUtcDay(day) === null) throw new SnapshotFailed(`"${day}" is not a date as yyyy-mm-dd. Give the keep date as one.`);
    await this.#oneKeepTagChangeAtATime(async () => {
      const image = await this.#ownImage(ref, signal);
      if (!image) throw new SnapshotFailed(`Docker has no snapshot ${ref.id} of this install, so ${PRODUCT} cannot write its keep date. List the snapshots again.`);
      const change: KeepChange = { to: day };
      await this.#context.storage.set(this.#keepKey(ref.id), change);
      const wanted = day === null ? null : keptTag(this.#context.installId, ref.id, day);
      if (wanted) await this.#cli.ok(["image", "tag", ref.ref, wanted], { signal });
      const tags = wanted ? [...image.RepoTags, wanted] : image.RepoTags;
      for (const earlier of keepTagsToRemove(tags, this.#context.installId, ref.id, change)) await this.#untag(earlier, signal);
      await this.#context.storage.delete(this.#keepKey(ref.id));
    });
  }

  async remove(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    const held = (await this.listed(signal)).find((item) => item.id === ref.id && item.ref === ref.ref && item.box === ref.guest.data?.box);
    const box = ref.guest.data?.box;
    if (typeof box !== "string" || ref.ref !== snapshotImage(this.#context.installId, box, ref.id)) throw new Error("That snapshot does not belong to this box and install.");
    await hooks.submitting();
    await this.#oneKeepTagChangeAtATime(async () => {
      const image = await this.#ownImage(ref, signal);
      for (const kept of image ? keptTagsOf(image.RepoTags, this.#context.installId, ref.id) : []) await this.#untag(kept, signal);
      await this.#context.storage.delete(this.#keepKey(ref.id));
    });
    if (held) {
      const removed = await this.#cli.run(["image", "rm", "--force", held.ref], { signal });
      if (removed.exitCode !== 0 && !/no such image/i.test(removed.stderr)) throw this.#cli.error("Deleting snapshot image", removed);
    }
    await this.#removeVolume(ref.id, box, signal);
    await this.#context.storage.delete(this.#key(ref.id));
  }
}
