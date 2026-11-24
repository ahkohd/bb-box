import { PRODUCT } from "../../brand.ts";
import { quote } from "../../transports/process.ts";
import type { DoctorCheck } from "../types.ts";
import { VOLUME_CHECK, sections } from "./host.ts";
import { BASE_IN_USE, BASE_UNUSED, qemuScript } from "./qemu.ts";

const MACOS_BUILD_NEED_GIB = 60;
const WINDOWS_BUILD_NEED_GIB = 40;
const LINUX_BUILD_NEED_GIB = 20;
const KIB_PER_GIB = 1024 * 1024;
const KIB_PER_MIB = 1024;

export interface TartImageDiskUsage {
  readonly name: string;
  readonly kib: number;
}

export interface TartOciBaseUsage {
  readonly state: "tagged" | "old";
  readonly kib: number;
  readonly ref: string;
}

export interface TartWindowsBuildUsage {
  readonly build: string;
  readonly role: "current" | "rollback" | "refresh" | "old";
  readonly kib: number;
  readonly holders: readonly string[];
}

export interface TartImageStorageReport {
  readonly tartImages: readonly TartImageDiskUsage[];
  readonly ociBases: readonly TartOciBaseUsage[];
  readonly windowsBuilds: readonly TartWindowsBuildUsage[];
  readonly windowsUnreadable: boolean;
  readonly windowsNoSnapshotsDir: boolean;
}

export function tartImageStorageScript(tartImages: readonly string[], windowsImage: string | null): string {
  const tartList = tartImages.map((image) => quote(image)).join(" ");
  const tartSection = tartImages.length
    ? String.raw`echo @tart-images
for img in ${tartList}; do
  [ -d "$tart_vms/$img" ] || continue
  kib=$(du -sk "$tart_vms/$img" 2>/dev/null | awk 'NR == 1 { print $1 }')
  printf '%s %s\n' "$img" "${"$"}{kib:-0}"
done
`
    : "echo @tart-images\n";

  const ociSection = String.raw`echo @oci-bases
cache_root="${"$"}{TART_HOME:-$HOME/.tart}/cache/OCIs"
if [ -d "$cache_root" ]; then
  for copy in $(find "$cache_root" -type d -name 'sha256:*' -prune 2>/dev/null); do
    [ -d "$copy" ] || continue
    parent=$(dirname "$copy")
    digest=${"$"}{copy##*/}
    tagged=old
    for link in "$parent"/*; do
      [ -L "$link" ] || continue
      target=$(readlink "$link" 2>/dev/null || true)
      if [ "${"$"}{target##*/}" = "$digest" ]; then tagged=tagged; break; fi
    done
    kib=$(du -sk "$copy" 2>/dev/null | awk 'NR == 1 { print $1 }')
    rel=${"$"}{copy#"$cache_root"/}
    printf '%s %s %s\n' "$tagged" "${"$"}{kib:-0}" "$rel"
  done
fi
`;

  const windowsSection = windowsImage
    ? String.raw`echo @windows-builds
image=${quote(windowsImage)}; im="$q/images/$image"
if [ -d "$im" ]; then
  cur=$(cd "$im/current" 2>/dev/null && pwd -P) && cur=$(basename "$cur")
  rb=$(cd "$im/rollback" 2>/dev/null && pwd -P) && rb=$(basename "$rb")
  scan_ok=1
  snaps=$(snaps_dir_if_present 2>/dev/null) || { scan_ok=0; echo "unreadable=1"; snaps=; }
  if [ "$scan_ok" = 1 ]; then
    if ! readable_folder "$q/vms"; then
      scan_ok=0
      echo "unreadable=1"
    elif [ -z "$snaps" ]; then
      echo "no_snapshots_dir=1"
    elif ! readable_folder "$snaps"; then
      scan_ok=0
      echo "unreadable=1"
    elif [ ! -d "$snaps" ]; then
      echo "no_snapshots_dir=1"
    fi
  fi
  all_folders=
  if [ "$scan_ok" = 1 ]; then
    all_folders=$(folders_on_bases "$snaps" 2>/dev/null) || { scan_ok=0; echo "unreadable=1"; }
  fi
  for o in "$im"/*; do
    published_build "$o" || continue
    n=$(basename "$o")
    kib=$(du -sk "$o" 2>/dev/null | awk 'NR == 1 { print $1 }')
    if [ "$n" = "$cur" ]; then role=current
    elif [ "$n" = "$rb" ]; then role=rollback
    elif awaits_promotion "$o"; then role=refresh
    else role=old
    fi
    printf '=%s %s %s\n' "$n" "$role" "${"$"}{kib:-0}"
    if [ "$role" = old ] || [ "$role" = rollback ]; then
      if [ "$scan_ok" = 1 ]; then
        _ifs=$IFS; IFS='
'
        for _f in $all_folders; do
          IFS=$_ifs
          [ -n "$_f" ] || continue
          folder_stands_on "$_f" "$image" "$n"
          rc=$?
          if [ "$rc" -eq ${BASE_IN_USE} ]; then
            case "$_f" in
              "$q"/vms/*) printf 'holder=vm:%s\n' "$(basename "$_f")" ;;
              */vm) printf 'holder=snapshot:%s\n' "$(basename "$(dirname "$_f")")" ;;
              *) printf 'holder=restore:%s\n' "$(basename "$_f")" ;;
            esac
          elif [ "$rc" -ne ${BASE_UNUSED} ]; then
            echo "unreadable=1"
          fi
        done
        IFS=$_ifs
      fi
    fi
  done
fi
`
    : "echo @windows-builds\n";

  return qemuScript(`${VOLUME_CHECK}${tartSection}${ociSection}${windowsSection}`);
}

