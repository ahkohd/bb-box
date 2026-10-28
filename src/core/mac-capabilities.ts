import { createHash } from "node:crypto";
import type { DoctorCheck } from "../backends/types.ts";
import type { CheckId } from "./checks.ts";

export type Measured<T> = { readonly is: "yes"; readonly what: T } | { readonly is: "no"; readonly why: string } | { readonly is: "unknown"; readonly why: string };

export interface SimulatorOffer {
  readonly xcode: string;
  readonly runtimes: readonly string[];
}

export interface HardwareEncoderOffer {
  readonly fullSizeFps: number | null;
}

export interface SoftwareEncoderOffer {
  readonly encoder: string;
}

export interface MacCapabilities {
  readonly simulator: Measured<SimulatorOffer>;
  readonly hardwareEncoder: Measured<HardwareEncoderOffer>;
  readonly softwareEncoder: Measured<SoftwareEncoderOffer>;
}

export type MeasuredWhere = "mac" | "image" | "host";

export interface MacReport {
  readonly mac: string;
  readonly chip: string | null;
  readonly macos: string | null;
  readonly at: number;
  readonly where: MeasuredWhere;
  readonly capabilities: MacCapabilities;
}

export type StreamWay = "hardware" | "software";

export type DeviceRoom = { readonly is: "yes"; readonly way: StreamWay } | { readonly is: "no"; readonly why: string } | { readonly is: "unknown"; readonly why: string };

export const NOT_MEASURED: MacCapabilities = {
  simulator: { is: "unknown", why: "not measured yet" },
  hardwareEncoder: { is: "unknown", why: "not measured yet" },
  softwareEncoder: { is: "unknown", why: "not measured yet" },
};

export const SOFTWARE_ENCODER_PATH = "/usr/local/bin/bb-box-h264";
export const PROBE_FRAMES = 12;
export const CAPABILITIES_STALE_MS = 24 * 60 * 60_000;
export const PROBE_TIMEOUT_MS = 120_000;

const HARDWARE_CHECK_SWIFT = String.raw`import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

let width: Int32 = 1206
let height: Int32 = 2622
let frames = Int(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "12") ?? 12
var made: VTCompressionSession?
let specification = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary
let created = VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264, encoderSpecification: specification, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &made)
guard created == noErr, let session = made else {
  print("hardware=no status=\(created)")
  exit(0)
}
VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
var buffer: CVPixelBuffer?
CVPixelBufferCreate(nil, Int(width), Int(height), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
guard let pixels = buffer else {
  print("hardware=unknown status=no-buffer")
  exit(0)
}
var encoded = 0
var failed: OSStatus = noErr
let started = Date()
for frame in 0..<frames {
  let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: CMTime(value: Int64(frame), timescale: 60), duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { status, _, _ in
    if status == noErr { encoded += 1 } else { failed = status }
  }
  if status != noErr { failed = status; break }
}
VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
let seconds = Date().timeIntervalSince(started)
VTCompressionSessionInvalidate(session)
if encoded > 0 && failed == noErr { print("hardware=yes frames=\(encoded) seconds=\(seconds)") } else { print("hardware=no status=\(failed)") }
`;

export function hardwareCheckHash(): string {
  return createHash("sha256").update(HARDWARE_CHECK_SWIFT).digest("hex").slice(0, 16);
}

