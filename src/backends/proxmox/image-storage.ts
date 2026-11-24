import { PRODUCT } from "../../brand.ts";
import type { DoctorCheck } from "../types.ts";
import { parseTags, type GuestType, type PoolGuest } from "./api.ts";
import { isEarlierGuest, isHeldCopy } from "./copies.ts";
import { BUILD, buildFromTags, builtAt, installFromTags, installTag, isTemplate, namesOf } from "./owner.ts";

export const BUILD_LEFTOVER_MS = 4 * 60 * 60_000;

const MIN_BUILD_NEED_GIB = 16;
const NON_BUILD_ROLES = new Set(["warm", "filling", "retired", "image-box"]);
const NON_BUILD_PREFIXES = ["box.", "thread.", "template.", "image.", "kind."];

export interface ProxmoxTemplateUsage {
  readonly vmid: number;
  readonly storage: string | null;
  readonly diskGiB: number | null;
}

export interface ProxmoxStorageReading {
  readonly availableGiB: number;
  readonly totalGiB: number;
  readonly type: string;
}

export interface LeftoverBuildGuest {
  readonly vmid: number;
  readonly name: string;
  readonly status: string;
  readonly build: string;
  readonly ageMs: number;
  readonly install: string | null;
}

function hasNonBuildRoleTag(tags: readonly string[]): boolean {
  if (isHeldCopy(tags) || isEarlierGuest(tags)) return true;
  return tags.some((tag) => NON_BUILD_ROLES.has(tag) || NON_BUILD_PREFIXES.some((prefix) => tag.startsWith(prefix)));
}

export function leftoverBuildOf(
  guest: PoolGuest,
  type: GuestType,
  configuredTemplates: ReadonlySet<number>,
  activeVmids: ReadonlySet<number>,
  now: number,
): LeftoverBuildGuest | null {
  if (guest.type !== type || guest.template) return null;
  if (configuredTemplates.has(guest.vmid) || activeVmids.has(guest.vmid)) return null;
  if (hasNonBuildRoleTag(guest.tags)) return null;

  const build = buildFromTags(guest.tags);
  const startedAt = build ? builtAt(build) : null;
  if (!build || startedAt === null || now - startedAt < BUILD_LEFTOVER_MS) return null;

  return {
    vmid: guest.vmid,
    name: guest.name,
    status: guest.status,
    build: `${BUILD}${build}`,
    ageMs: now - startedAt,
    install: installFromTags(guest.tags),
  };
}

export function isOwnedBuildWorkConfig(config: Record<string, unknown>, installId: string, now: number): boolean {
  if (isTemplate(config)) return false;

  const tags = parseTags(config.tags);
  if (installFromTags(tags) !== installId) return false;
  if (namesOf(config).box !== null) return false;
  if (hasNonBuildRoleTag(tags)) return false;

  const build = buildFromTags(tags);
  const startedAt = build ? builtAt(build) : null;
  return startedAt !== null && now - startedAt >= BUILD_LEFTOVER_MS;
}

