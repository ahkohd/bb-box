/**
 * The versions a standard Linux image is built with (049): the latest
 * stable release of the tools that change often and that bb-box does not
 * depend on, Claude Code, Codex, pi, gh and Chrome, each with the SHA-256
 * its upstream publishes, and the day's apt snapshot. Everything else stays
 * as setup/proxmox-lxc/template pins it, and changes with bb-box releases.
 * A tool keeps its pin when its upstream cannot be read, or has nothing
 * newer, so a build never takes a version older than the pin.
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pinsDigest } from "./images.ts";

/** What the resolver needs of fetch, for tests. */
export type FetchText = (
  url: string,
  init: { readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

/** The tools that follow upstream, by their names in the pins. */
export const FOLLOWED = ["claude-code", "codex", "pi", "gh", "chrome"] as const;

const TEMPLATE = join("proxmox-lxc", "template");
const CHROME_REPO = "https://dl.google.com/linux/chrome/deb";
const DEB_ARCH: Readonly<Record<string, string>> = { x86_64: "amd64", arm64: "arm64" };

export interface ToolVersion {
  readonly name: string;
  readonly arch: string;
  /** The repository's pin. */
  readonly pinned: string;
  /** What a build takes: upstream's latest stable release, or the pin. */
  readonly version: string;
  /** Where the version and its SHA-256 come from. */
  readonly source: string;
  /** Why the tool keeps its pin although upstream may have a newer one, or null. */
  readonly kept: string | null;
}

export interface Versions {
  readonly resolvedAt: string;
  /** False when built from the repository's pins alone (--pinned). */
  readonly following: boolean;
  readonly aptSnapshot: { readonly pinned: string; readonly version: string };
  readonly tools: readonly ToolVersion[];
  /** The pin files a build reads, with the versions in them. */
  readonly files: { readonly "pins.json": string; readonly "desktop-pins.tsv": string; readonly "apt-snapshot": string };
}

interface ToolPin {
  name: string;
  version: string;
  arch: string;
  url: string;
  sha256: string;
  source?: string;
  file?: string;
  links?: Record<string, string>;
  [key: string]: unknown;
}

/** Compares dotted versions by their numbers: 2.1.288 is after 2.1.283, 154.0.8037.97-1 after 154.0.8037.92-1. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[^0-9]+/).filter(Boolean).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+(\.\d+)+$/;

class Upstream {
  readonly #fetch: FetchText;
  readonly #signal: AbortSignal | undefined;
  readonly #cache = new Map<string, Promise<string>>();

  constructor(fetch: FetchText, signal?: AbortSignal) {
    this.#fetch = fetch;
    this.#signal = signal;
  }

  /** A URL's text, each fetched once. */
  text(url: string, headers: Readonly<Record<string, string>> = {}): Promise<string> {
    let got = this.#cache.get(url);
    if (!got) {
      const timeout = AbortSignal.timeout(30_000);
      got = this.#fetch(url, { headers: { "User-Agent": "bb-box", ...headers }, signal: this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout }).then(
        async (response) => {
          if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
          return response.text();
        },
      );
      this.#cache.set(url, got);
    }
    return got;
  }

  json<T>(url: string, headers?: Readonly<Record<string, string>>): Promise<T> {
    return this.text(url, headers).then((text) => JSON.parse(text) as T);
  }
}

