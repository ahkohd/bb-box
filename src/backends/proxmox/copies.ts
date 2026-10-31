import { randomBytes } from "node:crypto";
import type { HeldCopyLabel } from "../types.ts";
import { INSTALL, templateTag } from "./owner.ts";

export const HELD_COPY = "held-copy";
export const EARLIER_GUEST = "earlier-guest";
const SNAPSHOT_TAG = "snapshot.";
const TAKEN_TAG = "taken.";
const KEPT_TAG = "kept.";
const PROXMOX_PREFIX = "BC:24:11";

export function heldCopyTags(installId: string, label: HeldCopyLabel, takenAt: number, template: number | null): string[] {
  return [
    "bb-box",
    `${INSTALL}${installId}`,
    HELD_COPY,
    `box.${label.box}`,
    `${SNAPSHOT_TAG}${label.snapshot}`,
    `${TAKEN_TAG}${Math.floor(takenAt / 1000)}`,
    ...(template !== null ? [templateTag(template)] : []),
    ...(label.kept ? [`${KEPT_TAG}${label.kept}`] : []),
  ];
}

export function heldCopyDescription(installId: string, label: HeldCopyLabel): string {
  return `bb-box install ${installId} box ${label.box} held copy of snapshot ${label.snapshot}${label.kept ? ` kept ${label.kept}` : ""}`;
}

export interface CopyTags {
  readonly box: string | null;
  readonly snapshot: string | null;
  readonly takenAt: number | null;
  readonly kept: string | null;
}

export function copyTags(tags: readonly string[]): CopyTags {
  const value = (prefix: string) => tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
  const taken = Number(value(TAKEN_TAG));
  return { box: value("box."), snapshot: value(SNAPSHOT_TAG), takenAt: Number.isFinite(taken) && taken > 0 ? taken * 1000 : null, kept: value(KEPT_TAG) };
}

export function isHeldCopy(tags: readonly string[]): boolean {
  return tags.includes(HELD_COPY);
}

export function isEarlierGuest(tags: readonly string[]): boolean {
  return tags.includes(EARLIER_GUEST);
}

export function randomMac(random: (bytes: number) => Uint8Array = (bytes) => randomBytes(bytes)): string {
  return `${PROXMOX_PREFIX}:${[...random(3)].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":")}`;
}

export function netKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config)
    .filter((key) => /^net\d+$/.test(key) && typeof config[key] === "string")
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

const QEMU_MODELS = new Set(["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "ne2k_pci", "pcnet", "i82551", "i82557b", "i82559er", "ne2k_isa"]);

export function macOf(value: string): string | null {
  for (const part of value.split(",")) {
    const [key, mac] = part.split("=");
    if (key && mac && (key === "hwaddr" || key === "macaddr" || QEMU_MODELS.has(key)) && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(mac)) return mac.toUpperCase();
  }
  return null;
}

export function netWith(value: string, change: { readonly mac?: string; readonly up: boolean }): string {
  const parts = value.split(",").filter((part) => part && !part.startsWith("link_down="));
  const next = parts.map((part) => {
    const [key, mac] = part.split("=");
    if (!change.mac || !key || !mac) return part;
    if (key === "hwaddr" || key === "macaddr" || QEMU_MODELS.has(key)) return `${key}=${change.mac}`;
    return part;
  });
  if (change.mac && !parts.some((part) => macOf(part) !== null)) next.push(`hwaddr=${change.mac}`);
  if (!change.up) next.push("link_down=1");
  return next.join(",");
}
