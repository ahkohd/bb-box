import { PRODUCT } from "../../brand.ts";
import { recordFromJson } from "../images.ts";
import type { DoctorCheck } from "../types.ts";
import { DockerCli, LABELS, snapshotImagesSchema, type ContainerInfo } from "./cli.ts";
import { DOCKER_KINDS, type DockerConfig } from "./config.ts";
import { SNAPSHOT_LABEL } from "./snapshots.ts";

const LINUX_BUILD_NEED_GB = 10;
const DESKTOP_BUILD_NEED_GB = 18;
const BYTES_PER_GB = 1_000_000_000;
const BYTES_PER_MB = 1_000_000;
const BYTES_PER_KB = 1024;
const INSPECT_TIMEOUT_MS = 30_000;
const DISK_PROBE_TIMEOUT_MS = 15_000;

export interface DockerBuildNeed {
  readonly gb: number;
  readonly kb: number;
  readonly what: string;
}

export interface DockerSystemDfEntry {
  readonly type: string;
  readonly size: string;
  readonly reclaimable: string;
}

export interface KeptDockerBuild {
  readonly id: string;
  readonly label: string;
  readonly sizeBytes: number;
  readonly containers: readonly string[];
}

export function nextBuildNeed(images: DockerConfig["images"]): DockerBuildNeed {
  const hasDesktop = Boolean(images["linux-desktop"] || images["linux-desktop-cpu"]);
  const hasWayland = Boolean(images["linux-desktop-wayland-cpu"]);

  if (hasDesktop) {
    return { gb: DESKTOP_BUILD_NEED_GB, kb: Math.floor((DESKTOP_BUILD_NEED_GB * BYTES_PER_GB) / BYTES_PER_KB), what: "the desktop image" };
  }

  if (hasWayland) {
    return { gb: DESKTOP_BUILD_NEED_GB, kb: Math.floor((DESKTOP_BUILD_NEED_GB * BYTES_PER_GB) / BYTES_PER_KB), what: "the desktop-wayland image" };
  }

  return { gb: LINUX_BUILD_NEED_GB, kb: Math.floor((LINUX_BUILD_NEED_GB * BYTES_PER_GB) / BYTES_PER_KB), what: "the linux image" };
}

export function parseSystemDf(text: string): DockerSystemDfEntry[] {
  const entries: DockerSystemDfEntry[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.Type === "string" && typeof parsed.Size === "string") {
        entries.push({
          type: parsed.Type,
          size: parsed.Size,
          reclaimable: typeof parsed.Reclaimable === "string" ? parsed.Reclaimable : "",
        });
      }
    } catch {
      continue;
    }
  }

  return entries;
}

export function parseRootFreeKb(text: string): number | null {
  for (const raw of text.split("\n")) {
    const columns = raw.trim().split(/\s+/);
    if (columns.length >= 6 && columns.at(-1) === "/" && /^\d+$/.test(columns[3] ?? "")) {
      return Number(columns[3]);
    }
  }

  return null;
}

function formatDecimalBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) {
    const gb = bytes / BYTES_PER_GB;
    return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }

  if (bytes >= BYTES_PER_MB) {
    return `${Math.round(bytes / BYTES_PER_MB)} MB`;
  }

  return `${Math.max(0, Math.round(bytes / 1000))} KB`;
}

function isZeroSize(value: string): boolean {
  return /^0(?:\.0+)?\s*[KMGT]?i?B$/i.test(value.trim());
}

function isOwnedImage(labels: Readonly<Record<string, string>>, installId: string): boolean {
  if (SNAPSHOT_LABEL in labels) return false;
  if (labels[LABELS.install] === installId && LABELS.image in labels) return true;
  if (LABELS.imageVersion in labels && (!(LABELS.install in labels) || labels[LABELS.install] === installId)) return true;
  return false;
}

function isUntagged(repoTags: readonly string[]): boolean {
  return repoTags.every((tag) => tag === "<none>:<none>");
}

function shortImageId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function buildLabelOf(id: string, labels: Readonly<Record<string, string>>): string {
  const shortId = shortImageId(id);
  const record = recordFromJson(labels[LABELS.imageRecord]);
  if (record?.build) return `${record.build} (${shortId})`;

  const image = labels[LABELS.image];
  if (image && image !== "standard") return `${image} (${shortId})`;
  return shortId;
}