export function parseTartImageStorage(text: string): TartImageStorageReport {
  const parts = sections(text);
  const tartImages: TartImageDiskUsage[] = [];

  for (const raw of (parts.get("tart-images") ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [name, kibText] = line.split(/\s+/);
    const kib = Number(kibText);
    if (name && Number.isFinite(kib) && kib >= 0) {
      tartImages.push({ name, kib });
    }
  }

  const ociBases: TartOciBaseUsage[] = [];
  for (const raw of (parts.get("oci-bases") ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(tagged|old)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) {
      ociBases.push({ state: match[1] as "tagged" | "old", kib: Number(match[2]), ref: match[3]! });
    }
  }

  const windowsBuilds: { build: string; role: TartWindowsBuildUsage["role"]; kib: number; holders: string[] }[] = [];
  let windowsUnreadable = false;
  let windowsNoSnapshotsDir = false;

  for (const raw of (parts.get("windows-builds") ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "unreadable=1") {
      windowsUnreadable = true;
      continue;
    }
    if (line === "no_snapshots_dir=1") {
      windowsNoSnapshotsDir = true;
      continue;
    }

    const head = /^=(\S+)\s+(current|rollback|refresh|old)\s+(\d+)$/.exec(line);
    if (head) {
      windowsBuilds.push({
        build: head[1]!,
        role: head[2] as TartWindowsBuildUsage["role"],
        kib: Number(head[3]),
        holders: [],
      });
      continue;
    }

    const last = windowsBuilds.at(-1);
    if (last && line.startsWith("holder=")) {
      const holder = line.slice("holder=".length);
      if (holder && !last.holders.includes(holder)) last.holders.push(holder);
    }
  }

  return { tartImages, ociBases, windowsBuilds, windowsUnreadable, windowsNoSnapshotsDir };
}

function formatKiB(kib: number): string {
  if (kib >= KIB_PER_GIB) {
    const gib = kib / KIB_PER_GIB;
    return `${gib >= 100 ? Math.round(gib) : (Math.round(gib * 10) / 10).toFixed(1).replace(/\.0$/, "")} GiB`;
  }

  if (kib >= KIB_PER_MIB) {
    return `${Math.round(kib / KIB_PER_MIB)} MiB`;
  }

  return `${Math.round(kib)} KiB`;
}

function holderLabel(holder: string, owners: ReadonlyMap<string, Readonly<Record<string, string>>>): string {
  if (holder.startsWith("vm:")) {
    const vm = holder.slice("vm:".length);
    const owner = owners.get(vm);
    if (owner?.name) return `box ${owner.name}`;
    return `VM ${vm}`;
  }

  if (holder.startsWith("snapshot:")) {
    return `snapshot ${holder.slice("snapshot:".length)}`;
  }

  if (holder.startsWith("restore:")) {
    return `restore ${holder.slice("restore:".length)}`;
  }

  return holder;
}

export function tartBuildNeedGiB(input: { readonly hasMacos: boolean; readonly hasWindows: boolean }): number {
  if (input.hasMacos) return MACOS_BUILD_NEED_GIB;
  if (input.hasWindows) return WINDOWS_BUILD_NEED_GIB;
  return LINUX_BUILD_NEED_GIB;
}

export function tartImageStorageCheck(input: {
  readonly hostName: string;
  readonly windowsImage: string | null;
  readonly hasMacos: boolean;
  readonly diskFreeGiB: number;
  readonly reserveDiskGiB: number;
  readonly owners: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly report: TartImageStorageReport;
}): DoctorCheck {
  const { hostName, windowsImage, hasMacos, diskFreeGiB, reserveDiskGiB, owners, report } = input;
  const details: string[] = [];
  const fixes: string[] = [];
  let status: DoctorCheck["status"] = "ok";

  const imageDescriptions: string[] = report.tartImages.map((image) => `${image.name} (${formatKiB(image.kib)})`);
  const currentWindows = report.windowsBuilds.find((build) => build.role === "current");
  if (windowsImage && currentWindows) {
    imageDescriptions.push(`${windowsImage} ${currentWindows.build} (${formatKiB(currentWindows.kib)})`);
  }

  if (imageDescriptions.length) {
    const totalKiB =
      report.tartImages.reduce((sum, image) => sum + image.kib, 0) +
      (currentWindows ? currentWindows.kib : 0);
    details.push(`${imageDescriptions.length} ${imageDescriptions.length === 1 ? "image" : "images"} (${formatKiB(totalKiB)}): ${imageDescriptions.join(", ")}.`);
  } else {
    details.push(`No configured images found on ${hostName}.`);
  }

  const rollback = report.windowsBuilds.find((build) => build.role === "rollback");
  if (rollback) {
    const holders = rollback.holders.map((holder) => holderLabel(holder, owners));
    const heldBy = holders.length ? `, used by ${holders.join(", ")}` : "";
    details.push(`Windows rollback ${rollback.build} (${formatKiB(rollback.kib)}${heldBy}) kept.`);
  }

  const oldWindows = report.windowsBuilds.filter((build) => build.role === "old");
  if (oldWindows.length) {
    const described = oldWindows.map((build) => {
      const holders = build.holders.map((holder) => holderLabel(holder, owners));
      const why = holders.length ? `used by ${holders.join(", ")}` : "nothing stands on it; upkeep removes it";
      return `${build.build} (${formatKiB(build.kib)}, ${why})`;
    });
    details.push(`${oldWindows.length} earlier Windows ${oldWindows.length === 1 ? "build" : "builds"} kept: ${described.join("; ")}.`);
  } else if (windowsImage) {
    details.push("No earlier Windows builds are kept beyond rollback.");
  }

  if (report.windowsUnreadable) {
    status = "warn";
    details.push(`Could not read the config of every Windows VM, snapshot and restore on ${hostName} to tell which builds they stand on.`);
    fixes.push(`Check folder permissions under ~/.bb-box/qemu/vms and Tart's snapshot folder on ${hostName}.`);
  } else if (report.windowsNoSnapshotsDir) {
    details.push("No snapshots yet.");
  }

  const taggedBases = report.ociBases.filter((base) => base.state === "tagged");
  const oldBases = report.ociBases.filter((base) => base.state === "old");
  if (taggedBases.length || oldBases.length) {
    const baseParts: string[] = [];
    if (taggedBases.length) {
      const kib = taggedBases.reduce((sum, base) => sum + base.kib, 0);
      baseParts.push(`${taggedBases.length} cached ${taggedBases.length === 1 ? "base" : "bases"} (${formatKiB(kib)})`);
    }
    if (oldBases.length) {
      const kib = oldBases.reduce((sum, base) => sum + base.kib, 0);
      baseParts.push(`${oldBases.length} old untagged ${oldBases.length === 1 ? "base" : "bases"} (${formatKiB(kib)})`);
    }
    details.push(`Tart OCI cache: ${baseParts.join(", ")}.`);
  }

  const needGiB = tartBuildNeedGiB({ hasMacos, hasWindows: Boolean(windowsImage) });
  const spareGiB = diskFreeGiB - reserveDiskGiB;
  if (spareGiB < needGiB) {
    status = "warn";
    details.push(
      `${hostName} has ${diskFreeGiB} GiB free (${spareGiB} GiB beyond the ${reserveDiskGiB} GiB reserve), below the ${needGiB} GiB a build needs.`,
    );
    const actions: string[] = [];
    if (oldWindows.some((build) => build.holders.length > 0)) {
      actions.push("release Windows boxes holding earlier builds so upkeep removes them");
    }
    if (oldBases.length) {
      actions.push("prune old cached OCI bases with tart prune --entries caches");
    }
    actions.push(`free disk space on the Mac or lower the disk kept free in ${PRODUCT}'s settings`);
    fixes.push(`Make room on ${hostName}: ${actions.join(", or ")}.`);
  } else {
    details.push(`${hostName} has ${diskFreeGiB} GiB free (${spareGiB} GiB beyond the ${reserveDiskGiB} GiB reserve; a build needs about ${needGiB} GiB).`);
  }

  return {
    id: `image-storage.${hostName}`,
    name: `Image storage on ${hostName}`,
    status,
    detail: details.join(" "),
    fix: fixes.length ? fixes.join(" ") : null,
  };
}
