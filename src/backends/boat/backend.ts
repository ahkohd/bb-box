import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { joinScript, leaveScript, tailnetHostname, type Tailnet } from "../../core/tailnet.ts";
import { CUA_DRIVER } from "../docker/backend.ts";
import { SELKIES_DISPLAY, selkiesDisplay } from "../selkies.ts";
import { KeyFile, Ssh, SshTransport } from "../../transports/ssh.ts";
import { MIN_DESKTOP, type Display, type SshAccess } from "../../transports/types.ts";
import type { DeviceOffer } from "../../core/device.ts";
import { setupDir } from "../setup-dir.ts";
import {
  BackendError,
  DEVICE_DISPLAY,
  desktopDisplays,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type PowerState,
  type ReleaseHooks,
  type StopReason,
  type WithheldKind,
} from "../types.ts";
import { BoatApi, BoatError, SIZE_SHAPES, perWindow, isRunning, isStarting, isStopped, shapeOf, type BoatFetch, type BoatLimits, type Sandbox, type SizeShape, type SshReach } from "./api.ts";
import { BOAT_KINDS, type BoatConfig, type BoatKind } from "./config.ts";
import { BoatTemplates, CUA_READY, FAILED_BUILD_RETRY_MS, TEMPLATE_ROLE, TRIAL_ROLE, buildWaitWords, type TemplateDeps } from "./templates.ts";
import { CANNOT_ENROL_FIX, bbReach, cannotEnrolWords, type BbReach } from "./reach-bb.ts";
import { storedKeyPair } from "../ssh-key.ts";

export const LABELS = {
  install: "bbbox-install",
  box: "bbbox-box",
  thread: "bbbox-thread",
  name: "bbbox-name",
  kind: "bbbox-kind",
  created: "bbbox-created",
  role: "bbbox-role",
  key: "bbbox-key",
} as const;

export const READY_TIMEOUT_MS = 5 * 60_000;
export const DESKTOP_READY_TIMEOUT_MS = 10 * 60_000;
export const BOX_USER = "box";
export const BUSY_RETRY_MS = 15_000;
export const BUSY_GIVES_UP_AFTER_MS = 2 * 60_000;
export const LIMITS_KEPT_MS = 30_000;
const SSH_KEY = "ssh-key";
const SSH_POLL_MS = 300;
const STATE_WITHIN_MS = 5 * 60_000;
const VNC_PORT = 5900;
const VNC_PASSWORD_FILE = "/var/lib/bb-box/vnc-password";
const DISPLAY_MODE_FILE = "/run/bb-box/display-mode";
const DISPLAY_WAIT_MS = 300_000;
const RESTORE_WAIT_MS = 5 * 60_000;
export const BOAT_READY_FILE = "/run/bb-box/boat-ready";
const SETTLED_SCRIPT = `test -e ${BOAT_READY_FILE} && docker info >/dev/null 2>&1`;
const SETTLE_KICK_AFTER_MS = 20_000;
const SETTLE_KICK = "sudo -n systemctl daemon-reload; sudo -n systemctl start --no-block bb-box-boat-ready.service docker.service";
const NAME_PREFIX = "bb-box:";
const MIB_PER_GB = 1024;
const STALE_DEVICE_MS = 15 * 60_000;
const BOAT_HOST = "boat.dev";

const LINUX_TAILSCALE = [
  "set -eu",
  "if ! command -v tailscale >/dev/null; then",
  '  work=$(mktemp -d); trap \'rm -rf "$work"\' EXIT',
  '  tarball=$(curl -fsSL "https://pkgs.tailscale.com/stable/?mode=json" | sed -n \'s/.*"amd64": *"\\(tailscale_[^"]*_amd64\\.tgz\\)".*/\\1/p\' | head -n 1)',
  '  [ -n "$tarball" ] || { echo "Tailscale\'s download page named no amd64 build." >&2; exit 1; }',
  '  curl -fsSL "https://pkgs.tailscale.com/stable/$tarball" | tar -xzf - -C "$work"',
  '  sudo -n install -m 0755 "$work"/tailscale_*/tailscale "$work"/tailscale_*/tailscaled /usr/local/bin/',
  "fi",
  "sudo -n mkdir -p /var/lib/tailscale /var/run/tailscale",
  'pgrep -x tailscaled >/dev/null || sudo -n sh -c "nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >/var/log/tailscaled.log 2>&1 </dev/null &"',
  "for attempt in 1 2 3 4 5 6 7 8 9 10; do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 1; done",
].join("\n");

const COMMAND = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true } as const;