/** A newer release of a tool in pins.json, or null when the pin stays: Claude Code's latest channel, or a GitHub release. */
async function newerTool(upstream: Upstream, pin: ToolPin): Promise<{ pin: ToolPin; source: string } | { kept: string; source: string }> {
  const swap = (version: string, url: string, sha256: string, source: string): { pin: ToolPin; source: string } => ({
    pin: {
      ...pin,
      version,
      url,
      sha256,
      source,
      ...(pin.file ? { file: pin.file.replaceAll(pin.version, version) } : {}),
      ...(pin.links ? { links: Object.fromEntries(Object.entries(pin.links).map(([link, target]) => [link, target.replaceAll(pin.version, version)])) } : {}),
    },
    source,
  });
  if (pin.name === "claude-code") {
    const at = pin.url.indexOf(`/${pin.version}/`);
    if (at < 0) return { kept: `its pinned URL does not name version ${pin.version}`, source: pin.source ?? "" };
    const base = pin.url.slice(0, at);
    const latest = (await upstream.text(`${base}/latest`)).trim();
    if (!VERSION.test(latest)) throw new Error(`the latest channel names "${latest.slice(0, 40)}", not a version`);
    if (compareVersions(latest, pin.version) <= 0) return { kept: "", source: pin.source ?? "" };
    const manifest = await upstream.json<{ platforms?: Record<string, { checksum?: unknown }> }>(`${base}/${latest}/manifest.json`);
    const platform = `linux-${pin.arch === "x86_64" ? "x64" : "arm64"}`;
    const checksum = manifest.platforms?.[platform]?.checksum;
    if (typeof checksum !== "string" || !SHA256.test(checksum)) throw new Error(`manifest.json of ${latest} has no SHA-256 for ${platform}`);
    return swap(latest, pin.url.replaceAll(`/${pin.version}/`, `/${latest}/`), checksum, `latest channel; manifest.json SHA-256 of ${latest}`);
  }
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(pin.url);
  if (!github) return { kept: "its pinned URL is not a GitHub release's", source: pin.source ?? "" };
  const [, repo, tag, asset] = github as unknown as [string, string, string, string];
  if (!tag.endsWith(pin.version)) return { kept: `its release tag ${tag} does not end with its version`, source: pin.source ?? "" };
  const prefix = tag.slice(0, tag.length - pin.version.length);
  const release = await upstream.json<{ tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: { name?: unknown; digest?: unknown }[] }>(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { Accept: "application/vnd.github+json" },
  );
  const latestTag = typeof release.tag_name === "string" ? release.tag_name : "";
  const latest = latestTag.startsWith(prefix) ? latestTag.slice(prefix.length) : "";
  if (!VERSION.test(latest) || release.draft || release.prerelease) throw new Error(`${repo}'s latest release, ${latestTag || "unnamed"}, is not a stable ${prefix}<version>`);
  if (compareVersions(latest, pin.version) <= 0) return { kept: "", source: pin.source ?? "" };
  const name = asset.replaceAll(pin.version, latest);
  const digest = /^sha256:([0-9a-f]{64})$/.exec(String(release.assets?.find((candidate) => candidate.name === name)?.digest ?? ""))?.[1];
  if (!digest) throw new Error(`${repo} ${latestTag} has no asset ${name} with a SHA-256`);
  return swap(latest, `https://github.com/${repo}/releases/download/${latestTag}/${name}`, digest, `GitHub release asset digest for ${repo} ${latestTag}`);
}

/** Google's stable Chrome for an architecture, from its apt repository's Packages index: version, file and SHA-256. */
async function latestChrome(upstream: Upstream, arch: string): Promise<{ version: string; filename: string; sha256: string }> {
  const index = await upstream.text(`${CHROME_REPO}/dists/stable/main/binary-${DEB_ARCH[arch]}/Packages`);
  let best: { version: string; filename: string; sha256: string } | null = null;
  for (const stanza of index.split(/\n\s*\n/)) {
    const field = (name: string) => new RegExp(`^${name}: *(.+)$`, "m").exec(stanza)?.[1]?.trim() ?? "";
    if (field("Package") !== "google-chrome-stable") continue;
    const [version, filename, sha256] = [field("Version"), field("Filename"), field("SHA256")];
    if (!version || !filename || !SHA256.test(sha256)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, filename, sha256 };
  }
  if (!best) throw new Error(`Google's Packages index for ${DEB_ARCH[arch]} has no google-chrome-stable with a SHA-256`);
  return best;
}

/** Chrome's version in a pinned file name, such as 154.0.8037.92-1. */
function chromeVersion(file: string): string {
  return /^google-chrome-stable_([^_]+)_/.exec(file)?.[1] ?? "";
}

const plain = (version: string) => version.replace(/-\d+$/, "");

/**
 * What a rebuild of the standard Linux images takes now, from `setup`, the
 * plugin's setup/ directory, and the pin files with those versions. With
 * `pinned`, the repository's pins alone.
 */
