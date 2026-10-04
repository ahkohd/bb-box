/**
 * A draft of a project image's script from the project's own files (049),
 * for an agent to finish: each part says the file it came from, and what
 * the draft could not translate is listed for the agent and commented in
 * the script. The script runs as root on bb-box's standard Ubuntu image,
 * with no checkout of the repository, so what needs the workspace stays in
 * the thread.
 *
 * It reads devcontainer.json, a Dockerfile, .tool-versions, mise.toml,
 * .nvmrc, .node-version, .python-version, rust-toolchain(.toml), flake.nix
 * with flake.lock, and shell.nix; or what a box has that its image had not
 * (SCAN_SCRIPT), for a box someone set up by hand.
 */

/** A file of the project's, by its path in the repository. */
export interface DraftFile {
  readonly path: string;
  readonly text: string;
}

export interface Draft {
  /** The script, for .bb/box-setup.sh. */
  readonly script: string;
  /** A check of what it installed, for .bb/box-check.sh. */
  readonly check: string;
  /** What the draft left to the agent, a line each. */
  readonly gaps: readonly string[];
  /** The files it used. */
  readonly used: readonly string[];
}

/** Features standard images cover already, by their ID. */
const COVERED_FEATURES: Readonly<Record<string, string>> = {
  "docker-in-docker": "Docker, which standard images start on first use",
  "docker-outside-of-docker": "Docker, which standard images start on first use",
  "github-cli": "gh",
  "common-utils": "the common utilities, sudo and the box user",
  git: "git",
  "git-lfs": "git-lfs",
  sshd: "sshd",
};
/** Features for a language, and the mise tool that gives it. */
const MISE_FEATURES: Readonly<Record<string, string>> = { node: "node", python: "python", go: "go", golang: "go", java: "java", ruby: "ruby", deno: "deno", bun: "bun", terraform: "terraform" };
/** asdf's names that mise knows by another. */
const MISE_NAMES: Readonly<Record<string, string>> = { nodejs: "node", golang: "go" };
/** What standard images have, by mise tool: a version the image's satisfies needs nothing. */
const STANDARD: Readonly<Record<string, readonly string[]>> = { node: ["", "lts", "latest", "lts/*", "node", "24"], python: ["", "latest", "os-provided", "3", "3.12"] };
/** The command a check runs for a mise tool. */
const VERSION_COMMANDS: Readonly<Record<string, string>> = { node: "node --version", python: "python --version", go: "go version", java: "java -version", ruby: "ruby --version", deno: "deno --version", bun: "bun --version", terraform: "terraform version" };
/** Official language images, and the mise tool their tag's version is of. */
const LANGUAGE_IMAGES: Readonly<Record<string, string>> = { node: "node", python: "python", golang: "go", ruby: "ruby", "eclipse-temurin": "java", openjdk: "java" };

const base = (path: string) => path.split("/").at(-1) ?? path;
const directory = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** JSON with comments and trailing commas, as devcontainer.json is written. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = (() => {
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "\\") j++;
          else if (text[j] === '"') return j;
        }
        return text.length;
      })();
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The draft, in parts: root's steps, the box user's, and what the check runs. */
class Builder {
  readonly root: string[] = [];
  readonly user: string[] = [];
  readonly checks: string[] = [];
  readonly gaps: string[] = [];
  readonly used: string[] = [];
  readonly helpers = new Set<"path" | "env">();
  readonly mise = new Map<string, { version: string; from: string }>();
  /** Lines after mise, such as rustup and Nix. */
  readonly after: string[] = [];

  gap(from: string, what: string): void {
    this.gaps.push(`${from}: ${what}`);
  }