function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function macProbeScript(softwareEncoder: string = SOFTWARE_ENCODER_PATH): string {
  const check = `$HOME/.bb-box/probe/hardware-${hardwareCheckHash()}`;
  return `export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
echo "chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "macos=$(sw_vers -productVersion 2>/dev/null)"
developer=$(xcode-select -p 2>/dev/null)
xcode=
case "$developer" in
  */Contents/Developer) [ -d "$developer" ] && xcode=$(xcodebuild -version 2>/dev/null | sed -n 's/^Xcode //p' | head -n 1) ;;
esac
echo "xcode=$xcode"
if [ -n "$xcode" ]; then
  runtimes=$(xcrun simctl list runtimes available 2>/dev/null | sed -n 's/^\\(iOS [0-9.]*\\) .*/\\1/p' | tr '\\n' ',' | sed 's/,$//')
  echo "runtimes=$runtimes"
fi
check=${check}
if [ ! -x "$check" ]; then
  if [ -n "$developer" ] && [ -d "$developer" ] && xcrun --find swiftc >/dev/null 2>&1; then
    mkdir -p "$(dirname "$check")" && work=$(mktemp -d) && printf '%s' ${shellQuoted(HARDWARE_CHECK_SWIFT)} > "$work/check.swift" && xcrun swiftc -O -o "$check.new" "$work/check.swift" >"$work/build.log" 2>&1 && mv "$check.new" "$check" || echo "hardware=unknown why=its check did not build: $(tail -n 1 "$work/build.log" 2>/dev/null)"
    rm -rf "$work"
  else
    echo "hardware=unknown why=the Mac has no Swift compiler to build its check"
  fi
fi
[ -x "$check" ] && "$check" ${PROBE_FRAMES} 2>&1 | tail -n 1
software=${shellQuoted(softwareEncoder)}
if [ -x "$software" ]; then
  said=$("$software" --version 2>&1 | head -n 1)
  [ -n "$said" ] && echo "software=yes encoder=$said" || echo "software=no why=$software did not say its encoder"
else
  echo "software=no why=bb-box-h264 is not installed"
fi
exit 0
`;
}

function fields(line: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of line.matchAll(/(\w+)=((?:(?!\s\w+=).)*)/g)) found.set(match[1]!, match[2]!.trim());
  return found;
}

const VIDEO_TOOLBOX_WORDS: Readonly<Record<string, string>> = {
  "-12902": "VideoToolbox found no encoder (-12902)",
  "-12903": "VideoToolbox could not make a hardware session (-12903)",
  "-12908": "VideoToolbox has no hardware encoder here (-12908)",
  "-12915": "VideoToolbox's encoder is not available here (-12915)",
};

export function parseMacProbe(stdout: string, mac: string, at: number, where: MeasuredWhere): MacReport {
  const lines = stdout.split("\n").map((line) => line.trim());
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? null;
  const xcode = value("xcode");
  const runtimes = (value("runtimes") ?? "").split(",").map((each) => each.trim()).filter(Boolean);
  const simulator: Measured<SimulatorOffer> =
    xcode === null
      ? { is: "unknown", why: "the probe did not say whether the Mac has Xcode" }
      : !xcode
        ? { is: "no", why: "it has no Xcode" }
        : runtimes.length
          ? { is: "yes", what: { xcode, runtimes } }
          : { is: "no", why: `Xcode ${xcode} has no iOS runtime` };
  const hardwareLine = lines.find((line) => line.startsWith("hardware="));
  let hardwareEncoder: Measured<HardwareEncoderOffer> = { is: "unknown", why: "the probe did not say" };
  if (hardwareLine) {
    const found = fields(hardwareLine);
    const is = found.get("hardware");
    if (is === "yes") {
      const frames = Number(found.get("frames"));
      const seconds = Number(found.get("seconds"));
      hardwareEncoder = { is: "yes", what: { fullSizeFps: frames > 0 && seconds > 0 ? Math.round(frames / seconds) : null } };
    } else if (is === "no") {
      const status = found.get("status") ?? "";
      hardwareEncoder = { is: "no", why: VIDEO_TOOLBOX_WORDS[status] ?? `VideoToolbox refused a hardware H.264 session (${status || "no status"})` };
    } else hardwareEncoder = { is: "unknown", why: found.get("why") ?? `its check said ${found.get("status") ?? "nothing"}` };
  }
  const softwareLine = lines.find((line) => line.startsWith("software="));
  let softwareEncoder: Measured<SoftwareEncoderOffer> = { is: "unknown", why: "the probe did not say" };
  if (softwareLine) {
    const said = softwareLine.slice("software=".length);
    if (said.startsWith("yes")) softwareEncoder = { is: "yes", what: { encoder: said.replace(/^yes encoder=/, "").replace(/, source [0-9a-f]+/, "") } };
    else softwareEncoder = { is: "no", why: said.replace(/^no why=/, "") };
  }
  return { mac, chip: value("chip") || null, macos: value("macos") || null, at, where, capabilities: { simulator, hardwareEncoder, softwareEncoder } };
}