export async function resolveVersions(
  setup: string,
  options: { readonly fetch?: FetchText; readonly now?: number; readonly signal?: AbortSignal; readonly pinned?: boolean } = {},
): Promise<Versions> {
  const dir = join(setup, TEMPLATE);
  const [pinsText, desktopText, snapshotText] = await Promise.all(["pins.json", "desktop-pins.tsv", "apt-snapshot"].map((file) => readFile(join(dir, file), "utf8")));
  const now = options.now ?? Date.now();
  const resolvedAt = new Date(now).toISOString();
  const pins = JSON.parse(pinsText!) as { tools: ToolPin[]; [key: string]: unknown };
  const snapshot = snapshotText!.trim();
  const upstream = new Upstream(options.fetch ?? (fetch as unknown as FetchText), options.signal);
  const tools: ToolVersion[] = [];
  const keep = (name: string, arch: string, pinned: string, source: string, kept: string | null) =>
    tools.push({ name, arch, pinned: plain(pinned), version: plain(pinned), source, kept });

  if (options.pinned) {
    for (const pin of pins.tools.filter((tool) => (FOLLOWED as readonly string[]).includes(tool.name))) keep(pin.name, pin.arch, pin.version, pin.source ?? "", "built from the pins alone (--pinned)");
    return { resolvedAt, following: false, aptSnapshot: { pinned: snapshot, version: snapshot }, tools, files: { "pins.json": pinsText!, "desktop-pins.tsv": desktopText!, "apt-snapshot": snapshotText! } };
  }

  const resolvedTools = await Promise.all(
    pins.tools.map(async (pin) => {
      if (!(FOLLOWED as readonly string[]).includes(pin.name)) return pin;
      try {
        const newer = await newerTool(upstream, pin);
        if ("kept" in newer) {
          keep(pin.name, pin.arch, pin.version, newer.source, newer.kept || null);
          return pin;
        }
        tools.push({ name: pin.name, arch: pin.arch, pinned: pin.version, version: newer.pin.version, source: newer.source, kept: null });
        return newer.pin;
      } catch (error) {
        keep(pin.name, pin.arch, pin.version, pin.source ?? "", `upstream could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return pin;
      }
    }),
  );

  const desktopLines = await Promise.all(
    desktopText!.split("\n").map(async (line) => {
      const [name, file = "", , , arch = ""] = line.split("\t");
      if (name !== "chrome" || !DEB_ARCH[arch]) return line;
      const pinned = chromeVersion(file);
      try {
        const latest = await latestChrome(upstream, arch);
        if (compareVersions(latest.version, pinned) <= 0) {
          keep("chrome", arch, pinned, "Google's stable Packages index", null);
          return line;
        }
        tools.push({ name: "chrome", arch, pinned: plain(pinned), version: plain(latest.version), source: `Google's stable Packages index, SHA256 of ${latest.version}`, kept: null });
        const filename = latest.filename.split("/").at(-1)!;
        return [name, filename, `${CHROME_REPO}/${latest.filename}`, latest.sha256, arch].join("\t");
      } catch (error) {
        keep("chrome", arch, pinned, "Google's stable Packages index", `upstream could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return line;
      }
    }),
  );

  // The day's snapshot, which every build of the day shares.
  const today = `${resolvedAt.slice(0, 10).replaceAll("-", "")}T000000Z`;
  const aptSnapshot = today > snapshot ? today : snapshot;
  // The repository's pins' SHA-256, which the image's record keeps (image-record.sh), so that an
  // image built from them with newer versions counts as built with this bb-box's pins.
  const [linux, desktop] = await Promise.all([pinsDigest(setup, "linux"), pinsDigest(setup, "linux-desktop")]);
  const resolvedPins = { ...pins, resolvedAt, aptSnapshot, pinned: { linux, "linux-desktop": desktop }, tools: resolvedTools };
  const order = (tool: ToolVersion) => [FOLLOWED.indexOf(tool.name as (typeof FOLLOWED)[number]), tool.arch === "x86_64" ? 0 : 1];
  tools.sort((a, b) => order(a)[0]! - order(b)[0]! || order(a)[1]! - order(b)[1]!);
  return {
    resolvedAt,
    following: true,
    aptSnapshot: { pinned: snapshot, version: aptSnapshot },
    tools,
    files: { "pins.json": `${JSON.stringify(resolvedPins, null, 2)}\n`, "desktop-pins.tsv": desktopLines.join("\n"), "apt-snapshot": `${aptSnapshot}\n` },
  };
}

/** A copy of `setup` at `out` whose Linux pin files have `versions`, for a build to run from. */
export async function stageSetup(setup: string, out: string, versions: Versions): Promise<void> {
  await cp(setup, out, { recursive: true });
  for (const [file, text] of Object.entries(versions.files)) await writeFile(join(out, TEMPLATE, file), text);
}