async function listImageRefs(cli: DockerCli, filters: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const args = ["image", "ls", "--quiet", "--no-trunc", ...filters.flatMap((filter) => ["--filter", filter])];
  const output = await cli.ok(args, { timeoutMs: INSPECT_TIMEOUT_MS, signal });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function containersHoldingImage(
  cli: DockerCli,
  imageId: string,
  knownContainers: readonly ContainerInfo[],
  signal?: AbortSignal,
): Promise<{ readonly names: readonly string[]; readonly unreadable: boolean }> {
  const matched = knownContainers.filter((container) => container.imageId === imageId);
  const byId = new Map<string, string>();

  for (const container of matched) {
    byId.set(container.id, container.labels[LABELS.name] || container.name);
  }

  const listed = await cli.run(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `ancestor=${imageId}`], {
    timeoutMs: INSPECT_TIMEOUT_MS,
    signal,
  }).catch(() => null);

  if (!listed || listed.exitCode !== 0) {
    return { names: [...byId.values()], unreadable: true };
  }

  const extraIds = listed.stdout.split("\n").map((line) => line.trim()).filter((id) => id && !byId.has(id));
  if (extraIds.length) {
    const inspected = await cli.inspect(extraIds, signal).catch(() => null);
    if (!inspected) return { names: [...byId.values()], unreadable: true };

    for (const container of inspected) {
      if (container.imageId !== imageId) continue;
      byId.set(container.id, container.labels[LABELS.name] || container.name);
    }
  }

  return { names: [...byId.values()], unreadable: false };
}

function describeKeptBuild(build: KeptDockerBuild): string {
  const size = formatDecimalBytes(build.sizeBytes);
  if (!build.containers.length) return `${build.label} (${size}, no container uses it; upkeep removes it)`;

  const noun = build.containers.length === 1 ? "container" : "containers";
  return `${build.label} (${size}, used by ${noun} ${build.containers.join(", ")})`;
}