function formatGiB(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} GiB`;
}

function ageWords(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} old`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} old`;
}

function guestLabel(type: GuestType, vmid: number): string {
  return `${type === "lxc" ? "CT" : "VM"} ${vmid}`;
}

function removeCommand(type: GuestType, vmid: number): string {
  return type === "lxc" ? `pct stop ${vmid}; pct destroy ${vmid}` : `qm stop ${vmid}; qm destroy ${vmid} --purge 1`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function proxmoxImageStorageCheck(input: {
  readonly type: GuestType;
  readonly installId: string;
  readonly reserveDiskGiB: number;
  readonly templates: readonly ProxmoxTemplateUsage[];
  readonly storages: ReadonlyMap<string, ProxmoxStorageReading | Error>;
  readonly guests: readonly PoolGuest[] | Error;
  readonly configuredTemplates: ReadonlySet<number>;
  readonly activeVmids: ReadonlySet<number>;
  readonly now: number;
}): DoctorCheck {
  const { type, installId, reserveDiskGiB, templates, storages, guests, configuredTemplates, activeVmids, now } = input;
  const guestPlural = type === "lxc" ? "containers" : "VMs";
  const details: string[] = [];
  const fixes: string[] = [];
  let status: DoctorCheck["status"] = "ok";

  const install = installTag(installId);
  const extraTemplates =
    guests instanceof Error
      ? []
      : guests.filter(
          (guest) =>
            guest.type === type &&
            guest.template &&
            !configuredTemplates.has(guest.vmid) &&
            guest.tags.includes(install) &&
            guest.tags.some((tag) => tag.startsWith("image.")),
        );

  if (!templates.length && !extraTemplates.length) {
    details.push(`No ${PRODUCT} templates are configured.`);
  } else {
    const knownDiskGiB =
      templates.reduce((sum, template) => sum + (template.diskGiB ?? 0), 0) +
      extraTemplates.reduce((sum, guest) => sum + (guest.size?.diskGiB ?? 0), 0);

    const templateParts = templates.map((template) => {
      const size = template.diskGiB !== null ? formatGiB(template.diskGiB) : "size unread";
      const where = template.storage ? ` on ${template.storage}` : "";
      return `${guestLabel(type, template.vmid)} (${size}${where})`;
    });

    const extraParts = extraTemplates.map((guest) => {
      const role = guest.tags.includes("image.rollback") ? "rollback" : guest.tags.find((tag) => tag.startsWith("image."))?.slice(6) ?? "image";
      const size = guest.size?.diskGiB != null ? `, ${formatGiB(guest.size.diskGiB)}` : "";
      return `${guestLabel(type, guest.vmid)} (${role}${size})`;
    });

    const allParts = [...templateParts, ...extraParts];
    const totalCount = templates.length + extraTemplates.length;
    const totalWord = knownDiskGiB > 0 ? `, ${formatGiB(knownDiskGiB)} configured` : "";
    details.push(`${totalCount} ${totalCount === 1 ? "template" : "templates"}${totalWord}: ${allParts.join(", ")}.`);
  }

  if (guests instanceof Error) {
    status = "warn";
    details.push(`Could not list pool guests to check for leftover build ${guestPlural}: ${errorMessage(guests)}.`);
  } else {
    const leftovers = guests
      .map((guest) => leftoverBuildOf(guest, type, configuredTemplates, activeVmids, now))
      .filter((guest): guest is LeftoverBuildGuest => guest !== null);

    const ownedLeftovers = leftovers.filter((guest) => guest.install === installId);
    const untaggedLeftovers = leftovers.filter((guest) => guest.install === null);

    if (ownedLeftovers.length) {
      status = "warn";
      const listed = ownedLeftovers.map((guest) => `${guestLabel(type, guest.vmid)} (${guest.build}, ${ageWords(guest.ageMs)})`).join(", ");
      details.push(`${ownedLeftovers.length} leftover build ${ownedLeftovers.length === 1 ? (type === "lxc" ? "container" : "VM") : guestPlural} of this install: ${listed}. Upkeep removes ${ownedLeftovers.length === 1 ? "it" : "them"}.`);
      fixes.push(`Wait for ${PRODUCT}'s next upkeep pass, or remove ${ownedLeftovers.map((guest) => guestLabel(type, guest.vmid)).join(", ")} on the host.`);
    }

    if (untaggedLeftovers.length) {
      status = "warn";
      const listed = untaggedLeftovers.map((guest) => `${guestLabel(type, guest.vmid)} (${guest.build}, ${ageWords(guest.ageMs)})`).join(", ");
      details.push(
        `${untaggedLeftovers.length} leftover build ${untaggedLeftovers.length === 1 ? (type === "lxc" ? "container" : "VM") : guestPlural} with no install tag: ${listed}. ` +
          `build.sh puts no install tag on build ${guestPlural}, so ${PRODUCT} leaves ${untaggedLeftovers.length === 1 ? "it" : "them"} alone.`,
      );
      fixes.push(`Remove leftover build ${guestPlural} on the Proxmox host as root: ${untaggedLeftovers.map((guest) => removeCommand(type, guest.vmid)).join(" ; ")}.`);
    }

    if (!ownedLeftovers.length && !untaggedLeftovers.length) {
      details.push(`No leftover build ${guestPlural}.`);
    }
  }

  const byStorage = new Map<string, number>();
  for (const template of templates) {
    if (!template.storage) continue;
    const currentNeed = byStorage.get(template.storage) ?? MIN_BUILD_NEED_GIB;
    const diskNeed = template.diskGiB !== null ? Math.ceil(template.diskGiB) : MIN_BUILD_NEED_GIB;
    byStorage.set(template.storage, Math.max(currentNeed, diskNeed));
  }

  for (const [storageName, needGiB] of byStorage) {
    const reading = storages.get(storageName);
    if (!reading || reading instanceof Error) {
      status = "warn";
      const why = reading instanceof Error ? `: ${errorMessage(reading)}` : "";
      details.push(`Could not read free space on ${storageName}${why}.`);
      continue;
    }

    const spareGiB = reading.availableGiB - reserveDiskGiB;
    if (spareGiB < needGiB) {
      status = "warn";
      details.push(
        `${storageName} has ${reading.availableGiB} GiB free (${spareGiB} GiB beyond the ${reserveDiskGiB} GiB reserve), below the ${needGiB} GiB a build needs.`,
      );
      fixes.push(`Free space on ${storageName}, release boxes, or lower the disk kept free in ${PRODUCT}'s settings.`);
    } else {
      details.push(
        `${storageName} has ${reading.availableGiB} GiB free (${spareGiB} GiB beyond the ${reserveDiskGiB} GiB reserve; a build needs about ${needGiB} GiB).`,
      );
    }
  }

  return {
    id: "proxmox.image-storage",
    name: "Image storage",
    status,
    detail: details.join(" "),
    fix: fixes.length ? fixes.join(" ") : null,
  };
}