export function streamWay(capabilities: MacCapabilities): StreamWay | null {
  if (capabilities.hardwareEncoder.is === "yes") return "hardware";
  if (capabilities.softwareEncoder.is === "yes") return "software";
  return null;
}

export function deviceRoom(capabilities: MacCapabilities): DeviceRoom {
  const { simulator, hardwareEncoder, softwareEncoder } = capabilities;
  if (simulator.is === "no") return { is: "no", why: `It cannot run the iOS Simulator: ${simulator.why}.` };
  const way = streamWay(capabilities);
  if (simulator.is === "yes" && way) return { is: "yes", way };
  if (simulator.is === "unknown") return { is: "unknown", why: `Whether it can run the iOS Simulator is not known: ${simulator.why}.` };
  if (hardwareEncoder.is === "no" && softwareEncoder.is === "no") return { is: "no", why: `It cannot stream a device's screen: ${hardwareEncoder.why}, and ${softwareEncoder.why}.` };
  return { is: "unknown", why: `Whether it can stream a device's screen is not known: ${hardwareEncoder.is === "unknown" ? hardwareEncoder.why : softwareEncoder.is === "unknown" ? softwareEncoder.why : "not measured yet"}.` };
}

export function videoWords(capabilities: MacCapabilities): string {
  const { hardwareEncoder, softwareEncoder } = capabilities;
  const software = softwareEncoder.is === "yes" ? `software (${softwareEncoder.what.encoder.split(",")[0]})` : null;
  if (hardwareEncoder.is === "yes") return software ? `video by its hardware H.264 encoder, ${software} as the fallback` : "video by its hardware H.264 encoder";
  if (software) return `video by ${software}, as it has no hardware H.264 encoder`;
  if (hardwareEncoder.is === "no" && softwareEncoder.is === "no") return "no device video: no hardware H.264 encoder, and no software one";
  return "device video not measured yet";
}

export function capabilityWords(capabilities: MacCapabilities): string {
  const { simulator } = capabilities;
  const runs =
    simulator.is === "yes"
      ? `the iOS Simulator (Xcode ${simulator.what.xcode}, ${simulator.what.runtimes.join(", ")})`
      : simulator.is === "no"
        ? `no iOS Simulator (${simulator.why})`
        : "the iOS Simulator not measured yet";
  return `${runs}; ${videoWords(capabilities)}`;
}

export function offeredWords(reports: readonly MacReport[]): string | null {
  if (!reports.length) return null;
  const groups = new Map<string, number>();
  for (const report of reports) {
    const room = deviceRoom(report.capabilities);
    const words = room.is === "yes" ? `iOS devices, ${videoWords(report.capabilities)}` : room.is === "no" ? "no iOS devices" : "iOS devices not measured yet";
    groups.set(words, (groups.get(words) ?? 0) + 1);
  }
  if (groups.size === 1) {
    const [[words]] = [...groups];
    return reports.length === 1 ? `its Mac: ${words}` : `each of its ${reports.length} Macs: ${words}`;
  }
  return [...groups].map(([words, count]) => `${count === 1 ? "1 Mac" : `${count} Macs`}: ${words}`).join("; ");
}

const WHERE_WORDS: Readonly<Record<MeasuredWhere, string>> = {
  mac: "on the Mac",
  image: "in the iOS image's VM, at its check",
  host: "in a shared iOS host on it",
};