const LINUX_KIND: BoxKind = {
  id: "linux",
  label: "Linux",
  description:
    "A Linux VM on boat.dev with its own kernel, systemd, Docker and KVM, forked from bb-box's template and ready in 10 to 25 seconds. It is billed by the second while it runs, and deleted when released.",
  requires: [],
  capabilities: {
    os: "linux",
    arch: "x86_64",
    gpu: false,
    features: ["docker", "kernel", "kvm"],
    command: COMMAND,
    displays: [],
    computerUse: null,
    enrol: true,
    device: null,
  },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

const LINUX_DESKTOP_KIND: BoxKind = {
  id: "linux-desktop-cpu",
  label: "Linux desktop",
  description:
    "A Linux desktop VM on boat.dev drawn by the CPU, with its own kernel, systemd, Docker and KVM, for computer use and browsers. It is billed by the second while it runs, and deleted when released.",
  requires: [],
  capabilities: {
    ...LINUX_KIND.capabilities,
    displays: [{ id: "desktop", protocol: "rfb", resizable: true }, SELKIES_DISPLAY],
    computerUse: CUA_DRIVER,
  },
  readyTimeoutMs: DESKTOP_READY_TIMEOUT_MS,
};

export function ownKeyScript(publicKey: string): string {
  const line = publicKey.trim().replace(/'/g, "");
  return [
    "set -eu",
    `for home in /home/${BOX_USER} /root; do`,
    '  owner=$(stat -c %U "$home")',
    '  sudo -n install -d -m 0700 -o "$owner" -g "$owner" "$home/.ssh"',
    `  printf '%s\\n' '${line}' | sudo -n tee "$home/.ssh/authorized_keys" >/dev/null`,
    '  sudo -n chown "$owner:$owner" "$home/.ssh/authorized_keys"',
    '  sudo -n chmod 0600 "$home/.ssh/authorized_keys"',
    "done",
  ].join("\n");
}

const ANDROID_KIND: BoxKind = {
  id: "android",
  label: "Android emulator",
  description:
    "An Android emulator device, a phone, foldable or tablet, booted in a Linux VM on boat.dev with KVM, for installing, running and testing Android apps, with its screen shown in the panel. Commands run on the Linux host, as the box user with sudo, with the Android SDK in /opt/android-sdk; adb takes the device as emulator-5554.",
  requires: [],
  capabilities: { ...LINUX_KIND.capabilities, displays: [DEVICE_DISPLAY], device: null },
  readyTimeoutMs: READY_TIMEOUT_MS,
};

function androidKind(device: DeviceOffer): BoxKind {
  return { ...ANDROID_KIND, capabilities: { ...ANDROID_KIND.capabilities, device } };
}

export function androidLicenceLine(setup = setupDir()): string | null {
  try {
    const pins = JSON.parse(readFileSync(join(setup, "android", "pins.json"), "utf8")) as { license?: { accepted?: unknown } };
    return typeof pins.license?.accepted === "string" ? pins.license.accepted : null;
  } catch {
    return null;
  }
}

const KINDS: Readonly<Record<BoatKind, BoxKind>> = { linux: LINUX_KIND, "linux-desktop-cpu": LINUX_DESKTOP_KIND, android: ANDROID_KIND };

export interface BoatBackendOptions {
  readonly fetch?: BoatFetch;
  readonly endpoint?: string;
  readonly sshBinary?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly busyGivesUpAfterMs?: number;
  readonly templates?: Partial<Pick<TemplateDeps, "fingerprint" | "setupArchive" | "buildEnv">>;
  readonly tailscaleScript?: string;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly ownKeyScript?: (publicKey: string) => string;
  readonly settledScript?: string;
  readonly kinds?: readonly BoatKind[];
  readonly cuaReadyScript?: string;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

export function sizeFor(size: BoxSize, allowed: (shape: SizeShape) => boolean = () => true): SizeShape | null {
  return SIZE_SHAPES.find((shape) => allowed(shape) && shape.cores >= size.cores && shape.memoryGB * MIB_PER_GB >= size.memoryMiB && (size.diskGiB === null || shape.diskGB >= size.diskGiB)) ?? null;
}

export function sizeWords(shape: SizeShape): string {
  return `${shape.size}: ${shape.cores} cores, ${shape.memoryGB} GB, ${shape.diskGB} GB disk, $${shape.dollarsPerHour} an hour`;
}

export function knownHostsLine(reach: SshReach): string {
  return `${reach.port === 22 ? reach.host : `[${reach.host}]:${reach.port}`} ${reach.hostKey}`;
}

export function sandboxName(box: Pick<BoxIdentity, "threadId" | "name">): string {
  return `${NAME_PREFIX}${box.threadId}:${box.name}`.slice(0, 120);
}

export function ownerOf(sandbox: Sandbox): BoxOwner | null {
  const boxId = sandbox.labels[LABELS.box];
  if (!boxId) return null;
  const renamed = sandbox.name.startsWith(NAME_PREFIX) ? sandbox.name.slice(NAME_PREFIX.length) : null;
  const at = renamed?.indexOf(":") ?? -1;
  const threadId = renamed && at > 0 ? renamed.slice(0, at) : sandbox.labels[LABELS.thread];
  if (!threadId) return null;
  const created = Number(sandbox.labels[LABELS.created]);
  return {
    boxId,
    threadId,
    name: renamed && at > 0 ? renamed.slice(at + 1) : (sandbox.labels[LABELS.name] ?? null),
    kind: sandbox.labels[LABELS.kind] ?? null,
    createdAt: Number.isFinite(created) ? created : null,
  };
}

export function powerOf(sandbox: Sandbox): PowerState {
  if (isRunning(sandbox.state) || isStarting(sandbox.state)) return "running";
  if (isStopped(sandbox.state)) return "stopped";
  return "unknown";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BoatBackend implements Backend {
  readonly id: string;
  readonly label = "boat.dev";
  readonly nature = "virtual" as const;
  readonly hostOs = "linux" as const;
  readonly #config: BoatConfig;
  readonly #context: BackendContext;
  readonly #options: BoatBackendOptions;
  readonly #api: BoatApi;
  readonly #keyFile = new KeyFile();
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #reaches = new Map<string, SshReach>();
  readonly #acquiring = new Set<string>();
  readonly templates: BoatTemplates;
  #knownHostsPath: string | null = null;
  #ssh: Promise<{ ssh: Ssh; publicKey: string }> | null = null;
  #limits: { readonly at: number; readonly limits: Promise<BoatLimits> } | null = null;
  #bbReach: { readonly at: number; readonly reach: Promise<BbReach> } | null = null;
  #androidOffer: DeviceOffer | null = null;

  constructor(config: BoatConfig, context: BackendContext, options: BoatBackendOptions = {}) {
    if (!config.key) throw new BackendError("unsupported", "boat.dev has no API key: set it in BB Box's settings.");
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.id = context.id;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepFor;
    this.#api = new BoatApi({ key: config.key, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.endpoint ? { endpoint: options.endpoint } : {}), sleep: this.#sleep, now: this.#now, ...(context.log ? { log: (line: string) => context.log!(line) } : {}) });
    this.templates = new BoatTemplates({
      api: this.#api,
      storage: context.storage,
      installId: context.installId,
      labelKeys: { install: LABELS.install, role: LABELS.role, kind: LABELS.kind, key: LABELS.key },
      publicKey: async () => (await this.#keys()).publicKey,
      reach: async (sandbox, user, signal) => this.#command(sandbox, user, signal),
      forget: (sandbox) => this.#forget(sandbox),
      answers: (sandbox, user, deadline, signal) => this.#answers(sandbox, user, deadline, signal),
      settled: (sandbox, deadline, signal) => this.#settled(sandbox, deadline, signal),
      restored: (sandbox, deadline, signal) => this.#restored(sandbox, deadline, signal),
      ...(options.cuaReadyScript ? { cuaReady: options.cuaReadyScript } : {}),
      now: this.#now,
      sleep: this.#sleep,
      log: (line) => context.log?.(line),
      androidLicence: () => (this.#config.androidLicence ? androidLicenceLine() : null),
      sizeFor: async (kind) => (kind === "android" && (await this.#readLimits()).sizes.find((each) => each.size === "large")?.available ? "large" : "default"),
      ...options.templates,
    });
    void this.#readAndroidOffer().catch((error) => context.logError("read boat's Android template", error));
  }

  kinds(): readonly BoxKind[] {
    return this.#offered().flatMap((kind) => {
      if (kind !== "android") return [KINDS[kind]];
      return this.#config.androidLicence && this.#androidOffer ? [androidKind(this.#androidOffer)] : [];
    });
  }

  async withheldKinds(kind: string): Promise<readonly WithheldKind[]> {
    if (kind !== "android" || !(this.#offered() as readonly string[]).includes("android")) return [];
    if (!this.#config.androidLicence) return [{ kind, why: "The Android SDK's licence is not accepted in boat.dev's settings in BB Box, so boat.dev offers no Android boxes. Turning Android SDK licence on there is the acceptance.", passing: false }];
    if (this.#androidOffer) return [];
    const why = this.templates.building("android")
      ? `boat.dev is building its Android template, about ${buildWaitWords("android", null).match(/about (\d+) minutes/)?.[1] ?? "30"} minutes; Android boxes come once it is ready.`
      : "boat.dev has no Android template yet; bb-box builds it in its next upkeep, within a few minutes, and Android boxes come once it is ready.";
    return [{ kind, why, passing: false }];
  }

  async #readAndroidOffer(): Promise<void> {
    const record = await this.templates.record("android");
    const devices = record?.devices;
    const offer = Array.isArray(devices) && devices.length ? ({ platform: "android", devices } as unknown as DeviceOffer) : null;
    const changed = JSON.stringify(offer) !== JSON.stringify(this.#androidOffer);
    this.#androidOffer = offer;
    if (changed) this.#context.kindsChanged?.();
  }

  offerNote(kind: string): string | null {
    return (this.#offered() as readonly string[]).includes(kind) ? "A VM on boat.dev, forked from bb-box's template, billed by the second while it runs." : null;
  }

  async capacity(kind: string, size: BoxSize, pending: readonly { readonly kind: string; readonly size: BoxSize }[], signal?: AbortSignal): Promise<Capacity> {
    const boatKind = this.#kind(kind);
    const limits = await this.#readLimits(signal);
    const allowed = (shape: SizeShape) => limits.sizes.find((each) => each.size === shape.size)?.available ?? true;
    const problems: string[] = [];
    const shape = sizeFor(size, allowed);
    if (!shape) problems.push(this.#tooBig(size, limits));
    const account = (await this.#api.list({}, signal)).filter((sandbox) => isRunning(sandbox.state) || isStarting(sandbox.state));
    const mine = account.filter((sandbox) => sandbox.labels[LABELS.install] === this.#context.installId).length + pending.length;
    const running = account.length + pending.length;
    const needed = (await this.templates.record(boatKind)) || this.templates.building(boatKind) || (await this.templates.adoptable(boatKind, signal).catch(() => null)) ? 1 : 2;
    const plan = limits.tier === "trial" ? "boat's free trial" : "boat's plan";
    if (limits.activeSandboxes && running + needed > limits.activeSandboxes) {
      const others = running - mine;
      problems.push(
        `${plan} allows ${limits.activeSandboxes} sandboxes at once, and ${running} ${running === 1 ? "is" : "are"} running or starting${others > 0 ? `, ${others} of them not bb-box's` : ""}` +
          (needed === 2 ? `. This box's template must be built first, in a sandbox of its own: ${buildWaitWords(boatKind, null).replace(/^Building /, "building ")}` : ".") +
          " Release or stop a boat box, or ask another backend.",
      );
    }
    if (mine + needed - 1 >= this.#config.mostBoxes) problems.push(`bb-box has ${mine} of the ${this.#config.mostBoxes} boat sandboxes it may run at once${needed === 2 ? ", and this box's template needs one more while it is built" : ""}. Release or stop a boat box, or raise Most boxes in BB Box's settings.`);
    if (limits.computeCapSeconds !== null && limits.computeUsedSeconds !== null && limits.computeUsedSeconds >= limits.computeCapSeconds)
      problems.push("The boat trial's compute hours are used up. Make a payment in boat's dashboard to end the trial, or use another backend.");
    const window = limits.starts.find((each) => each.remaining <= 0);
    if (window) problems.push(`boat allows ${window.limit} sandbox starts ${perWindow(window.window)}, and they are used up. Try again when the ${window.window} is over, or use another backend.`);
    const ok = problems.length === 0;
    return { ok, message: ok ? null : problems[0]!, warm: { ready: 0, target: 0 }, hosts: [{ host: BOAT_HOST, ok, limits: [{ resource: "guests", used: running, total: limits.activeSandboxes || null, reserve: 0, unit: "count" }] }] };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const limits = await this.#readLimits(signal);
    const shape = sizeFor(box.size, (each) => limits.sizes.find((size) => size.size === each.size)?.available ?? true);
    if (!shape) throw new BackendError("no_capacity", this.#tooBig(box.size, limits));
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    this.#acquiring.add(box.boxId);
    let made: Sandbox | null = null;
    try {
      const earlier = typeof previous?.data?.sandbox === "string" ? await this.#api.get(previous.data.sandbox, signal) : null;
      if (earlier && earlier.labels[LABELS.install] === this.#context.installId && earlier.labels[LABELS.box] === box.boxId) made = earlier;
      await hooks.claim(this.#guest(box.boxId, made, shape));
      if (!made) {
        const template = await this.templates.forBox(kind, signal, async (words) => hooks.waiting?.(words));
        made = await step("fork", () =>
          this.#whileBusy(signal, () =>
            this.#api.fork(template.sandbox, { size: shape.size, ttlSeconds: this.#leaseSeconds(), labels: this.#labels(box, kind), name: sandboxName(box), idempotencyKey: `bbbox-${this.#context.installId}-${box.boxId}` }, signal),
          ),
        );
        await hooks.claim(this.#guest(box.boxId, made, shape));
      }
      await hooks.starting();
      const sandbox = made;
      if (isStopped(sandbox.state)) await this.#api.resume(sandbox.id, { ttlSeconds: this.#leaseSeconds() }, signal);
      await step("ready", () => this.#api.waitFor(sandbox.id, (each) => isRunning(each.state), this.#now() + this.#readyMs(), signal));
      await step("ssh", async () => {
        await this.#reach(sandbox.id, signal, true);
        await this.#answers(sandbox.id, "user", this.#now() + this.#readyMs(), signal);
        const owned = await (await this.#command(sandbox.id, "user", signal)).run((this.#options.ownKeyScript ?? ownKeyScript)((await this.#keys()).publicKey), { timeoutMs: 30_000, signal });
        if (owned.exitCode !== 0) throw new Error(`boat's sandbox ${sandbox.id} did not take bb-box's key for its box user: ${owned.stderr.trim().slice(-300) || `exit ${owned.exitCode}`}`);
        await this.#answers(sandbox.id, BOX_USER, this.#now() + this.#readyMs(), signal);
      });
      await step("settle", () => this.#settled(sandbox.id, this.#now() + this.#readyMs(), signal));
      const tailnet = this.#context.tailnet?.() ?? null;
      if (tailnet) await step("tailnet", () => this.#join(sandbox.id, box.name, tailnet, signal));
      const facts: GuestFact[] = [];
      const reach = await this.#reachOfBb();
      if (reach.from === "nowhere") facts.push({ label: "BB machine", value: `No. ${cannotEnrolWords(reach)} ${CANNOT_ENROL_FIX}` });
      if (desktopDisplays(KINDS[kind].capabilities.displays).length) {
        const mode = await step("display", () => this.#display(sandbox.id, signal));
        if (mode) facts.push({ label: "Display", value: mode });
      }
      if (KINDS[kind].capabilities.computerUse) {
        await step("restore", () => this.#restored(sandbox.id, this.#now() + RESTORE_WAIT_MS, signal));
        await step("computer use", () => this.#computerUse(sandbox.id, signal));
      }
      const guest = this.#guest(box.boxId, sandbox, shape, facts);
      await hooks.claim(guest);
      return guest;
    } catch (error) {
      const leftover = made ?? (await this.#find(box.boxId).catch(() => null));
      if (leftover) {
        await this.#forget(leftover.id);
        await this.#api.delete(leftover.id).catch((cause) => this.#context.logError("delete a boat sandbox after a failed acquire", cause));
      }
      throw this.#asBackendError(error);
    } finally {
      this.#acquiring.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    const sandbox = await this.#mine(guest, signal);
    if (sandbox) {
      if (isRunning(sandbox.state) && this.#context.tailnet?.()) await this.#leave(sandbox.id, ownerOf(sandbox)?.name ?? sandbox.id, signal);
      await this.#forget(sandbox.id);
      await this.#api.delete(sandbox.id, signal);
    }
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const sandbox = await this.#mine(guest, signal);
    return sandbox ? powerOf(sandbox) : null;
  }

  keepsSession(): boolean {
    return false;
  }

  async start(guest: Guest, signal?: AbortSignal, timing: (step: string, ms: number) => void = () => {}): Promise<void> {
    const sandbox = await this.#mine(guest, signal);
    if (!sandbox) throw new BackendError("gone", `boat's sandbox for box ${guest.ref} is gone.`);
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        timing(name, Math.round(performance.now() - started));
      }
    };
    if (sandbox.state === "archiving") await this.#api.waitFor(sandbox.id, (each) => each.state === "archived", this.#now() + STATE_WITHIN_MS, signal);
    if (!isRunning(sandbox.state)) {
      await this.#forget(sandbox.id);
      await step("resume", async () => {
        if (!isStarting(sandbox.state)) await this.#whileBusy(signal, () => this.#api.resume(sandbox.id, { ttlSeconds: this.#leaseSeconds() }, signal));
        await this.#api.waitFor(sandbox.id, (each) => isRunning(each.state), this.#now() + this.#readyMs(), signal);
      });
    }
    await step("ssh", async () => {
      await this.#reach(sandbox.id, signal, true);
      await this.#answers(sandbox.id, BOX_USER, this.#now() + this.#readyMs(), signal);
    });
    await step("settle", () => this.#settled(sandbox.id, this.#now() + this.#readyMs(), signal));
    const kind = (this.#offered() as readonly string[]).includes(sandbox.labels[LABELS.kind] ?? "") ? (sandbox.labels[LABELS.kind] as BoatKind) : null;
    if (kind && desktopDisplays(KINDS[kind].capabilities.displays).length) await step("display", () => this.#display(sandbox.id, signal));
    if (kind && KINDS[kind].capabilities.computerUse) {
      await step("restore", () => this.#restored(sandbox.id, this.#now() + RESTORE_WAIT_MS, signal));
      await step("computer use", () => this.#computerUse(sandbox.id, signal));
    }
    const tailnet = this.#context.tailnet?.() ?? null;
    if (tailnet) await step("tailnet", () => this.#join(sandbox.id, ownerOf(sandbox)?.name ?? sandbox.id, tailnet, signal));
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const sandbox = await this.#mine(guest, signal);
    if (!sandbox) throw new BackendError("gone", `boat's sandbox for box ${guest.ref} is gone.`);
    if (sandbox.state === "archived") return;
    if (isRunning(sandbox.state) && this.#context.tailnet?.()) await this.#leave(sandbox.id, ownerOf(sandbox)?.name ?? sandbox.id, signal);
    await this.#forget(sandbox.id);
    if (sandbox.state !== "archiving") await this.#api.stop(sandbox.id, signal);
    await this.#api.waitFor(sandbox.id, (each) => each.state === "archived", this.#now() + STATE_WITHIN_MS, signal);
  }

  async stopped(guest: Guest, signal?: AbortSignal): Promise<StopReason | null> {
    const sandbox = await this.#mine(guest, signal);
    if (!sandbox) return null;
    if (sandbox.state === "error") return { reason: `boat says the sandbox failed${sandbox.error ? `: ${sandbox.error}` : "."}`, crashed: true, at: null };
    if (!isStopped(sandbox.state)) return null;
    return {
      reason: `boat stopped the sandbox${sandbox.error ? `: ${sandbox.error}` : " at its auto-stop, as bb-box had not renewed it: bb-box was not running, or could not reach boat"}. Its disk is kept for 14 days.`,
      crashed: true,
      at: sandbox.stoppedAt,
    };
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    return (await this.#held(signal)).map((sandbox) => ({ ...this.#guest(sandbox.labels[LABELS.box] ?? sandbox.id, sandbox, shapeOf(sandbox.size)), owner: ownerOf(sandbox), power: powerOf(sandbox) }));
  }

  async relabel(guest: Guest, box: BoxIdentity, _from: string, signal?: AbortSignal): Promise<void> {
    const sandbox = await this.#mine(guest, signal);
    if (sandbox) await this.#api.rename(sandbox.id, sandboxName(box), signal);
  }

  async maintain(signal?: AbortSignal, recordedGuests?: ReadonlySet<string>): Promise<void> {
    const all = await this.#api.list({ [LABELS.install]: this.#context.installId }, signal);
    const lease = this.#leaseSeconds();
    for (const sandbox of all) {
      if (sandbox.labels[LABELS.role] || !isRunning(sandbox.state)) continue;
      if (!recordedGuests?.has(this.#refOf(sandbox)) && !this.#acquiring.has(sandbox.labels[LABELS.box] ?? "")) continue;
      if (sandbox.archiveAfter !== null && sandbox.archiveAfter - this.#now() > lease * 1000 * 0.6) continue;
      await this.#api.extend(sandbox.id, lease, signal).catch((error) => this.#context.logError(`renew boat sandbox ${sandbox.id}'s auto-stop`, error));
    }
    await this.templates.tidy(all.filter((sandbox) => sandbox.labels[LABELS.role] === TEMPLATE_ROLE || sandbox.labels[LABELS.role] === TRIAL_ROLE), signal).catch((error) => this.#context.logError("tidy boat's templates", error));
    const [next] = await this.templates.due(signal).catch(() => []);
    if (next && !this.templates.anyBuilding()) void this.templates.build(next.kind, next.why).catch((error) => this.#context.logError(`build boat's ${next.kind} template`, error));
    await this.#keepAndroidTemplate(signal).catch((error) => this.#context.logError("build boat's Android template", error));
    await this.#readAndroidOffer();
    await this.#removeStaleDevices(all, signal).catch((error) => this.#context.logError("remove boat sandboxes' leftover tailnet devices", error));
  }

  async #keepAndroidTemplate(signal?: AbortSignal): Promise<void> {
    if (!this.#config.androidLicence || !(this.#offered() as readonly string[]).includes("android") || !this.#context.kind("android").enabled) return;
    if (await this.templates.record("android")) return;
    if (await this.templates.keepAdoptable("android", signal)) return;
    if (this.templates.anyBuilding() || (await this.templates.failedLately("android"))) return;
    void this.templates
      .build("android", "Android boxes need it")
      .then(() => this.#readAndroidOffer())
      .catch((error) => this.#context.logError("build boat's Android template", error));
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const sandbox = typeof guest.data?.sandbox === "string" ? guest.data.sandbox : null;
    if (!sandbox) throw new BackendError("gone", `Box ${guest.ref} has no boat sandbox.`);
    const { ssh } = await this.#keys();
    const access = await this.#access(sandbox, BOX_USER);
    const command = new SshTransport(ssh, access, "linux");
    const displays: Display[] = KINDS[this.#kind(kind)].capabilities.displays.map((display) =>
      display.protocol === "selkies"
        ? selkiesDisplay((port) => command.route(port), display)
        : {
            ...display,
            label: "Desktop",
            open: async (signal) => {
              const read = await command.run(`cat ${VNC_PASSWORD_FILE} 2>/dev/null || :`, { timeoutMs: 15_000, signal, maxOutputBytes: 1024 });
              if (read.exitCode !== 0) throw new Error(`Cannot read the desktop's VNC password over SSH: ${read.stderr.trim() || `exit code ${read.exitCode}`}.`);
              const password = read.stdout.trim();
              return { route: ssh.route(await this.#access(sandbox, BOX_USER, signal), VNC_PORT), auth: password ? { type: "vnc-password", password } : { type: "none" } };
            },
            minSize: MIN_DESKTOP,
          },
    );
    return { command, displays, access: { ssh: access, dockerHost: `ssh://${access.user}@${access.host}:${access.port}` } };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [];
    let limits: BoatLimits | null = null;
    try {
      await this.#api.me(signal);
      limits = await this.#readLimits(signal, true);
      checks.push({ id: "boat.api", name: "boat.dev API", status: "ok", detail: `boat's API answers to the key, on its ${limits.tier} plan.`, fix: null });
    } catch (error) {
      const refused = error instanceof BoatError && error.kind === "refused";
      checks.push({
        id: "boat.api",
        name: "boat.dev API",
        status: "fail",
        detail: message(error),
        fix: refused
          ? "Make a new API key in boat's dashboard, or with boat api-key create, and set it in BB Box's settings."
          : error instanceof BoatError && error.kind === "unreachable"
            ? "Check that BB's server reaches boat.dev on port 443, and boat's status page."
            : null,
      });
      return { ok: false, summary: "boat.dev does not answer to the key.", checks, notes };
    }
    checks.push(this.#limitsCheck(limits));
    checks.push(await this.#bbCheck());
    checks.push(await this.#templatesCheck());
    if ((this.#offered() as readonly string[]).includes("android")) checks.push(this.#androidCheck(limits));
    const held = await this.#held(signal).catch(() => []);
    const unclaimed = held.filter((sandbox) => !ownerOf(sandbox));
    const described = held.map((sandbox) => {
      const age = sandbox.createdAt === null ? "" : `, ${Math.round((this.#now() - sandbox.createdAt) / 60_000)} min old`;
      const shape = shapeOf(sandbox.size);
      return `${ownerOf(sandbox)?.name ?? sandbox.id} (${sandbox.id}, ${sandbox.state}${shape ? `, ${shape.size} at $${shape.dollarsPerHour} an hour while it runs` : ""}${age})`;
    });
    checks.push({
      id: "boat.sandboxes",
      name: "Sandboxes",
      status: unclaimed.length ? "warn" : "ok",
      detail: held.length ? `${held.length}, at most ${this.#config.mostBoxes} running at once: ${described.join("; ")}.` : `None now; at most ${this.#config.mostBoxes} running at once.`,
      fix: unclaimed.length ? "bb-box's sweep deletes sandboxes labelled for this install that no box claims." : null,
    });
    notes.push(`A box stops by itself ${this.#config.leaseMinutes} minutes after bb-box last renewed its auto-stop, and keeps its disk for 14 days, free. bb-box renews each box it holds every few minutes, and deletes a box when it is released.`);
    const failing = checks.some((check) => check.status === "fail");
    return { ok: !failing, summary: failing ? "boat.dev needs attention." : `boat.dev answers; ${held.length} sandbox${held.length === 1 ? "" : "es"}.`, checks, notes };
  }

  async dispose(): Promise<void> {
    this.templates.dispose();
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  #limitsCheck(limits: BoatLimits): DoctorCheck {
    const sizes = limits.sizes.length ? limits.sizes : SIZE_SHAPES.map((shape) => ({ size: shape.size, available: true, reason: null }));
    const offered = sizes.filter((each) => each.available).map((each) => shapeOf(each.size)).filter((shape): shape is SizeShape => shape !== null);
    const refused = sizes.filter((each) => !each.available).map((each) => `${each.size}${each.reason ? ` (${each.reason})` : ""}`);
    const starts = limits.starts.map((window) => `${window.remaining} of ${window.limit} ${perWindow(window.window)}`).join(", ");
    const compute =
      limits.computeCapSeconds !== null && limits.computeUsedSeconds !== null
        ? ` The trial has ${((limits.computeCapSeconds - limits.computeUsedSeconds) / 3600).toFixed(1)} of its ${(limits.computeCapSeconds / 3600).toFixed(0)} compute hours left.`
        : limits.includedHoursLeft !== null
          ? ` The plan has ${limits.includedHoursLeft.toFixed(0)} included hours left this period.`
          : "";
    const out = limits.computeCapSeconds !== null && limits.computeUsedSeconds !== null && limits.computeUsedSeconds >= limits.computeCapSeconds;
    return {
      id: "boat.limits",
      name: "Plan limits",
      status: out ? "fail" : starts && limits.starts.some((window) => window.remaining === 0) ? "warn" : "ok",
      detail: `${limits.activeSandboxes} sandboxes at once; starts left: ${starts || "not said"}. Sizes: ${offered.map(sizeWords).join("; ")}${refused.length ? `. Not allowed: ${refused.join(", ")}` : ""}.${compute}`,
      fix: out ? "Make a payment in boat's dashboard to end the trial, or turn the boat backend off." : null,
    };
  }

  async #reachOfBb(): Promise<BbReach> {
    if (!this.#bbReach || this.#now() - this.#bbReach.at > 5 * 60_000) {
      const reach = bbReach(this.#context.bbUrl?.() ?? null, !!this.#context.tailnet?.(), this.#options.resolve).catch((): BbReach => ({ from: "unknown" }));
      this.#bbReach = { at: this.#now(), reach };
    }
    return this.#bbReach.reach;
  }

  async #bbCheck(): Promise<DoctorCheck> {
    const reach = await this.#reachOfBb();
    const check = { id: "boat.bb" as const, name: "Reaching BB" };
    if (reach.from === "tailnet") return { ...check, status: "ok", detail: "Each boat box joins the tailnet as it starts, and reaches BB's server through it.", fix: null };
    if (reach.from === "url") return { ...check, status: "ok", detail: `boat boxes reach BB's server at ${reach.host}, over the internet.`, fix: null };
    if (reach.from === "nowhere") return { ...check, status: "warn", detail: cannotEnrolWords(reach), fix: CANNOT_ENROL_FIX };
    return { ...check, status: "skipped", detail: "bb-box knows no URL for BB's server here, so it cannot tell whether boat boxes reach it.", fix: null };
  }

  #androidCheck(limits: BoatLimits): DoctorCheck {
    const check = { id: "boat.android" as const, name: "Android" };
    if (!this.#config.androidLicence) return { ...check, status: "ok", detail: "Off: the Android SDK's licence is not accepted in boat.dev's settings, so boat.dev offers no Android boxes.", fix: null };
    const allowed = [...SIZE_SHAPES].reverse().find((shape) => limits.sizes.find((each) => each.size === shape.size)?.available ?? true);
    const sizes = allowed ? ` The plan allows Android boxes of at most ${allowed.cores} cores and ${allowed.memoryGB} GB (boat's ${allowed.size})${allowed.size === "default" || allowed.size === "small" ? `, less than the kind's presets: ask for cores ${allowed.cores} and memory_gib ${allowed.memoryGB}; a paid plan allows the large size of 8 cores and 16 GB` : ""}.` : "";
    if (this.#androidOffer) return { ...check, status: "ok", detail: `Offered, with ${(this.#androidOffer.devices as readonly unknown[]).length} devices from the template.${sizes}`, fix: null };
    return { ...check, status: "warn", detail: `Not offered yet: ${this.templates.building("android") ? "its template is being built" : "its template is built at the next upkeep"}.${sizes}`, fix: null };
  }

  async #templatesCheck(): Promise<DoctorCheck> {
    const lines: string[] = [];
    const failures: string[] = [];
    for (const kind of this.#offered()) {
      const record = await this.templates.record(kind);
      const building = this.templates.building(kind) ? ", being built now" : "";
      if (!record) {
        const adoptable = await this.templates.adoptable(kind).catch(() => null);
        lines.push(adoptable ? `${kind}: ${adoptable.id}, built ${adoptable.labels[LABELS.install] === this.#context.installId ? "here before" : "by another install on this account"}, which boxes fork${building}` : `${kind}: none yet, built when a box first needs it${building}`);
        continue;
      }
      const days = Math.floor((this.#now() - record.builtAt) / (24 * 3_600_000));
      const why = await this.templates.whyBuild(kind);
      lines.push(`${kind}: ${record.sandbox}, built ${days} day${days === 1 ? "" : "s"} ago${record.buildMs ? ` in ${Math.round(record.buildMs / 60_000)} minutes` : ""}${why ? `, due again as ${why}` : ""}${building}`);
    }
    for (const kind of this.#offered()) {
      const failed = await this.templates.failedBuild(kind);
      if (failed) failures.push(`${kind}'s last build failed at ${new Date(failed.at).toISOString().slice(11, 16)} UTC, and is tried again ${Math.round(FAILED_BUILD_RETRY_MS / 3_600_000)} hours later or when a box needs it: ${failed.why}`);
    }
    return { id: "boat.templates", name: "Templates", status: failures.length ? "warn" : "ok", detail: `Stopped sandboxes boxes fork, at no cost: ${lines.join("; ")}.${failures.length ? ` ${failures.join(" ")}` : ""}`, fix: failures.length ? "bb-box's log shows each build's steps. A box of the kind tries the build again at once." : null };
  }

  async #readLimits(signal?: AbortSignal, fresh = false): Promise<BoatLimits> {
    if (!fresh && this.#limits && this.#now() - this.#limits.at < LIMITS_KEPT_MS) return this.#limits.limits;
    const pending = this.#api.limits(signal);
    this.#limits = { at: this.#now(), limits: pending };
    pending.catch(() => {
      if (this.#limits?.limits === pending) this.#limits = null;
    });
    return pending;
  }

  #tooBig(size: BoxSize, limits: BoatLimits): string {
    const asked = `${size.cores} cores and ${Math.round(size.memoryMiB / MIB_PER_GB)} GiB${size.diskGiB !== null ? ` with ${size.diskGiB} GiB of disk` : ""}`;
    const largest = [...SIZE_SHAPES].reverse().find((shape) => limits.sizes.find((each) => each.size === shape.size)?.available ?? true);
    const fits = sizeFor(size);
    if (fits && largest) return `boat's ${fits.size} size would hold ${asked}, but the plan does not allow it now: the largest it allows is ${sizeWords(largest)}. Ask for less, or use another backend.`;
    return `boat's largest size has ${SIZE_SHAPES[SIZE_SHAPES.length - 1]!.cores} cores and ${SIZE_SHAPES[SIZE_SHAPES.length - 1]!.memoryGB} GB, less than the ${asked} asked for.`;
  }

  async #whileBusy<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const gives = this.#now() + (this.#options.busyGivesUpAfterMs ?? BUSY_GIVES_UP_AFTER_MS);
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof BoatError) || error.kind !== "busy" || this.#now() >= gives) throw error;
        await this.#sleep(Math.min(Math.max(error.retryAfterMs ?? BUSY_RETRY_MS, 1_000), BUSY_RETRY_MS), signal);
      }
    }
  }

  #asBackendError(error: unknown): unknown {
    if (!(error instanceof BoatError)) return error;
    if (error.kind === "full" || error.kind === "busy" || error.kind === "unpaid") return new BackendError("no_capacity", error.message);
    if (error.kind === "gone") return new BackendError("gone", error.message);
    return error;
  }

  #offered(): readonly BoatKind[] {
    return this.#options.kinds ?? BOAT_KINDS;
  }

  #leaseSeconds(): number {
    return this.#config.leaseMinutes * 60;
  }

  #readyMs(): number {
    return this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  #kind(kind: string): BoatKind {
    if (!(this.#offered() as readonly string[]).includes(kind)) throw new BackendError("unsupported", `boat.dev offers ${this.#offered().join(" and ")} boxes, not ${kind}.`);
    return kind as BoatKind;
  }

  #labels(box: BoxIdentity, kind: BoatKind): Record<string, string> {
    return {
      [LABELS.install]: this.#context.installId,
      [LABELS.box]: box.boxId,
      [LABELS.thread]: box.threadId,
      [LABELS.name]: box.name.slice(0, 256),
      [LABELS.kind]: kind,
      [LABELS.created]: String(box.createdAt),
    };
  }

  #refOf(sandbox: Sandbox): string {
    return `bbbox-${sandbox.labels[LABELS.box] ?? sandbox.id}`;
  }

  #guest(boxId: string, sandbox: Sandbox | null, shape: SizeShape | null, facts: readonly GuestFact[] = []): Guest {
    const reach = sandbox ? this.#reaches.get(sandbox.id) : undefined;
    const all: GuestFact[] = [...(shape ? [{ label: "Size", value: sizeWords(shape) }] : []), ...facts];
    return {
      ref: `bbbox-${boxId}`,
      host: BOAT_HOST,
      address: reach ? `${reach.host}:${reach.port}` : null,
      size: shape ? { cores: shape.cores, memoryMiB: shape.memoryGB * MIB_PER_GB, diskGiB: shape.diskGB } : null,
      data: { box: boxId, ...(sandbox ? { sandbox: sandbox.id } : {}) },
      ...(all.length ? { facts: all } : {}),
    };
  }

  async #held(signal?: AbortSignal): Promise<Sandbox[]> {
    return (await this.#api.list({ [LABELS.install]: this.#context.installId }, signal)).filter((sandbox) => !sandbox.labels[LABELS.role]);
  }

  async #find(boxId: string, signal?: AbortSignal): Promise<Sandbox | null> {
    return (await this.#api.list({ [LABELS.install]: this.#context.installId, [LABELS.box]: boxId }, signal))[0] ?? null;
  }

  async #mine(guest: Guest, signal?: AbortSignal): Promise<Sandbox | null> {
    const boxId = typeof guest.data?.box === "string" ? guest.data.box : null;
    const id = typeof guest.data?.sandbox === "string" ? guest.data.sandbox : boxId ? ((await this.#find(boxId, signal))?.id ?? null) : null;
    if (!id) return null;
    const sandbox = await this.#api.get(id, signal);
    if (!sandbox || sandbox.labels[LABELS.install] !== this.#context.installId) return null;
    if ((sandbox.labels[LABELS.box] ?? null) !== boxId) return null;
    return sandbox;
  }

  async #reach(sandbox: string, signal?: AbortSignal, fresh = false): Promise<SshReach> {
    const known = this.#reaches.get(sandbox);
    if (known && !fresh) return known;
    const { publicKey } = await this.#keys();
    const reach = await this.#whileBusy(signal, () => this.#api.sshKey(sandbox, publicKey, signal));
    if (!known || knownHostsLine(known) !== knownHostsLine(reach)) {
      if (known) await this.#forget(sandbox);
      this.#reaches.set(sandbox, reach);
      await this.#writeKnownHosts();
    }
    return reach;
  }

  async #writeKnownHosts(): Promise<void> {
    const path = await this.#knownHosts();
    await writeFile(path, [...this.#reaches.values()].map(knownHostsLine).join("\n") + "\n", { mode: 0o600 });
  }

  async #knownHosts(): Promise<string> {
    this.#knownHostsPath ??= join(await this.#keyFile.shareDir(), "known_hosts");
    return this.#knownHostsPath;
  }

  async #access(sandbox: string, user: "user" | "box", signal?: AbortSignal): Promise<SshAccess> {
    const reach = await this.#reach(sandbox, signal);
    return { host: reach.host, port: reach.port, user, hostKeys: [knownHostsLine(reach)] };
  }

  async #command(sandbox: string, user: "user" | "box", signal?: AbortSignal): Promise<SshTransport> {
    const { ssh } = await this.#keys();
    return new SshTransport(ssh, await this.#access(sandbox, user, signal), "linux");
  }

  async #answers(sandbox: string, user: "user" | "box", deadline: number, signal?: AbortSignal): Promise<void> {
    let last = "";
    let reread = this.#now() + 20_000;
    while (this.#now() < deadline) {
      signal?.throwIfAborted();
      const command = await this.#command(sandbox, user, signal);
      if (await command.answers(signal).catch(() => false)) return;
      const probe = await command.run("true", { timeoutMs: 15_000, signal }).catch((error: unknown) => ({ exitCode: -1, stderr: message(error) }));
      if (probe.exitCode === 0) return;
      last = probe.stderr.trim();
      if (this.#now() >= reread) {
        await this.#reach(sandbox, signal, true);
        reread = this.#now() + 20_000;
      }
      await this.#sleep(SSH_POLL_MS, signal);
    }
    throw new Error(`boat's sandbox ${sandbox} did not answer SSH as ${user} in time${last ? `: ${last}` : ""}.`);
  }

  async #settled(sandbox: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(sandbox, BOX_USER, signal);
    const kickAt = this.#now() + SETTLE_KICK_AFTER_MS;
    let kicked = false;
    let last = "";
    while (this.#now() < deadline) {
      const read = await command.run(this.#options.settledScript ?? SETTLED_SCRIPT, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: message(error) }));
      if (read.exitCode === 0) return;
      last = read.stderr.trim();
      if (!kicked && this.#now() >= kickAt) {
        kicked = true;
        await command.run(SETTLE_KICK, { timeoutMs: 60_000, signal, maxOutputBytes: 4096 }).catch(() => undefined);
        this.#context.log?.(`boat: sandbox ${sandbox} had not run bb-box-boat-ready ${Math.round(SETTLE_KICK_AFTER_MS / 1000)} s after it answered, so bb-box started it.`);
      }
      await this.#sleep(250, signal);
    }
    throw new Error(`boat's sandbox ${sandbox} did not finish restoring its template in time: ${BOAT_READY_FILE} is missing or Docker does not answer${last ? ` (${last})` : ""}. Check bb-box-boat-ready.service and docker.service in the box.`);
  }

  async #restored(sandbox: string, deadline: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.#api.waitFor(sandbox, (each) => each.hydrated, deadline, signal);
    } catch (error) {
      if (!(error instanceof BoatError && error.kind === "busy")) throw error;
      this.#context.log?.(`boat: sandbox ${sandbox} was still restoring its template ${Math.round(RESTORE_WAIT_MS / 1000)} s on, so bb-box starts Cua Driver before boat has finished.`);
    }
  }

  async #computerUse(sandbox: string, signal?: AbortSignal): Promise<void> {
    const ready = await (await this.#command(sandbox, BOX_USER, signal)).run(this.#options.cuaReadyScript ?? CUA_READY, { timeoutMs: 240_000, signal, maxOutputBytes: 8192 });
    if (ready.exitCode !== 0) throw new Error(`boat's sandbox ${sandbox} has no working Cua Driver: ${ready.stderr.trim().slice(-300) || `exit ${ready.exitCode}`}`);
  }

  async #display(sandbox: string, signal?: AbortSignal): Promise<string | null> {
    const command = await this.#command(sandbox, BOX_USER, signal);
    const deadline = this.#now() + DISPLAY_WAIT_MS;
    while (this.#now() < deadline) {
      const read = await command.run(`cat ${DISPLAY_MODE_FILE} 2>/dev/null; :`, { timeoutMs: 15_000, signal, maxOutputBytes: 4096 });
      const mode = read.stdout.split("\n")[0]?.trim() ?? "";
      if (mode) return mode;
      await this.#sleep(250, signal);
    }
    throw new Error(`The box's desktop did not start: ${DISPLAY_MODE_FILE} is missing after ${Math.round(DISPLAY_WAIT_MS / 1000)} s. Check bb-box-display.service in boat's desktop template.`);
  }

  async #join(sandbox: string, name: string, tailnet: Tailnet, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(sandbox, BOX_USER, signal);
    const prepared = await command.run(this.#options.tailscaleScript ?? LINUX_TAILSCALE, { timeoutMs: 180_000, signal });
    if (prepared.exitCode !== 0) throw new Error(`Tailscale did not start in boat's sandbox ${sandbox}: ${prepared.stderr.trim().slice(-300) || `exit ${prepared.exitCode}`}`);
    const key = await tailnet.mintKey({ description: `bb-box boat ${name}` }, signal);
    const joined = await command.run(joinScript(this.#tailnetHostname(name)), { stdin: key.key, timeoutMs: 90_000, signal });
    if (joined.exitCode !== 0) throw new Error(`boat's sandbox ${sandbox} did not join the tailnet: ${joined.stderr.trim().slice(-300) || `exit ${joined.exitCode}`}`);
  }

  async #leave(sandbox: string, name: string, signal?: AbortSignal): Promise<void> {
    const command = await this.#command(sandbox, BOX_USER, signal).catch(() => null);
    await command?.run(leaveScript(), { timeoutMs: 15_000, signal }).catch(() => undefined);
    const tailnet = this.#context.tailnet?.() ?? null;
    if (!tailnet) return;
    const hostname = this.#tailnetHostname(name);
    for (const device of await tailnet.devices(signal).catch(() => [])) if (device.hostname === hostname) await tailnet.removeDevice(device.id, signal).catch(() => undefined);
  }

  async #removeStaleDevices(all: readonly Sandbox[], signal?: AbortSignal): Promise<void> {
    const tailnet = this.#context.tailnet?.();
    if (!tailnet) return;
    const live = new Set(all.filter((sandbox) => isRunning(sandbox.state) || isStarting(sandbox.state)).map((sandbox) => this.#tailnetHostname(ownerOf(sandbox)?.name ?? sandbox.id)));
    for (const device of await tailnet.devices(signal)) {
      if (!device.hostname.startsWith(this.#tailnetHostPrefix()) || live.has(device.hostname)) continue;
      if (device.lastSeen !== null && this.#now() - device.lastSeen < STALE_DEVICE_MS) continue;
      await tailnet.removeDevice(device.id, signal);
      this.#context.log?.(`Removed tailnet device ${device.hostname}, whose boat sandbox is gone.`);
    }
  }

  #tailnetHostPrefix(): string {
    return `bb-box-boat-${tailnetHostname(this.#context.installId)}-`;
  }

  #tailnetHostname(name: string): string {
    return tailnetHostname(`${this.#tailnetHostPrefix()}${name}`);
  }

  async #forget(sandbox: string): Promise<void> {
    const reach = this.#reaches.get(sandbox);
    if (!reach) return;
    const { ssh } = await this.#keys();
    for (const user of [BOX_USER, "user"]) await ssh.forget({ host: reach.host, port: reach.port, user, hostKeys: [knownHostsLine(reach)] }).catch(() => undefined);
  }

  #keys(): Promise<{ ssh: Ssh; publicKey: string }> {
    if (!this.#ssh) {
      const pending = (async () => {
        const stored = await storedKeyPair(this.#context.storage, SSH_KEY);
        const keyPath = await this.#keyFile.path(stored.privateKey);
        const shareDir = await this.#keyFile.shareDir();
        return { ssh: new Ssh({ keyPath, binary: this.#options.sshBinary, shareDir, knownHostsPath: await this.#knownHosts() }), publicKey: stored.publicKey };
      })();
      this.#ssh = pending;
      pending.catch(() => {
        if (this.#ssh === pending) this.#ssh = null;
      });
    }
    return this.#ssh;
  }
}
