import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEVICE_HUB_PROCESS, type DeviceOffer, type Intent } from "./device.ts";
import { RECORD_DIR } from "./device-recording.ts";

export const DEVICE_SERVER_FILES = [
  "src/core/device-models.ts",
  "src/core/device-parse.ts",
  "src/core/device-recording.ts",
  "src/core/device-settings.ts",
  "src/core/device.ts",
  "src/core/png.ts",
  "src/device/android-controls.ts",
  "src/device/android-driver.ts",
  "src/device/android-input.ts",
  "src/device/android-video.ts",
  "src/device/annexb.ts",
  "src/device/apk.ts",
  "src/device/bb-box-device.sh",
  "src/device/driver.ts",
  "src/device/emulator.ts",
  "src/device/frame-fanout.ts",
  "src/device/grpc.ts",
  "src/device/h264-encoder.ts",
  "src/device/idb.ts",
  "src/device/input-lane.ts",
  "src/device/ios-controls.ts",
  "src/device/ios-driver.ts",
  "src/device/ios-input.ts",
  "src/device/ios-tree.ts",
  "src/device/ios-video.ts",
  "src/device/keys.ts",
  "src/device/main.ts",
  "src/device/mkv.ts",
  "src/device/paths.ts",
  "src/device/pcm-h264.ts",
  "src/device/person-input.ts",
  "src/device/protobuf.ts",
  "src/device/recorder.ts",
  "src/device/schemas.ts",
  "src/device/server.ts",
  "src/device/simctl.ts",
  "src/device/test-card.ts",
  "src/device/test-driver.ts",
  "src/device/ws.ts",
] as const;

export const DELIVERY_EXITS = { delivered: 0, noNode: 4, recording: 6, noPrevious: 7 } as const;
export const STATUS_EXITS = { running: 0, gaveUp: 3, none: 5 } as const;

const DIR = '"$HOME/.bb-box/device"';
const LAUNCHER = `${DIR}/current/src/device/bb-box-device.sh`;

export interface ServerFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export async function deviceServerFiles(root: string): Promise<readonly ServerFile[]> {
  return Promise.all(DEVICE_SERVER_FILES.map(async (path) => ({ path, data: new Uint8Array(await readFile(join(root, path))) })));
}