function measuredAgo(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

export function checkSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function capabilityCheck(id: string, label: string, report: MacReport | null, now = Date.now()): DoctorCheck {
  const checkId = `devices.${checkSlug(id)}` as CheckId;
  const name = `iOS devices on ${label}`;
  if (!report) return { id: checkId, name, status: "skipped", detail: "Not measured yet. bb-box measures it the next time it reaches the Mac.", fix: null };
  const room = deviceRoom(report.capabilities);
  const chip = report.chip ? `, an ${report.chip}` : "";
  const detail = `${capitalised(capabilityWords(report.capabilities))}. Measured ${WHERE_WORDS[report.where]}${chip}, ${measuredAgo(report.at, now)}.`;
  if (room.is === "yes") return { id: checkId, name, status: "ok", detail, fix: null };
  if (room.is === "unknown") return { id: checkId, name, status: "warn", detail: `${detail} ${room.why} It lends ios slots meanwhile.`, fix: unknownFix(report.capabilities) };
  return { id: checkId, name, status: "warn", detail: `${detail} ${room.why} It lends no ios slot.`, fix: noRoomFix(report.capabilities) };
}

function unknownFix(capabilities: MacCapabilities): string {
  if (capabilities.hardwareEncoder.is === "unknown" && /Swift compiler/.test(capabilities.hardwareEncoder.why)) return "Install Xcode, or its command line tools, on the Mac, so bb-box can build its encoder check, then run bb box doctor again.";
  return "Run bb box doctor again once the Mac answers; bb-box measures it then.";
}

function noRoomFix(capabilities: MacCapabilities): string {
  if (capabilities.simulator.is === "no") return "Install Xcode and its iOS platform on the Mac, then run bb box doctor again.";
  return "Build bb-box-h264 on the Mac with setup/android/build-h264.sh /usr/local, so it streams in software, then run bb box doctor again.";
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function reportFromJson(value: unknown): MacReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Partial<MacReport>;
  if (typeof report.mac !== "string" || typeof report.at !== "number" || !report.capabilities) return null;
  const known = (measured: unknown): boolean => !!measured && typeof measured === "object" && ["yes", "no", "unknown"].includes((measured as { is?: string }).is ?? "");
  const { simulator, hardwareEncoder, softwareEncoder } = report.capabilities;
  if (!known(simulator) || !known(hardwareEncoder) || !known(softwareEncoder)) return null;
  return {
    mac: report.mac,
    chip: typeof report.chip === "string" ? report.chip : null,
    macos: typeof report.macos === "string" ? report.macos : null,
    at: report.at,
    where: report.where === "image" || report.where === "host" ? report.where : "mac",
    capabilities: report.capabilities,
  };
}

export const CAPABILITIES_KEY_PREFIX = "mac-capabilities/";

export async function loadReports(storage: { get<T>(key: string): Promise<T | undefined>; list(prefix?: string): Promise<string[]> }): Promise<MacReport[]> {
  const reports: MacReport[] = [];
  for (const key of await storage.list(CAPABILITIES_KEY_PREFIX)) {
    const report = reportFromJson(await storage.get<unknown>(key));
    if (report) reports.push(report);
  }
  return reports;
}

export function reportKey(mac: string): string {
  return `${CAPABILITIES_KEY_PREFIX}${mac}`;
}

export function withCapabilities(report: MacReport, changes: Partial<MacCapabilities>, where: MeasuredWhere = report.where): MacReport {
  return { ...report, where, capabilities: { ...report.capabilities, ...changes } };
}

export function hardwareKnown(report: MacReport | null): boolean | null {
  const encoder = report?.capabilities.hardwareEncoder;
  return encoder?.is === "yes" ? true : encoder?.is === "no" ? false : null;
}

export interface IosImageFacts {
  readonly build: string;
  readonly runtime: { readonly os: string; readonly xcode: string } | null;
  readonly softwareEncoder: string | null;
  readonly hardwareEncoder: boolean | null;
}

export function imageCapabilities(mac: string, image: IosImageFacts | null, measured: MacReport | null, now: number): MacReport {
  const simulator: Measured<SimulatorOffer> = !image
    ? { is: "no", why: "the Mac has no iOS image" }
    : image.runtime
      ? { is: "yes", what: { xcode: image.runtime.xcode, runtimes: [`iOS ${image.runtime.os}`] } }
      : { is: "no", why: `the iOS image's build ${image.build} offers no device` };
  const softwareEncoder: Measured<SoftwareEncoderOffer> = !image
    ? { is: "no", why: "the Mac has no iOS image" }
    : image.softwareEncoder
      ? { is: "yes", what: { encoder: image.softwareEncoder } }
      : { is: "no", why: `the iOS image's build ${image.build} has no bb-box-h264` };
  const fromImage = image?.hardwareEncoder ?? null;
  const hardwareEncoder: Measured<HardwareEncoderOffer> =
    fromImage === true ? { is: "yes", what: { fullSizeFps: null } } : fromImage === false ? { is: "no", why: `the iOS image's check found no hardware H.264 encoder in its VM` } : (measured?.capabilities.hardwareEncoder ?? NOT_MEASURED.hardwareEncoder);
  return {
    mac,
    chip: measured?.chip ?? null,
    macos: measured?.macos ?? null,
    at: measured?.at ?? now,
    where: fromImage !== null ? "image" : "mac",
    capabilities: { simulator, hardwareEncoder, softwareEncoder },
  };
}

export interface MacProbes {
  report(mac: string): MacReport | null;
  measure(mac: string, signal?: AbortSignal): Promise<MacReport>;
}

export interface MacProbeCacheOptions {
  readonly run: (mac: string, script: string, signal?: AbortSignal) => Promise<string>;
  readonly where?: MeasuredWhere;
  readonly softwareEncoder?: string;
  readonly now?: () => number;
  readonly staleMs?: number;
  readonly saved?: (report: MacReport) => void;
  readonly logError?: (operation: string, error: unknown) => void;
}

export class MacProbeCache implements MacProbes {
  readonly #options: MacProbeCacheOptions;
  readonly #reports = new Map<string, MacReport>();
  readonly #measuring = new Map<string, Promise<MacReport>>();

  constructor(options: MacProbeCacheOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  remember(report: MacReport): void {
    const known = this.#reports.get(report.mac);
    if (!known || known.at <= report.at) this.#reports.set(report.mac, report);
  }

  report(mac: string): MacReport | null {
    return this.#reports.get(mac) ?? null;
  }

  all(): readonly MacReport[] {
    return [...this.#reports.values()];
  }

  stale(mac: string): boolean {
    const known = this.#reports.get(mac);
    return !known || this.#now() - known.at > (this.#options.staleMs ?? CAPABILITIES_STALE_MS);
  }

  refresh(mac: string): void {
    if (!this.stale(mac) || this.#measuring.has(mac)) return;
    void this.measure(mac).catch((error) => this.#options.logError?.(`measure what ${mac} offers`, error));
  }

  async known(mac: string, signal?: AbortSignal): Promise<MacReport> {
    const known = this.#reports.get(mac);
    if (known && known.capabilities.simulator.is !== "unknown") {
      this.refresh(mac);
      return known;
    }
    return this.measure(mac, signal);
  }

  measure(mac: string, signal?: AbortSignal): Promise<MacReport> {
    const running = this.#measuring.get(mac);
    if (running) return running;
    const measuring = (async () => {
      const stdout = await this.#options.run(mac, macProbeScript(this.#options.softwareEncoder), signal);
      const report = parseMacProbe(stdout, mac, this.#now(), this.#options.where ?? "mac");
      this.remember(report);
      this.#options.saved?.(report);
      return report;
    })().finally(() => this.#measuring.delete(mac));
    this.#measuring.set(mac, measuring);
    return measuring;
  }
}