  /** A variable every box command gets, in `into`: root's steps by default. */
  setEnv(key: string, value: string, from: string, into: string[] = this.root): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return this.gap(from, `${key} is not a variable name.`);
    if (value.includes("$")) return this.gap(from, `${key}=${value} refers to another variable or the workspace; set it in the script if the box needs it.`);
    this.helpers.add("env");
    into.push(`set_env ${key} ${quote(value)}`);
  }

  useMise(tool: string, version: string, from: string): void {
    const name = MISE_NAMES[tool] ?? tool;
    const plain = version.replace(/^v/, "").trim();
    if (STANDARD[name]?.includes(plain.toLowerCase())) return;
    const known = this.mise.get(name);
    if (known && known.version !== plain) this.gap(from, `${name} ${plain} as well as ${known.version} from ${known.from}: the draft takes ${known.version}.`);
    if (!known) this.mise.set(name, { version: plain || "latest", from });
  }
}

/**
 * What a box has that its image had not, as the box user can see it (049):
 * sections of lines, each after a "== <section>" line. The image's record
 * is the mark: what is newer was made in the box.
 */
export const SCAN_SCRIPT = String.raw`set -u
mark=/usr/share/bb-box/image.json
[ -e "$mark" ] || { echo "== no-record"; exit 0; }
newer() { find "$@" -mindepth 1 -maxdepth 1 -newer "$mark" 2>/dev/null | sort; }
echo "== packages"
[ -r /usr/share/bb-box/template-packages.tsv ] && comm -13 <(cut -f1 /usr/share/bb-box/template-packages.tsv | sed 's/:.*//' | sort -u) <(apt-mark showmanual 2>/dev/null | sed 's/:.*//' | sort -u)
echo "== sources"
for f in $(newer /etc/apt/sources.list.d); do echo "# $f"; grep -v '^\s*#' "$f" | sed '/^\s*$/d'; done
echo "== local"
# Not npm's links for its globals, which come next.
newer /usr/local/bin /usr/local/sbin /opt | while read -r p; do case $(readlink -f "$p") in /usr/local/lib/node_modules/*) ;; *) echo "$p" ;; esac; done
echo "== npm"
for d in $(newer /usr/local/lib/node_modules ~/.local/lib/node_modules; for s in /usr/local/lib/node_modules/@* ~/.local/lib/node_modules/@*; do [ -d "$s" ] && newer "$s"; done); do [ -f "$d/package.json" ] && node -p 'const p = require(process.argv[1]); p.name + "@" + p.version' "$d/package.json" 2>/dev/null; done
echo "== mise"
[ -f ~/.config/mise/config.toml ] && cat ~/.config/mise/config.toml
echo "== rust"
[ -x ~/.cargo/bin/rustup ] && ~/.cargo/bin/rustup show active-toolchain 2>/dev/null | cut -d' ' -f1
echo "== uv"
command -v uv >/dev/null && uv tool list 2>/dev/null | sed -n 's/^\([A-Za-z0-9_.-]*\) v.*/\1/p'
echo "== home-bin"
# Not BB's own CLI, which enrolment writes there, nor uv's tools, nor npm's links for its globals.
newer ~/.local/bin | while read -r p; do case $(readlink -f "$p") in "$HOME"/.local/bin/bb | "$HOME"/.bb-machines/* | "$HOME"/.local/share/uv/* | "$HOME"/.local/lib/node_modules/*) ;; *) echo "$p" ;; esac; done
exit 0
`;

/** SCAN_SCRIPT's output, by section. */
export function parseScan(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const header = /^== ([\w-]+)$/.exec(line);
    if (header) sections.set(header[1]!, (current = []));
    else if (current && line.trim()) current.push(line);
  }
  return sections;
}

