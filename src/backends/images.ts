/**
 * An image's record (049): /usr/share/bb-box/image.json in every image bb-box
 * starts boxes from, and a copy outside it that can be read without starting
 * it, such as an LXC template's description. The doctor judges each image by
 * it: how old it is, what is in it, and what it was built with.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The contract an image must keep (049); a record with an older one fails the doctor. */
export const IMAGE_CONTRACT = 1;

export interface ImageRecord {
  readonly contract: number;
  /** "standard", or a project's image's name. */
  readonly image: string;
  /** What the image is for, such as "linux-desktop-cpu". */
  readonly kind: string;
  readonly arch: string;
  /** The build's ID, such as "build.20261003-021500-3f9c". */
  readonly build: string;
  /** When it was built, as an ISO 8601 time. */
  readonly built: string;
  /** The standard image's build, for a project's image. */
  readonly base: string | null;
  readonly os: string;
  readonly aptSnapshot: string | null;
  /** The SHA-256 of the pins it was built with. */
  readonly pins: string;
  /** The SHA-256 of BB's host app in it, or null for none. */
  readonly bbApp: string | null;
  /** Each tool's version, such as {"node": "24.21.0"}. */
  readonly tools: Readonly<Record<string, string>>;
  /** The NVIDIA userspace's version, where the image has one. */
  readonly nvidia: string | null;
  /** A project's image's script, and how long it ran. */
  readonly layer: { readonly sha256: string; readonly seconds: number } | null;
  readonly sizeGiB: number | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A record from its JSON, or null when it is not one. */
export function parseImageRecord(value: unknown): ImageRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = text(record.kind);
  const build = text(record.build);
  const built = text(record.built);
  if (typeof record.contract !== "number" || !Number.isInteger(record.contract) || !kind || !build || !built || Number.isNaN(Date.parse(built))) return null;
  const tools = typeof record.tools === "object" && record.tools !== null && !Array.isArray(record.tools) ? record.tools : {};
  const layer = record.layer as { sha256?: unknown; seconds?: unknown } | null;
  return {
    contract: record.contract,
    image: text(record.image) ?? "standard",
    kind,
    arch: text(record.arch) ?? "",
    build,
    built,
    base: text(record.base),
    os: text(record.os) ?? "",
    aptSnapshot: text(record.aptSnapshot),
    pins: text(record.pins) ?? "",
    bbApp: text(record.bbApp),
    tools: Object.fromEntries(Object.entries(tools).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    nvidia: text(record.nvidia),
    layer:
      layer && typeof layer === "object" && typeof layer.sha256 === "string" && typeof layer.seconds === "number"
        ? { sha256: layer.sha256, seconds: layer.seconds }
        : null,
    sizeGiB: typeof record.sizeGiB === "number" ? record.sizeGiB : null,
  };
}

/** A record from its JSON text, as a Docker label holds it, or null when it is not one. */
export function recordFromJson(text: unknown): ImageRecord | null {
  if (typeof text !== "string" || !text.trim().startsWith("{")) return null;
  try {
    return parseImageRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The record a description carries as its last line that is a JSON object, as build.sh writes it, or null. */
export function recordInDescription(description: string): ImageRecord | null {
  const line = description
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  return recordFromJson(line);
}

/**
 * The pins an image is built with: a Linux image's, or a desktop's, which
 * adds the desktop's; a macOS image's on a Mac; a Windows template's on
 * Proxmox, or a Windows image's on a Mac.
 */
export type PinSet = "linux" | "linux-desktop" | "macos" | "windows" | "windows-arm64";

/**
 * What each set's digest covers, under setup/: Linux's are files in
 * proxmox-lxc/template/, in order, as image-record.sh reads them. The others
 * are a build script's pin lines, NAME_VERSION=, NAME_SHA256= and NAME_URL=,
 * in the order the script has them, as the script itself hashes them.
 */
const PINS: Readonly<Record<PinSet, { readonly files: readonly string[] } | { readonly lines: string }>> = {
  linux: { files: ["proxmox-lxc/template/pins.json", "proxmox-lxc/template/apt-snapshot"] },
  "linux-desktop": { files: ["proxmox-lxc/template/pins.json", "proxmox-lxc/template/apt-snapshot", "proxmox-lxc/template/desktop-pins.tsv"] },
  macos: { lines: "tart/prepare-image.sh" },
  windows: { lines: "proxmox-qemu/build.sh" },
  "windows-arm64": { lines: "tart/prepare-windows-image.sh" },
};

/** A build script's pin lines, as `grep -E '^[A-Z0-9_]+_(VERSION|SHA256|URL)='` prints them. */
export function pinLines(script: string): string {
  return script
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+_(VERSION|SHA256|URL)=/.test(line))
    .map((line) => `${line}\n`)
    .join("");
}

/** The SHA-256 of a set of pins in `setup`, the plugin's setup/ directory, as an image built with them records it, or null when a file is missing. */
export async function pinsDigest(setup: string, set: PinSet): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    const pins = PINS[set];
    if ("files" in pins) for (const file of pins.files) hash.update(await readFile(join(setup, file)));
    else hash.update(pinLines(await readFile(join(setup, pins.lines), "utf8")));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** What bb-box knows now to judge an image by. Each is null when it cannot tell. */
export interface ImageFacts {
  /** The SHA-256 of the pins this bb-box builds a set of images with. */
  pins(set: PinSet): Promise<string | null>;
  /** The SHA-256 of BB's host app that BB's server gives now. */
  bbApp(signal?: AbortSignal): Promise<string | null>;
}

/** Days after which an image warns: twice the interval it is rebuilt at, a week for Linux and a month for Windows and macOS. */
export const STALE_DAYS: Readonly<Record<"linux" | "windows" | "macos", number>> = { linux: 14, windows: 60, macos: 60 };

/** The Node.js BB's Windows installer needs (#539). */
const WINDOWS_NODE = "22.19.0";
/** The agent CLIs a Windows image carries for BB's threads, as its record names them, with their names (#561). */
const AGENT_CLIS: readonly (readonly [string, string])[] = [
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["pi", "Pi"],
];

/** Whether version `have`, such as 24.21.0 or v24.21.0, is at least `want`. */
function atLeast(have: string, want: string): boolean {
  const parts = (version: string) => version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(have), parts(want)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export interface ImageJudgement {
  readonly status: "ok" | "warn" | "fail";
  /** What the image is, then what is wrong with it. */
  readonly detail: string;
  readonly fix: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function day(time: number, now: number): string {
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", timeZone: "UTC" };
  if (new Date(time).getUTCFullYear() !== new Date(now).getUTCFullYear()) options.year = "numeric";
  return new Date(time).toLocaleDateString("en-GB", options);
}

function ago(days: number): string {
  return days < 1 ? "today" : days < 2 ? "1 day ago" : `${Math.floor(days)} days ago`;
}

/** What an image is, in a sentence: its name and build, when it was built, its OS, tools and size. */
export function describeImage(record: ImageRecord, now = Date.now()): string {
  const built = Date.parse(record.built);
  const tools = Object.entries(record.tools).map(([name, version]) => `${name} ${version}`);
  const parts = [record.os, ...tools, ...(record.nvidia ? [`NVIDIA ${record.nvidia}`] : []), ...(record.sizeGiB !== null ? [`${record.sizeGiB} GiB`] : [])];
  return `${record.image === "standard" ? "Standard image" : `Image ${record.image}`} ${record.build}, built ${day(built, now)} (${ago((now - built) / DAY_MS)})${
    parts.filter(Boolean).length ? `: ${parts.filter(Boolean).join(", ")}` : ""
  }.`;
}

/**
 * Judges an image by its record (049): its contract and NVIDIA userspace
 * fail, and no record, its age, another build of BB's app and other pins
 * warn. `rebuild` says how to rebuild it, as the fix.
 */
export function judgeImage(
  record: ImageRecord | null,
  facts: {
    readonly os: keyof typeof STALE_DAYS;
    /** The pins this bb-box would build it with. */
    readonly pins: string | null;
    /** BB's app on BB's server now. */
    readonly bbApp: string | null;
    /** The host's NVIDIA driver as a box last saw it, for an image with NVIDIA's userspace. */
    readonly hostNvidia?: { readonly version: string; readonly seen: string } | null;
    /** Whether its boxes join BB, for a Windows image, which must then carry Node.js and an agent CLI (#539). */
    readonly joins?: boolean;
    readonly now?: number;
  },
  rebuild: string,
): ImageJudgement {
  const now = facts.now ?? Date.now();
  if (!record) {
    return {
      status: "warn",
      detail: "It has no image record, as images built before bb-box recorded them do not, so bb-box cannot tell how old it is or what is in it.",
      fix: rebuild,
    };
  }
  const failures: string[] = [];
  const warnings: string[] = [];
  if (record.contract < IMAGE_CONTRACT) {
    failures.push(`It keeps image contract ${record.contract}, and this bb-box needs ${IMAGE_CONTRACT}, so its boxes may not work.`);
  }
  const host = facts.hostNvidia;
  if (record.nvidia && host && host.version !== record.nvidia) {
    failures.push(
      `It has NVIDIA userspace ${record.nvidia}, but the host has driver ${host.version}, as a box saw on ${day(Date.parse(host.seen), now)}, so its desktops start without the GPU.`,
    );
  }
  const days = (now - Date.parse(record.built)) / DAY_MS;
  if (days > STALE_DAYS[facts.os]) {
    warnings.push(`It is ${Math.floor(days)} days old, more than ${STALE_DAYS[facts.os]}, so its tools and packages are behind.`);
  }
  if (facts.bbApp && record.bbApp !== facts.bbApp) {
    warnings.push(
      `It has ${record.bbApp ? "another build of BB's app than BB's server gives" : "no build of BB's app"}, so each box downloads the app as it enrols, 2 to 5 s more.`,
    );
  }
  if (facts.pins && record.pins !== facts.pins) {
    warnings.push("It was built with other pins than this bb-box's, so it lacks what a bb-box update brought.");
  }
  if (facts.os === "macos" && !record.tools.xcode) {
    warnings.push("It has no Xcode, so its boxes have no XCTest, Metal compiler or iOS Simulator (#475).");
  }
  if (facts.os === "windows" && facts.joins) {
    const node = record.tools.node;
    if (!node || !atLeast(node, WINDOWS_NODE)) {
      warnings.push(`It has ${node ? `Node.js ${node}` : "no Node.js"}, and BB's installer needs ${WINDOWS_NODE} or later, so each box installs it as it joins BB, about 11 s more.`);
    }
    if (!AGENT_CLIS.some(([tool]) => record.tools[tool])) {
      warnings.push(`It has none of the agent CLIs BB runs threads with, ${AGENT_CLIS.map(([, name]) => name).join(", ")}, so box_thread refuses its boxes (#561).`);
    }
  }
  const problems = [...failures, ...warnings];
  return {
    status: failures.length ? "fail" : warnings.length ? "warn" : "ok",
    detail: [describeImage(record, now), ...problems].join(" "),
    fix: problems.length ? rebuild : null,
  };
}