export async function doctorDockerImageStorage(input: {
  readonly cli: DockerCli;
  readonly installId: string;
  readonly images: DockerConfig["images"];
  readonly existingImages: readonly string[];
  readonly containers: readonly ContainerInfo[];
  readonly hostName: string;
  readonly signal?: AbortSignal;
}): Promise<DoctorCheck> {
  const { cli, installId, images, existingImages, containers, hostName, signal } = input;
  const need = nextBuildNeed(images);
  const probeImage = DOCKER_KINDS.map((kind) => images[kind]).find((image): image is string => image !== null && existingImages.includes(image)) ?? existingImages[0] ?? null;

  const [standardRefs, projectRefs, danglingStandard, danglingProject, dfResult, diskResult] = await Promise.all([
    listImageRefs(cli, [`label=${LABELS.imageVersion}`, `label!=${SNAPSHOT_LABEL}`], signal).catch(() => null),
    listImageRefs(cli, [`label=${LABELS.install}=${installId}`, `label=${LABELS.image}`, `label!=${SNAPSHOT_LABEL}`], signal).catch(() => null),
    listImageRefs(cli, ["dangling=true", `label=${LABELS.imageVersion}`, `label!=${LABELS.install}`, `label!=${SNAPSHOT_LABEL}`], signal).catch(() => null),
    listImageRefs(cli, ["dangling=true", `label=${LABELS.install}=${installId}`, `label=${LABELS.image}`, `label!=${SNAPSHOT_LABEL}`], signal).catch(() => null),
    cli.run(["system", "df", "--format", "{{json .}}"], { timeoutMs: INSPECT_TIMEOUT_MS, signal }).catch(() => null),
    probeImage
      ? cli.run(["container", "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "/bin/sh", probeImage, "-c", "df -Pk /"], {
          timeoutMs: DISK_PROBE_TIMEOUT_MS,
          signal,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const unread: string[] = [];
  const details: string[] = [];
  const fixes: string[] = [];
  let status: DoctorCheck["status"] = "ok";

  const imageListsOk = standardRefs !== null && projectRefs !== null && danglingStandard !== null && danglingProject !== null;
  let keptBuilds: KeptDockerBuild[] = [];

  if (!imageListsOk) {
    status = "warn";
    unread.push(`${PRODUCT}'s Docker images`);
  } else {
    const refs = [...new Set([...standardRefs, ...projectRefs, ...danglingStandard, ...danglingProject])];
    const inspected = refs.length
      ? await cli.run(["image", "inspect", ...refs], { timeoutMs: INSPECT_TIMEOUT_MS, signal }).catch(() => null)
      : { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };

    if (!inspected || inspected.exitCode !== 0) {
      status = "warn";
      unread.push(`${PRODUCT}'s Docker image details`);
    } else {
      let parsedImages: ReturnType<typeof snapshotImagesSchema.parse> | null = null;
      try {
        parsedImages = snapshotImagesSchema.parse(JSON.parse(inspected.stdout || "[]"));
      } catch {
        parsedImages = null;
      }

      if (!parsedImages) {
        status = "warn";
        unread.push(`${PRODUCT}'s Docker image details`);
      } else {
        const uniqueById = new Map<string, (typeof parsedImages)[number]>();
        for (const image of parsedImages) {
          if (isOwnedImage(image.Config.Labels, installId)) uniqueById.set(image.Id, image);
        }

        const owned = [...uniqueById.values()];
        const totalBytes = owned.reduce((sum, image) => sum + image.Size, 0);
        const untagged = owned.filter((image) => isUntagged(image.RepoTags));

        details.push(
          owned.length
            ? `${PRODUCT}'s ${owned.length} ${owned.length === 1 ? "image totals" : "images total"} ${formatDecimalBytes(totalBytes)}.`
            : `No ${PRODUCT} images are on ${hostName}.`,
        );

        let containersUnreadable = false;
        keptBuilds = await Promise.all(
          untagged.map(async (image) => {
            const holders = await containersHoldingImage(cli, image.Id, containers, signal);
            if (holders.unreadable) containersUnreadable = true;
            return {
              id: image.Id,
              label: buildLabelOf(image.Id, image.Config.Labels),
              sizeBytes: image.Size,
              containers: holders.names,
            };
          }),
        );

        if (containersUnreadable) {
          status = "warn";
          unread.push("containers holding earlier untagged builds");
        }

        if (keptBuilds.length) {
          details.push(
            `${keptBuilds.length} earlier untagged ${keptBuilds.length === 1 ? "build" : "builds"} kept: ${keptBuilds.map(describeKeptBuild).join("; ")}.`,
          );
        } else {
          details.push("No earlier untagged builds are kept.");
        }
      }
    }
  }

  let buildCacheEntry: DockerSystemDfEntry | null = null;
  if (dfResult && dfResult.exitCode === 0) {
    buildCacheEntry = parseSystemDf(dfResult.stdout).find((entry) => entry.type === "Build Cache") ?? null;
  }

  if (buildCacheEntry) {
    const reclaimable = buildCacheEntry.reclaimable && !isZeroSize(buildCacheEntry.reclaimable) ? ` (${buildCacheEntry.reclaimable} reclaimable)` : "";
    details.push(`Build cache takes ${buildCacheEntry.size}${reclaimable}.`);
  } else {
    status = "warn";
    unread.push("Docker's build cache size");
  }

  const freeKb = diskResult && diskResult.exitCode === 0 ? parseRootFreeKb(diskResult.stdout) : null;
  if (freeKb === null) {
    status = "warn";
    unread.push(`free disk space on ${hostName}`);
  } else {
    const freeBytes = freeKb * BYTES_PER_KB;
    const freeWords = formatDecimalBytes(freeBytes);
    if (freeKb < need.kb) {
      status = "warn";
      details.push(`${hostName} has ${freeWords} free on Docker's disk, below the ${need.gb} GB building ${need.what} needs.`);

      const actions: string[] = [];
      if (buildCacheEntry && !isZeroSize(buildCacheEntry.size)) {
        actions.push("prune Docker's build cache with docker builder prune --filter until=24h");
      }
      if (keptBuilds.some((build) => build.containers.length > 0)) {
        actions.push("release boxes or remove containers holding earlier untagged builds so upkeep prunes them");
      }
      if (!actions.length) {
        actions.push("prune unused build cache with docker builder prune or free space on the Docker host");
      }
      fixes.push(`Free space on ${hostName}: ${actions.join(", or ")}.`);
    } else {
      details.push(`${hostName} has ${freeWords} free on Docker's disk (building ${need.what} needs about ${need.gb} GB).`);
    }
  }

  if (unread.length) {
    details.push(`Could not read ${unread.join(", ")}.`);
    if (!fixes.length) {
      fixes.push(`Check that ${PRODUCT} can reach Docker on ${hostName} and has a box image there, then run the doctor again.`);
    }
  }

  return {
    id: "docker.image-storage",
    name: "Image storage",
    status,
    detail: details.join(" "),
    fix: fixes.length ? fixes.join(" ") : null,
  };
}