/** What a scan of a box found, into the draft. */
function scanned(b: Builder, from: string, scan: Map<string, string[]>): void {
  b.used.push(from);
  if (scan.has("no-record")) return b.gap(from, "its image has no record, so the draft cannot tell what was added in the box: add what the project needs by hand.");
  const packages = scan.get("packages") ?? [];
  const sources = scan.get("sources") ?? [];
  if (sources.length) {
    b.root.push(`# Package sources added in ${from}: add each one's key and line, as its vendor says.`, ...sources.map((line) => (line.startsWith("# ") ? line : `# ${line}`)));
    b.gap(from, "it has package sources of its own: add their keys and lines before the packages that come from them.");
  }
  if (packages.length) b.root.push(`# Packages installed in ${from}.`, `apt-get install -y --no-install-recommends ${packages.map(quote).join(" ")}`);
  const npm = scan.get("npm") ?? [];
  if (npm.length) b.root.push(`# npm packages installed globally in ${from}.`, `npm install -g ${npm.map(quote).join(" ")}`);
  for (const [tool, value] of tomlSection((scan.get("mise") ?? []).join("\n"), "tools")) {
    const version = /^"([^"]*)"$/.exec(value)?.[1];
    if (version === undefined) b.gap(from, `mise's ${tool} = ${value} is not a plain version.`);
    else b.useMise(tool, version, `${from}, mise`);
  }
  const toolchain = scan.get("rust")?.[0];
  if (toolchain) {
    b.after.push(...rustup(toolchain.replace(/-(x86_64|aarch64)-unknown-linux-gnu$/, ""), [], [], "minimal", from));
    b.checks.push("cargo --version");
  }
  const uv = scan.get("uv") ?? [];
  if (uv.length) b.user.push(`# uv tools installed in ${from}.`, `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'`, ...uv.map((tool) => `uv tool install ${quote(tool)}`), "BB_BOX_AS_USER");
  const local = scan.get("local") ?? [];
  const homeBin = scan.get("home-bin") ?? [];
  const known = new Set(uv);
  for (const path of [...local, ...homeBin.filter((path) => !known.has(base(path)))]) {
    b.gap(from, `${path} was made in the box: add how it was installed.`);
  }
}

