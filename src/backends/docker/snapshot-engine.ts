import { randomUUID } from "node:crypto";
import type { BackendContext, DoctorCheck, Guest, HeldSnapshot, SnapshotHooks, SnapshotPlan, SnapshotRef, SnapshotTake, SnapshotTaken, TaskOutcome, TaskRef } from "../types.ts";
import type { z } from "zod";
import { DockerCli, LABELS, snapshotContainersSchema, snapshotImagesSchema, snapshotVolumesSchema, snapshotStoreSchema } from "./cli.ts";
import { commitChanges, layerRefusal, mountRefusal, pauseEstimate, pausedTooLong, snapshotImage, snapshotLabels, snapshotVolume, SNAPSHOT_INSTALL, type ImageStore } from "./snapshots.ts";

interface TakeState {
  readonly id: string;
  readonly box: string;
  readonly container: string;
  readonly startedAt: number;
  readonly estimateMs: number;
  readonly phase: "taking" | "failed" | "failed-resumed" | "complete";
}

type InspectedContainer = z.infer<typeof snapshotContainersSchema>[number];

export class DockerSnapshotEngine {
  readonly #cli: DockerCli;
  readonly #context: BackendContext;
  readonly #active = new Set<string>();
  readonly #now: () => number;

  constructor(cli: DockerCli, context: BackendContext, now: () => number = Date.now) {
    this.#cli = cli;
    this.#context = context;
    this.#now = now;
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
    const info = snapshotStoreSchema.parse(JSON.parse(await this.#cli.ok(["info", "--format", "{{json .}}"], { signal })));
    const store: ImageStore = JSON.stringify(info.DriverStatus ?? []).includes("containerd") ? "containerd" : "overlay2";
    const helper = ["run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "/bin/sh"];
    const volumeBytes = volume && !refusal && measureVolume
      ? Number((await this.#cli.ok([...helper, "--privileged", "--volume", `${volume}:/from:ro`, container.Image, "-c", "du -sk /from"], { signal })).trim().split(/\s+/)[0]) * 1024
      : 0;
    const probe = `bbbox-snapshot-space-${this.#context.installId}-${randomUUID()}`;
    await this.#cli.ok(["volume", "create", "--label", `bbbox.snapshot.probe=${this.#context.installId}`, probe], { signal });
    let df: string;
    try {
      df = await this.#cli.ok([...helper, "--volume", `${probe}:/space:ro`, container.Image, "-c", "df -Pk /space"], { signal });
    } finally {
      await this.#cli.ok(["volume", "rm", probe]);
    }
    const columns = df.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    const totalBytes = Number(columns[1]) * 1024;
    const usedBytes = Number(columns[2]) * 1024;
    if (![totalBytes, usedBytes, volumeBytes, container.SizeRw].every(Number.isFinite) || totalBytes <= 0) throw new Error("Docker's disk usage could not be read. Check the Docker host's disk and try again.");
    const estimate = pauseEstimate({ layerBytes: container.SizeRw, volumeBytes, store });
    return {
      container, volume, volumeBytes, store, estimate,
      refusal: refusal ?? layerRefusal(image.RootFS.Layers.length),
      storage: { key: `docker:${info.ID}`, name: "Docker's disk", type: `docker-${store}`, percentFull: usedBytes / totalBytes * 100, metadataPercentFull: null, metadataUnread: null, totalBytes, usedBytes },
    };
  }

  async plan(guest: Guest, signal?: AbortSignal): Promise<SnapshotPlan> {
    const facts = await this.#facts(guest, signal);
    const later = "This Docker backend does not offer this operation yet.";
    return {
      storage: facts.storage,
      take: { ok: !facts.refusal, why: facts.refusal, aboutMs: facts.estimate.pauseMs, memoryAboutMs: null, addsBytes: facts.estimate.addsBytes, memory: null, memoryWhy: "Docker snapshots hold the disk and Docker data only." },
      restore: { way: "none", why: later, undo: "none", undoAboutMs: 0, undoBytes: null, sizeBack: null, leavesOnEarlierGuest: 0, newer: 0, copyAboutMs: null },
      keep: { way: "no", why: later, aboutMs: null, bytes: null, price: null },
      fork: { ok: false, why: later, aboutMs: 0, bytes: null, size: null },
      locked: null,
      busy: facts.container.State.Paused ? "The box is already paused. Unpause it before taking a snapshot." : null,
    };
  }

  #key(id: string): string { return `docker-snapshot-take:${id}`; }

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
    let pauseAttempted = false;
    let committed = false;
    try {
      if (facts.container.State.Status === "running") {
        pauseAttempted = true;
        pausedAt = this.#now();
        await this.#cli.ok(["pause", guest.ref], { signal });
      }
      if (volume && facts.volume) {
        await this.#cli.ok(["volume", "create", ...Object.entries({ ...snapshotLabels(this.#context.installId, take.box, take.id), "bbbox.snapshot.started": String(state.startedAt), "bbbox.snapshot.estimate-ms": String(state.estimateMs), "bbbox.snapshot.container": guest.ref }).flatMap(([key, value]) => ["--label", `${key}=${value}`]), volume], { signal });
        await this.#cli.ok(["run", "--rm", "--name", `bbbox-snapshot-copy-${take.id}`, "--label", `bbbox.snapshot.install=${this.#context.installId}`, "--label", `bbbox.snapshot=${take.id}`, "--pull", "never", "--privileged", "--network", "none", "--entrypoint", "cp", "--volume", `${facts.volume}:/from:ro`, "--volume", `${volume}:/to`, facts.container.Image, "-a", "--reflink=auto", "/from/.", "/to/"], { signal, timeoutMs: 15 * 60_000 });
      }
      await this.#cli.ok(["container", "commit", "--pause=false", ...commitChanges(facts.container.Config.Labels, labels).flatMap((change) => ["--change", change]), guest.ref, image], { signal, timeoutMs: 15 * 60_000 });
      committed = true;
      return { ref: image, holds: "disk", capturedAt: state.startedAt, size: { bytes: facts.estimate.addsBytes, means: "own" } };
    } catch (error) {
      await this.#context.storage.set(this.#key(take.id), { ...state, phase: "failed" });
      await this.#discard(state);
      throw error;
    } finally {
      this.#active.delete(take.id);
      if (pauseAttempted && pausedAt !== null) {
        const current = (await this.#cli.inspect([guest.ref]))[0];
        if (current?.status === "paused" && current.labels[LABELS.install] === this.#context.installId && current.labels[LABELS.box] === take.box) await this.#cli.ok(["unpause", guest.ref]);
        this.#context.log?.(`Docker snapshot ${take.id} paused box ${take.box} for ${this.#now() - pausedAt} ms.`);
      }
      await this.#context.storage.set(this.#key(take.id), { ...state, phase: committed ? "complete" : "failed-resumed" });
    }
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
    await this.#discard(state);
    const container = (await this.#cli.inspect([state.container]))[0];
    if (container?.status === "paused" && container.labels[LABELS.install] === this.#context.installId && container.labels[LABELS.box] === state.box) await this.#cli.ok(["unpause", state.container]);
    await this.#context.storage.set(this.#key(state.id), { ...state, phase: "failed-resumed" });
    return { state: "failed", words: "The snapshot was interrupted. Its partial copy was removed and the box was unpaused." };
  }

  async #volumes(signal?: AbortSignal): Promise<readonly { Name: string; Labels: Record<string, string> }[]> {
    const names = (await this.#cli.ok(["volume", "ls", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`, "--format", "{{.Name}}"], { signal })).trim().split(/\s+/).filter(Boolean);
    return names.length ? snapshotVolumesSchema.parse(JSON.parse(await this.#cli.ok(["volume", "inspect", ...names], { signal }))) : [];
  }

  async listed(signal?: AbortSignal): Promise<readonly HeldSnapshot[]> {
    const ids = (await this.#cli.ok(["image", "ls", "--quiet", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`], { signal })).trim().split(/\s+/).filter(Boolean);
    const images = ids.length ? snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", ...new Set(ids)], { signal }))) : [];
    const volumes = await this.#volumes(signal);
    const volumesByName = new Map(volumes.map((volume) => [volume.Name, volume.Labels]));
    const result: HeldSnapshot[] = [];

    for (const image of images) {
      const labels = image.Config.Labels;
      if (labels[SNAPSHOT_INSTALL] !== this.#context.installId) continue;
      const id = labels["bbbox.snapshot"];
      const box = labels["bbbox.snapshot.box"];
      if (!id || !box || !image.RepoTags.includes(snapshotImage(this.#context.installId, box, id))) continue;
      const takenAt = Number(labels["bbbox.snapshot.taken"]);
      if (!Number.isFinite(takenAt) || takenAt <= 0) continue;
      const state = await this.#context.storage.get<TakeState>(this.#key(id));
      const volume = labels["bbbox.snapshot.volume"];
      const owned = volume ? volumesByName.get(volume) : null;
      const exists = !volume || (volume === snapshotVolume(id) && owned?.[SNAPSHOT_INSTALL] === this.#context.installId && owned["bbbox.snapshot"] === id && owned["bbbox.snapshot.box"] === box);
      result.push({
        id, box,
        ref: snapshotImage(this.#context.installId, box, id),
        owner: null,
        guest: { ref: state?.container ?? `bbbox-${box}`, host: null, address: null, size: null, data: { box } },
        where: "current",
        state: state?.phase.startsWith("failed") || !exists ? "incomplete" : this.#active.has(id) ? "in-progress" : "complete",
        words: state?.phase.startsWith("failed") ? "The snapshot's take failed." : exists ? null : "The snapshot's Docker data is missing.",
        holds: "disk",
        takenAt,
        keptUntil: null,
        storage: { name: "Docker's disk", type: `docker-${labels["bbbox.snapshot.store"]}` },
        forkSafe: Number(labels["bbbox.snapshot.reset"]) || null,
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
    const incomplete = (await this.listed(signal)).filter((held) => held.state === "incomplete");
    const dangling = (await this.#cli.ok(["image", "ls", "--quiet", "--filter", "dangling=true", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`], { signal })).trim().split(/\s+/).filter(Boolean);
    const deep: string[] = [];
    for (const container of containers) {
      const images = snapshotImagesSchema.parse(JSON.parse(await this.#cli.ok(["image", "inspect", container.imageId], { signal })));
      if ((images[0]?.RootFS.Layers.length ?? 0) >= 110) deep.push(container.name);
    }
    const facts = box ? await this.#facts({ ref: box.name, host: null, address: null, size: null, data: { box: box.labels[LABELS.box] } }, signal, false) : null;
    return [
      { id: "docker.snapshots", name: "Snapshots", status: facts ? facts.storage.percentFull >= 85 ? "warn" : "ok" : "skipped", detail: facts ? `${facts.store}: allow about ${facts.store === "containerd" ? "twice" : "once"} the changed disk bytes. ${facts.volume ? "Add the box's Docker data." : "This box has no Docker volume: snapshots hold its disk only."} Docker's disk is ${facts.storage.percentFull.toFixed(1)}% full.` : "Make a box to measure snapshot space on this engine.", fix: null },
      { id: "docker.snapshot-leftovers", name: "Snapshot leftovers", status: pending.length || incomplete.length || dangling.length ? "warn" : "ok", detail: pending.length || incomplete.length || dangling.length ? `${pending.length} snapshot tasks await recovery; ${incomplete.length} copies are incomplete; images without tags: ${dangling.length}. Maintenance unpauses interrupted takes after their time bound and prunes images no container uses.` : "No snapshot tasks await recovery.", fix: null },
      { id: "docker.snapshot-layers", name: "Snapshot layers", status: deep.length ? "warn" : "ok", detail: deep.length ? `Images near the layer limit: ${deep.join(", ")}. Make new boxes and move their files.` : "No box image has 110 or more layers.", fix: null },
    ];
  }

  async maintain(): Promise<void> {
    const complete = new Set((await this.listed()).filter((held) => held.state === "complete").map((held) => held.id));
    for (const volume of await this.#volumes()) {
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
      if (state && state.phase !== "complete") await this.settle({ ref: `take:${state.id}@${state.startedAt}`, host: null });
    }
    await this.#cli.ok(["image", "prune", "--force", "--filter", `label=${SNAPSHOT_INSTALL}=${this.#context.installId}`]);
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

  async remove(ref: SnapshotRef, hooks: SnapshotHooks, signal?: AbortSignal): Promise<void> {
    const held = (await this.listed(signal)).find((item) => item.id === ref.id && item.ref === ref.ref && item.box === ref.guest.data?.box);
    const box = ref.guest.data?.box;
    if (typeof box !== "string" || ref.ref !== snapshotImage(this.#context.installId, box, ref.id)) throw new Error("That snapshot does not belong to this box and install.");
    await hooks.submitting();
    if (held) {
      const removed = await this.#cli.run(["image", "rm", "--force", held.ref], { signal });
      if (removed.exitCode !== 0 && !/no such image/i.test(removed.stderr)) throw this.#cli.error("Deleting snapshot image", removed);
    }
    await this.#removeVolume(ref.id, box, signal);
    await this.#context.storage.delete(this.#key(ref.id));
  }
}