export function deviceServerDigest(files: readonly ServerFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.data.byteLength}\0`);
    hash.update(file.data);
  }
  return hash.digest("hex");
}

export interface DeviceChoices {
  readonly slim: boolean;
}

export interface Delivery {
  readonly version: number;
  readonly files: readonly ServerFile[];
  readonly offer: DeviceOffer;
  readonly intent: Intent | null;
  readonly choices: DeviceChoices;
}

export function deliveryStdin(delivery: Delivery): string {
  return JSON.stringify({
    files: delivery.files.map((file) => ({ path: file.path, data: Buffer.from(file.data).toString("base64") })),
    devices: delivery.offer,
    intent: delivery.intent,
    choices: delivery.choices,
  });
}

const FIND_NODE =
  'node=; for n in "$(cat "$dir/node" 2>/dev/null)" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do if [ -n "$n" ] && [ -x "$n" ]; then node=$n; break; fi; done; ' +
  `[ -n "$node" ] || { echo "bb-box: there is no Node.js in this box, which the device server runs on." >&2; exit ${DELIVERY_EXITS.noNode}; }; `;

const RECORDING_GUARD = `if [ -s "$HOME/${RECORD_DIR}/pid" ] && kill -0 "$(cat "$HOME/${RECORD_DIR}/pid")" 2>/dev/null; then echo "bb-box: a recording runs in this box." >&2; exit ${DELIVERY_EXITS.recording}; fi; `;

const UNPACK =
  'const fs=require("fs"),path=require("path");const d=JSON.parse(fs.readFileSync(0,"utf8"));' +
  'for(const f of d.files){const p=path.join(process.argv[1],f.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.data,"base64"))}' +
  'fs.writeFileSync(process.argv[2],JSON.stringify(d.devices)+"\\n",{mode:0o600});' +
  'if(d.intent&&!fs.existsSync(process.argv[3]))fs.writeFileSync(process.argv[3],JSON.stringify(d.intent)+"\\n",{mode:0o600});' +
  'if(d.choices)fs.writeFileSync(process.argv[4],JSON.stringify(d.choices)+"\\n",{mode:0o600});';

export function deliveryScript(version: number): string {
  if (!Number.isInteger(version) || version < 1) throw new Error(`${version} is not a device server version.`);
  return (
    `set -eu; dir=${DIR}; ` +
    RECORDING_GUARD +
    `mkdir -p "$dir/server"; chmod 700 "$dir"; ` +
    FIND_NODE +
    `staging="$dir/server/.incoming-$$"; rm -rf "$staging"; mkdir -p "$staging"; ` +
    `"$node" -e '${UNPACK}' "$staging" "$dir/devices.json" "$dir/intent.json" "$dir/choices.json"; ` +
    `rm -rf "$dir/server/${version}"; mv "$staging" "$dir/server/${version}"; ` +
    `old=$(readlink "$dir/current" 2>/dev/null || true); ` +
    `if [ -n "$old" ] && [ "$old" != "server/${version}" ]; then ln -sfn "$old" "$dir/previous"; fi; ` +
    `ln -sfn "server/${version}" "$dir/current"; ` +
    `keep_previous=$(readlink "$dir/previous" 2>/dev/null || true); ` +
    `for each in "$dir"/server/*; do [ -d "$each" ] || continue; name="server/$(basename "$each")"; [ "$name" = "server/${version}" ] || [ "$name" = "$keep_previous" ] || rm -rf "$each"; done; ` +
    `sh "$dir/current/src/device/bb-box-device.sh" install`
  );
}

export function rollbackScript(): string {
  return (
    `set -eu; dir=${DIR}; ` +
    `previous=$(readlink "$dir/previous" 2>/dev/null || true); ` +
    `[ -n "$previous" ] && [ -d "$dir/$previous" ] || { echo "bb-box: there is no earlier device server to go back to." >&2; exit ${DELIVERY_EXITS.noPrevious}; }; ` +
    `ln -sfn "$previous" "$dir/current"; rm -f "$dir/previous"; ` +
    `sh "$dir/current/src/device/bb-box-device.sh" install`
  );
}

export function restartScript(): string {
  return `f=${LAUNCHER}; [ -f "$f" ] || exit ${STATUS_EXITS.none}; exec sh "$f" restart`;
}

export function statusScript(): string {
  return `f=${LAUNCHER}; [ -f "$f" ] || { echo "This box has no device server yet."; exit ${STATUS_EXITS.none}; }; echo "version $(readlink ${DIR}/current | sed 's#^server/##')"; exec sh "$f" status`;
}

export interface ServerStatus {
  readonly none: boolean;
  readonly version: number | null;
  readonly words: string | null;
}

export function parseStatus(exitCode: number | null, stdout: string, stderr: string): ServerStatus {
  if (exitCode === STATUS_EXITS.none) return { none: true, version: null, words: null };
  const lines = stdout.trim().split("\n");
  const version = /^version (\d+)$/.exec(lines[0] ?? "")?.[1];
  const rest = (version ? lines.slice(1) : lines).join(" ").trim();
  return { none: false, version: version ? Number(version) : null, words: exitCode === STATUS_EXITS.gaveUp ? rest || stderr.trim() : null };
}

export function connectScript(): string {
  return `f=${LAUNCHER}; [ -f "$f" ] || { echo "bb-box: this box has no device server yet." >&2; exit ${STATUS_EXITS.none}; }; exec sh "$f" connect`;
}

export function deviceHubScript(): string {
  return `if pgrep -x -U "$(id -u)" ${DEVICE_HUB_PROCESS} >/dev/null 2>&1; then echo running; else echo none; fi; cat ${DIR}/device-hub.json 2>/dev/null || true`;
}

export interface DeviceHubSeen {
  readonly running: boolean;
  readonly killed: number;
  readonly last: number | null;
}

export function parseDeviceHub(stdout: string): DeviceHubSeen | null {
  const [first, ...rest] = stdout.trim().split("\n");
  if (first !== "running" && first !== "none") return null;
  let killed = 0;
  let last: number | null = null;
  try {
    const kills = JSON.parse(rest.join("\n") || "{}") as { killed?: unknown; last?: unknown };
    if (typeof kills.killed === "number") killed = kills.killed;
    if (typeof kills.last === "number") last = kills.last;
  } catch {}
  return { running: first === "running", killed, last };
}