/** The project's files, as box_image_draft takes them, and a box's scan: a draft of its image's script. */
export function draftImage(files: readonly DraftFile[], box?: { readonly name: string; readonly scan: string }): Draft {
  const b = new Builder();
  if (box) scanned(b, `box ${box.name}`, parseScan(box.scan));
  const byName = (...names: string[]) => files.filter((file) => names.includes(base(file.path)));
  const dockerfiles = new Map(files.filter((file) => /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.Dockerfile$/.test(file.path)).map((file) => [file.path, file]));
  const readDockerfiles = new Set<string>();

  for (const file of byName("devcontainer.json", ".devcontainer.json")) {
    b.used.push(file.path);
    let config: Record<string, unknown>;
    try {
      config = parseJsonc(file.text) as Record<string, unknown>;
    } catch (error) {
      b.gap(file.path, `it is not JSON with comments: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Its Dockerfile first, then its features, as a dev container build runs them.
    const build = config.build as { dockerfile?: string; context?: string } | undefined;
    const named = build?.dockerfile ?? (typeof config.dockerFile === "string" ? config.dockerFile : undefined);
    if (named) {
      const path = normalise(`${directory(file.path)}/${named}`);
      const found = dockerfiles.get(path);
      if (found) {
        dockerfile(b, found);
        readDockerfiles.add(path);
      } else {
        b.gap(file.path, `its Dockerfile, ${path}, was not given: pass it to box_image_draft too.`);
      }
    } else if (typeof config.image === "string") {
      b.gap(file.path, `its image, ${config.image}, is not the box's: the draft adds to bb-box's Ubuntu 24.04 standard image what the features and settings ask for.`);
    }
    devcontainer(b, file.path, config);
  }
  for (const [path, file] of dockerfiles) if (!readDockerfiles.has(path)) dockerfile(b, file);

  for (const file of byName(".tool-versions")) {
    b.used.push(file.path);
    for (const line of file.text.split("\n").map((one) => one.replace(/#.*/, "").trim()).filter(Boolean)) {
      const [tool, version = "latest"] = line.split(/\s+/);
      b.useMise(tool!, version, file.path);
    }
  }
  for (const file of byName("mise.toml", ".mise.toml")) {
    b.used.push(file.path);
    for (const [tool, value] of tomlSection(file.text, "tools")) {
      const version = /^"([^"]*)"$/.exec(value)?.[1] ?? /^'([^']*)'$/.exec(value)?.[1];
      if (version === undefined) b.gap(file.path, `[tools] ${tool} = ${value} is not a plain version; add it to the mise lines by hand.`);
      else b.useMise(tool.replace(/^"|"$/g, ""), version, file.path);
    }
    for (const [key, value] of tomlSection(file.text, "env")) {
      const plain = /^"([^"]*)"$/.exec(value)?.[1];
      if (plain === undefined) b.gap(file.path, `[env] ${key} = ${value} is not a plain string.`);
      else b.setEnv(key, plain, file.path);
    }
  }
  for (const file of byName(".nvmrc", ".node-version")) {
    b.used.push(file.path);
    b.useMise("node", file.text.trim().split("\n")[0] ?? "", file.path);
  }
  for (const file of byName(".python-version")) {
    b.used.push(file.path);
    b.useMise("python", file.text.trim().split("\n")[0] ?? "", file.path);
  }
  for (const file of byName("rust-toolchain.toml", "rust-toolchain")) {
    b.used.push(file.path);
    rust(b, file);
  }
  const flake = byName("flake.nix")[0];
  const shell = byName("shell.nix")[0];
  if (flake || shell) nix(b, flake ?? null, flake ? (byName("flake.lock")[0] ?? null) : null, flake ? null : shell!);

  return { ...render(b), gaps: b.gaps, used: [...new Set(b.used)] };
}

function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** devcontainer.json's features, variables and commands. */
function devcontainer(b: Builder, from: string, config: Record<string, unknown>): void {
  const features = (config.features ?? {}) as Record<string, unknown>;
  for (const [ref, raw] of Object.entries(features)) {
    const options: Record<string, unknown> = typeof raw === "string" ? { version: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = (ref.split("/").at(-1) ?? ref).replace(/[:@].*$/, "");
    if (ref.startsWith("./") || ref.startsWith("../")) {
      b.gap(from, `the feature ${ref} is in the repository, which a build cannot read: copy its install.sh into the script.`);
    } else if (COVERED_FEATURES[id]) {
      b.root.push(`# ${ref}: standard images have ${COVERED_FEATURES[id]}.`);
    } else if (MISE_FEATURES[id] && Object.keys(options).every((key) => key === "version")) {
      b.useMise(MISE_FEATURES[id]!, String(options.version ?? "latest"), from);
    } else if (id === "rust") {
      b.after.push(...rustup(String(options.version ?? "stable").replace(/^latest$/, "stable"), [], [], "minimal", from));
      b.checks.push("cargo --version");
    } else {
      const args = Object.entries(options).map(([key, value]) => quote(`${key}=${String(value)}`));
      b.root.push(`# From ${from}.`, ["bb-box-feature", quote(ref), ...args].join(" "));
    }
  }
  for (const key of ["containerEnv", "remoteEnv"] as const) {
    const env = config[key];
    if (env && typeof env === "object") for (const [name, value] of Object.entries(env as Record<string, unknown>)) b.setEnv(name, String(value), `${from} ${key}`);
  }
  for (const key of ["onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"]) {
    const command = config[key];
    if (command === undefined) continue;
    const lines = typeof command === "string" ? [command] : Array.isArray(command) ? [command.map(String).join(" ")] : Object.values(command as Record<string, unknown>).map((one) => (Array.isArray(one) ? one.map(String).join(" ") : String(one)));
    b.user.push(`# ${from} ${key}, commented out: it usually needs the checkout, which a build has not, so it stays in the thread.`, ...lines.map((line) => `# ${line}`));
    b.gap(from, `${key} is commented out: keep in the script only what needs no checkout.`);
  }
  if (config.remoteUser || config.containerUser) b.gap(from, `its user, ${String(config.remoteUser ?? config.containerUser)}, is the box user in a box.`);
  for (const key of ["runArgs", "mounts", "privileged", "capAdd", "securityOpt"]) if (config[key] !== undefined) b.gap(from, `${key} is the container's, which a box's image cannot give.`);
}

/** A Dockerfile's last stage: RUN lines in order, ENV and ARG as variables, and USER for the box user. */
function dockerfile(b: Builder, file: DraftFile): void {
  b.used.push(file.path);
  const instructions = parseDockerfile(file.text);
  const froms = instructions.filter((one) => one.keyword === "FROM");
  if (froms.length > 1) b.gap(file.path, `it has ${froms.length} stages; the draft takes the last, and what it copies from the others is left to you.`);
  const stage = instructions.slice(instructions.lastIndexOf(froms.at(-1)!) + 1);
  const image = froms.at(-1)?.args.split(/\s+/).find((word) => !word.startsWith("--")) ?? "";
  const [name = "", tag = ""] = image.replace(/^.*\//, "").split(":");
  if (LANGUAGE_IMAGES[name] && /^\d/.test(tag)) b.useMise(LANGUAGE_IMAGES[name]!, tag.split("-")[0]!, `${file.path} FROM`);
  else if (!/ubuntu|debian|bookworm|bullseye|buster|noble|jammy|focal|devcontainers|slim/.test(image) && !LANGUAGE_IMAGES[name]) {
    b.gap(file.path, `its base, ${image || "none"}, is not Ubuntu or Debian: check its RUN lines' packages and commands exist on Ubuntu 24.04.`);
  }
  let asUser = false;
  const lines: string[] = [`# From ${file.path}.`];
  for (const { keyword, args } of stage) {
    if (keyword === "RUN") {
      const command = args.startsWith("[") ? execForm(args) : args;
      lines.push(asUser ? `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'\n${command}\nBB_BOX_AS_USER` : command);
    } else if (keyword === "ENV" || keyword === "ARG") {
      for (const [key, value] of pairs(args)) {
        if (value === undefined) {
          if (keyword === "ARG") b.gap(file.path, `ARG ${key} has no default: set it in the script.`);
          continue;
        }
        lines.push(`export ${key}=${quote(value)}`);
        if (keyword === "ENV") b.setEnv(key, value, `${file.path} ENV`, lines);
      }
    } else if (keyword === "USER") {
      asUser = !/^(root|0)(:.*)?$/.test(args.trim());
      if (asUser) lines.push(`# USER ${args.trim()}: the box user runs what follows.`);
    } else if (keyword === "WORKDIR") {
      lines.push(`mkdir -p ${quote(args.trim())} && cd ${quote(args.trim())}`);
    } else if (keyword === "COPY" || keyword === "ADD") {
      lines.push(`# ${keyword} ${args}: a build has no checkout to copy from.`);
      b.gap(file.path, `${keyword} ${args} is commented out: a build has no checkout; fetch the file, write it in the script, or leave it to the thread.`);
    } else if (["CMD", "ENTRYPOINT"].includes(keyword)) {
      b.gap(file.path, `${keyword} ${args} is left out: a box runs no container command; start it in the thread.`);
    } else if (keyword === "SHELL") {
      b.gap(file.path, `SHELL ${args} is left out: the script runs its lines with bash.`);
    }
  }
  b.root.push(...lines);
}

/** A Dockerfile's instructions, its continuation lines joined and its heredocs kept. */
export function parseDockerfile(text: string): { keyword: string; args: string }[] {
  const out: { keyword: string; args: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      i++;
      if (lines[i]!.trim().startsWith("#")) continue;
      // Kept a continuation, which bash reads as Docker does.
      line = `${line.replace(/\\\s*$/, "\\")}\n${lines[i]}`;
    }
    const match = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(line);
    if (!match) continue;
    let args = match[2]!.trim();
    // RUN <<EOF ... EOF
    const heredoc = /<<-?\s*["']?(\w+)["']?\s*$/.exec(args);
    if (heredoc) {
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== heredoc[1]) body.push(lines[++i]!);
      i++;
      args = args.replace(heredoc[0], "").trim() ? `${args.replace(heredoc[0], "").trim()} <<'${heredoc[1]}'\n${body.join("\n")}\n${heredoc[1]}` : body.join("\n");
    }
    out.push({ keyword: match[1]!.toUpperCase(), args });
  }
  return out;
}

function execForm(args: string): string {
  try {
    return (JSON.parse(args) as unknown[]).map((part) => quote(String(part))).join(" ");
  } catch {
    return args;
  }
}

/** ENV and ARG pairs: KEY=value pairs, or the old KEY value form. */
function pairs(args: string): [string, string | undefined][] {
  if (!/^[A-Za-z_][\w]*=/.test(args) && /^[A-Za-z_][\w]*\s+\S/.test(args)) {
    const [key, ...rest] = args.split(/\s+/);
    return [[key!, rest.join(" ")]];
  }
  const out: [string, string | undefined][] = [];
  for (const match of args.matchAll(/([A-Za-z_][\w]*)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?/g)) {
    const raw = match[2];
    out.push([match[1]!, raw === undefined ? undefined : raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1")]);
  }
  return out;
}

/** A TOML section's keys and values, as text: enough for mise.toml and rust-toolchain.toml. */
function tomlSection(text: string, name: string): [string, string][] {
  const out: [string, string][] = [];
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (/^\[.*\]$/.test(line)) {
      inside = line === `[${name}]`;
      continue;
    }
    const match = inside ? /^("?[\w.-]+"?)\s*=\s*(.+)$/.exec(line) : null;
    if (match) out.push([match[1]!, match[2]!]);
  }
  return out;
}

function rust(b: Builder, file: DraftFile): void {
  if (base(file.path) === "rust-toolchain" && !file.text.includes("[toolchain]")) {
    b.after.push(...rustup(file.text.trim().split("\n")[0] ?? "stable", [], [], "minimal", file.path));
  } else {
    const fields = new Map(tomlSection(file.text, "toolchain"));
    const text = (key: string) => /^"([^"]*)"$/.exec(fields.get(key) ?? "")?.[1];
    const list = (key: string) => [...(fields.get(key) ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    b.after.push(...rustup(text("channel") ?? "stable", list("components"), list("targets"), text("profile") ?? "minimal", file.path));
  }
  b.checks.push("cargo --version", "rustc --version");
}

function rustup(channel: string, components: readonly string[], targets: readonly string[], profile: string, from: string): string[] {
  const args = [`--profile ${profile}`, `--default-toolchain ${quote(channel)}`, ...components.map((one) => `-c ${quote(one)}`), ...targets.map((one) => `-t ${quote(one)}`)];
  return [
    `# Rust, from ${from}, for the box user, with cargo and rustc on its PATH.`,
    `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'`,
    `curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path ${args.join(" ")}`,
    "BB_BOX_AS_USER",
    'path_first "$BOX_HOME/.cargo/bin"',
  ];
}

/** Nix, and the dev shell built once from copies of the flake and its lock, or of shell.nix. */
function nix(b: Builder, flake: DraftFile | null, lock: DraftFile | null, shell: DraftFile | null): void {
  const from = (flake ?? shell)!.path;
  b.used.push(from, ...(lock ? [lock.path] : []));
  if (flake && !lock) b.gap(flake.path, "flake.lock was not given, so the dev shell takes its inputs as they are on the day of the build: pass the lock too.");
  const copies = [flake, lock, shell].filter((file): file is DraftFile => !!file);
  const marker = (file: DraftFile) => {
    let tag = "BB_BOX_FILE";
    while (file.text.includes(tag)) tag += "_";
    return tag;
  };
  b.after.push(
    `# Nix for the box user, and the dev shell of ${from} built once, from copies in this script.`,
    'install -d -m 0755 -o "$BOX_USER" /nix',
    `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'`,
    "curl -fsSL https://nixos.org/nix/install | sh -s -- --no-daemon",
    "mkdir -p ~/.config/nix && echo 'experimental-features = nix-command flakes' >>~/.config/nix/nix.conf",
    "BB_BOX_AS_USER",
    'path_first "$BOX_HOME/.nix-profile/bin"',
    "install -d -m 0755 /opt/bb-box-image/nix",
    ...copies.flatMap((file) => [`cat >/opt/bb-box-image/nix/${base(file.path)} <<'${marker(file)}'`, file.text.replace(/\n$/, ""), marker(file)]),
    'chown -R "$BOX_USER" /opt/bb-box-image/nix',
    flake
      ? 'sudo -iu "$BOX_USER" "$BOX_HOME/.nix-profile/bin/nix" develop /opt/bb-box-image/nix --command true'
      : 'sudo -iu "$BOX_USER" "$BOX_HOME/.nix-profile/bin/nix-shell" /opt/bb-box-image/nix/shell.nix --run true',
  );
  b.gap(from, "Nix is installed for the box user alone, with no daemon, as boxes may have no systemd; in the thread, run `nix develop` in its checkout.");
  b.checks.push("nix --version");
}

function render(b: Builder): { script: string; check: string } {
  const mise = [...b.mise.entries()];
  if (mise.length) b.helpers.add("path");
  if (b.after.some((line) => line.startsWith("path_first"))) b.helpers.add("path");
  const script: string[] = [
    "#!/bin/bash",
    "# A project image's script (049): bb-box runs it as root on its standard Ubuntu 24.04",
    "# image, with BB_BOX_IMAGE, BB_BOX_KIND, BB_BOX_BACKEND and BB_BOX_ARCH. There is no",
    "# checkout of the repository: what needs one stays in the thread.",
    "# Drafted by box_image_draft; try it with box_image_try.",
    "set -euo pipefail",
    'BOX_USER=$(id -nu 1000)',
    ...(b.helpers.size ? ['BOX_HOME=$(getent passwd 1000 | cut -d: -f6)'] : []),
  ];
  if (b.gaps.length) script.push("", "# To do, from the draft:", ...b.gaps.map((gap) => `# - ${gap}`));
  if (b.helpers.has("path")) {
    script.push("", "# A directory first on the PATH every box command gets, once.", `path_first() { grep -q "^PATH=\\"$1:" /etc/environment || sed -i "s|^PATH=\\"|PATH=\\"$1:|" /etc/environment; }`);
  }
  if (b.helpers.has("env")) {
    script.push("", "# A variable every box command gets.", `set_env() { sed -i "/^$1=/d" /etc/environment; printf '%s="%s"\\n' "$1" "$2" >>/etc/environment; }`);
  }
  if (b.root.length) script.push("", ...b.root);
  if (mise.length) {
    script.push(
      "",
      "# mise for the box user's tools, its shims first on the PATH.",
      `sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'`,
      "curl -fsSL https://mise.run | sh",
      ...mise.map(([tool, { version, from }]) => `~/.local/bin/mise use --global ${quote(`${tool}@${version}`)}  # ${from}`),
      "BB_BOX_AS_USER",
      'path_first "$BOX_HOME/.local/share/mise/shims"',
    );
    for (const [tool] of mise) b.checks.push(VERSION_COMMANDS[tool] ?? `mise which ${tool}`);
  }
  if (b.after.length) script.push("", ...b.after);
  if (b.user.length) script.push("", ...b.user);
  if (!b.root.length && !mise.length && !b.after.length && !b.user.length) {
    script.push(
      "",
      b.used.length ? `# The standard image has what ${b.used.join(", ")} ${b.used.length === 1 ? "asks" : "ask"} for. Add what else the project needs, for example:` : "# Nothing was found to draft from. Fill in what the project needs, for example:",
      "# apt-get install -y --no-install-recommends <packages>",
      "# bb-box-feature ghcr.io/devcontainers/features/<feature>:1 <option>=<value>",
      `# sudo -iu "$BOX_USER" bash -se <<'BB_BOX_AS_USER'`,
      "# curl -fsSL https://mise.run | sh && ~/.local/bin/mise use --global node@22",
      "# BB_BOX_AS_USER",
    );
  }
  const checks = [...new Set(b.checks)];
  const check = [
    "#!/bin/bash",
    "# A project image's check (049): bb-box runs it as the box user after the script, and",
    "# on a box of the image's build. It fails when the script did not do its work.",
    "set -euo pipefail",
    ...(checks.length ? checks : ["# What the project needs, for example: cargo --version", "true"]),
  ];
  return { script: `${script.join("\n")}\n`, check: `${check.join("\n")}\n` };
}
