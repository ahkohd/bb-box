import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEVICE_SERVER_FILES } from "../src/core/device-delivery.ts";
import { DriverError } from "../src/device/driver.ts";
import { Simctl, type Ran, type Runner } from "../src/device/simctl.ts";
import { LAUNCHCTL, PASTEBOARD_SERVER_LABEL, SESSION_JOB_LABEL, SessionJobs, launchdPlist, pasteboardInOwnSession, pasteboardServerPlist, sessionJobPlist, sessionRoute } from "../src/device/user-session.ts";
import { tempDir } from "./helpers.ts";

const UID = 80061;
const OWN_DOMAIN = `user/${UID}`;

function unescaped(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function plistStrings(plist: string, key: string): string[] {
  const block = new RegExp(`<key>${key}</key><array>([\\s\\S]*?)</array>`).exec(plist)?.[1] ?? "";
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unescaped(match[1]!));
}

function plistString(plist: string, key: string): string | undefined {
  const found = new RegExp(`<key>${key}</key><string>([\\s\\S]*?)</string>`).exec(plist)?.[1];
  return found === undefined ? undefined : unescaped(found);
}

function plistEnvironment(plist: string): Record<string, string> {
  const block = /<key>EnvironmentVariables<\/key><dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/<key>([^<]+)<\/key><string>([\s\S]*?)<\/string>/g)].map((match) => [match[1]!, unescaped(match[2]!)]));
}

class FakeLaunchd {
  readonly calls: string[][] = [];
  readonly loaded = new Map<string, string>();
  readonly jobs = new Map<string, ChildProcess>();
  readonly bootstrapped: string[] = [];
  managerName: string | null = "System";
  guiDomain = false;
  refuseBootstrap: string | null = null;

  readonly run: Runner = async (program, args) => {
    if (program !== LAUNCHCTL) return { code: 0, stdout: `ran ${program} ${args.join(" ")} here`, stderr: "" };
    this.calls.push([...args]);
    const [verb, target, path] = args;
    if (verb === "managername") return this.managerName === null ? { code: 1, stdout: "", stderr: "Could not get manager name." } : { code: 0, stdout: `${this.managerName}\n`, stderr: "" };
    if (verb === "print") {
      if (target === `gui/${UID}`) return this.guiDomain ? { code: 0, stdout: "gui", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find domain" };
      return this.loaded.has(target!) ? { code: 0, stdout: "state = running", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    }
    if (verb === "bootstrap") {
      const plist = readFileSync(path!, "utf8");
      if (this.refuseBootstrap !== null) return { code: 5, stdout: "", stderr: this.refuseBootstrap };
      const label = plistString(plist, "Label")!;
      this.bootstrapped.push(plist);
      this.loaded.set(`${target}/${label}`, plist);
      if (plist.includes("<key>RunAtLoad</key><true/>")) {
        const [shell, ...rest] = plistStrings(plist, "ProgramArguments");
        this.jobs.set(label, spawn(shell!, rest, { cwd: plistString(plist, "WorkingDirectory"), env: plistEnvironment(plist), stdio: "ignore" }));
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "bootout") {
      const label = target!.split("/").at(-1)!;
      this.jobs.get(label)?.kill("SIGTERM");
      this.jobs.delete(label);
      return this.loaded.delete(target!) ? { code: 0, stdout: "", stderr: "" } : { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
    }
    return { code: 64, stdout: "", stderr: `unknown verb ${verb}` };
  };

  verbs(verb: string): string[][] {
    return this.calls.filter((call) => call[0] === verb);
  }

  jobPlists(): string[] {
    return [...this.loaded.entries()].filter(([key]) => key.includes(SESSION_JOB_LABEL)).map(([, plist]) => plist);
  }
}

const ownRoute = sessionRoute("System", UID, false) as Extract<ReturnType<typeof sessionRoute>, { way: "domain" }>;

test("a device server in a desktop session uses the pasteboard where it is; outside one, it goes to the user's own GUI session if there is one, or else to its background session with its own pasteboard server (F-17)", () => {
  assert.deepEqual(sessionRoute("Aqua\n", UID, true), { way: "here" });
  assert.deepEqual(sessionRoute("System", UID, true), { way: "domain", domain: `gui/${UID}`, session: "Aqua", ownPasteboardServer: false });
  assert.deepEqual(sessionRoute("System", UID, false), { way: "domain", domain: OWN_DOMAIN, session: "Background", ownPasteboardServer: true });
  assert.deepEqual(sessionRoute("Background", UID, false), { way: "domain", domain: OWN_DOMAIN, session: "Background", ownPasteboardServer: true });
  assert.deepEqual(sessionRoute(null, UID, false), { way: "domain", domain: OWN_DOMAIN, session: "Background", ownPasteboardServer: true });
});

test("the pasteboard server's plist runs macOS's own pboard for the background session, with its Mach services, and every value is escaped (F-17)", () => {
  const plist = pasteboardServerPlist();
  assert.equal(plistString(plist, "Label"), PASTEBOARD_SERVER_LABEL);
  assert.deepEqual(plistStrings(plist, "ProgramArguments"), ["/usr/libexec/pboard"]);
  assert.equal(plistString(plist, "LimitLoadToSessionType"), "Background");
  assert.match(plist, /<key>MachServices<\/key><dict>\s*<key>com\.apple\.pasteboard\.1<\/key><true\/>/);
  assert.doesNotMatch(plist, /RunAtLoad/, "launchd starts it at its first lookup");
  const job = sessionJobPlist({ label: "a", dir: "/tmp/a & b", session: "Background", program: "/bin/echo", args: ["<in>", "x"], env: { LC_ALL: "en_US.UTF-8" } });
  assert.equal(plistString(job, "WorkingDirectory"), "/tmp/a & b");
  assert.match(job, /<string>&lt;in&gt;<\/string>/);
  assert.match(job, /&lt;in &gt;out 2&gt;err/);
  assert.equal(launchdPlist({ Label: "x" }).split("\n")[0], '<?xml version="1.0" encoding="UTF-8"?>');
});

test("a job in the user's own session gets its input, gives back its output and exit code, loads the pasteboard server once, keeps only the environment it needs, and leaves nothing loaded (F-17)", async (t) => {
  const launchd = new FakeLaunchd();
  const dir = join(tempDir("session"), "session");
  const jobs = new SessionJobs({ route: ownRoute, dir, run: launchd.run, pollMs: 5 });
  process.env.BB_BOX_TEST_SECRET = "not for the plist";
  t.after(() => delete process.env.BB_BOX_TEST_SECRET);

  const first = await jobs.run("/bin/sh", ["-c", 'cat; printf " in %s" "$LC_ALL"; echo oops >&2; exit 3'], { timeoutMs: 10_000, input: "bbtest ✓ é", env: { LC_ALL: "en_US.UTF-8" } });
  assert.deepEqual(first, { code: 3, stdout: "bbtest ✓ é in en_US.UTF-8", stderr: "oops\n" });
  const second = await jobs.run("/bin/sh", ["-c", "cat"], { timeoutMs: 10_000 });
  assert.deepEqual(second, { code: 0, stdout: "", stderr: "" });

  const bootstraps = launchd.verbs("bootstrap");
  assert.equal(bootstraps.length, 3, "the pasteboard server once, then one job each");
  assert.deepEqual(bootstraps[0], ["bootstrap", OWN_DOMAIN, join(dir, `${PASTEBOARD_SERVER_LABEL}.plist`)]);
  assert.ok(launchd.loaded.has(`${OWN_DOMAIN}/${PASTEBOARD_SERVER_LABEL}`), "the pasteboard server stays loaded");
  assert.deepEqual(launchd.jobPlists(), [], "each job is booted out after it ends");
  assert.deepEqual(launchd.verbs("bootout").map((call) => call[1]), [`${OWN_DOMAIN}/${SESSION_JOB_LABEL}.${process.pid}.1`, `${OWN_DOMAIN}/${SESSION_JOB_LABEL}.${process.pid}.2`]);
  assert.deepEqual(readdirSync(dir), [`${PASTEBOARD_SERVER_LABEL}.plist`], "and its folder removed");
  const seen = launchd.bootstrapped[1]!;
  assert.equal(plistString(seen, "LimitLoadToSessionType"), "Background");
  assert.equal(plistEnvironment(seen).LC_ALL, "en_US.UTF-8");
  assert.ok(!seen.includes("BB_BOX_TEST_SECRET"), "the server's own environment is not written to a plist");
});

test("a job that does not end in time is stopped and booted out, and a pasteboard server launchd will not load says why (F-17)", async () => {
  const launchd = new FakeLaunchd();
  const dir = join(tempDir("session-slow"), "session");
  const jobs = new SessionJobs({ route: ownRoute, dir, run: launchd.run, pollMs: 5 });
  const slow = await jobs.run("/bin/sleep", ["5"], { timeoutMs: 150 });
  assert.equal(slow.code, 1);
  assert.equal(slow.stderr, "/bin/sleep did not end within 0.15 s");
  assert.deepEqual(launchd.jobPlists(), []);

  const refusing = new FakeLaunchd();
  refusing.refuseBootstrap = "Bootstrap failed: 5: Input/output error";
  const refused = await new SessionJobs({ route: ownRoute, dir: join(tempDir("session-refused"), "session"), run: refusing.run }).run("/bin/true", [], { timeoutMs: 1000 });
  assert.deepEqual(refused, { code: 1, stdout: "", stderr: `launchd did not load macOS's pasteboard server in ${OWN_DOMAIN}: Bootstrap failed: 5: Input/output error` });
});

test("jobs an earlier device server left are booted out and removed at the first job (F-17)", async () => {
  const launchd = new FakeLaunchd();
  const dir = join(tempDir("session-left"), "session");
  const left = `${SESSION_JOB_LABEL}.1.4`;
  mkdirSync(join(dir, left), { recursive: true });
  writeFileSync(join(dir, left, "job.plist"), "");
  launchd.loaded.set(`${OWN_DOMAIN}/${left}`, "");
  await new SessionJobs({ route: ownRoute, dir, run: launchd.run, pollMs: 5 }).run("/bin/true", [], { timeoutMs: 10_000 });
  assert.ok(!existsSync(join(dir, left)));
  assert.ok(!launchd.loaded.has(`${OWN_DOMAIN}/${left}`));
});

test("simctl sets and reads the device's clipboard through the pasteboard's way, and every other command as before; a shared slot's server says where once (F-17)", async () => {
  const launchd = new FakeLaunchd();
  const ran: string[] = [];
  const run: Runner = async (program, args, options) => {
    if (program === LAUNCHCTL) return launchd.run(program, args, options);
    ran.push(`${program} ${args.join(" ")}`);
    return { code: 0, stdout: "here", stderr: "" } satisfies Ran;
  };
  const lines: string[] = [];
  const dir = join(tempDir("session-simctl"), "session");
  const way = pasteboardInOwnSession({ run, dir, uid: UID, log: (line) => lines.push(line) });
  const jobs: string[] = [];
  const simctl = new Simctl({
    xcrun: "/bin/sh",
    run,
    pasteboard: {
      ready: way.ready,
      run: async (program, args, options) => {
        jobs.push(args.join(" "));
        return way.run("/bin/sh", ["-c", `printf '%s' "$1"`, "sh", `read ${args[1]}`], options);
      },
    },
  });
  assert.equal(await simctl.pasteboardReady(), null);
  assert.ok(launchd.loaded.has(`${OWN_DOMAIN}/${PASTEBOARD_SERVER_LABEL}`), "ready loads the pasteboard server, so the box's own simctl finds it too");
  assert.equal(await simctl.clipboard("UDID-1"), "read pbpaste");
  await simctl.setClipboard("UDID-1", "bbtest");
  await simctl.ui("UDID-1", "appearance");
  assert.deepEqual(jobs, ["simctl pbpaste UDID-1", "simctl pbcopy UDID-1"]);
  assert.deepEqual(ran, ["/bin/sh simctl ui UDID-1 appearance"]);
  assert.deepEqual(lines, [`pasteboard: this server is not in a desktop session, so the device's clipboard is set and read in ${OWN_DOMAIN}, with macOS's pasteboard server loaded there`]);
  assert.equal(launchd.verbs("managername").length, 1, "the session is found once");

  const failing = new Simctl({ run, pasteboard: { ready: async () => null, run: async () => ({ code: 139, stdout: "", stderr: "" }) } });
  await assert.rejects(failing.setClipboard("UDID-1", "x"), (error) => error instanceof DriverError && /simctl could not set the device's clipboard: exit code 139/.test(error.message));
});

test("in a desktop session the pasteboard runs where the server is, with no job and no pasteboard server of its own; with a GUI session elsewhere, its jobs go there (F-17)", async () => {
  const desktop = new FakeLaunchd();
  desktop.managerName = "Aqua";
  const here = pasteboardInOwnSession({ run: desktop.run, dir: join(tempDir("session-aqua"), "session"), uid: UID });
  assert.equal(await here.ready(), null);
  assert.deepEqual(await here.run("/usr/bin/xcrun", ["simctl", "pbpaste", "UDID-1"], { timeoutMs: 1000 }), { code: 0, stdout: "ran /usr/bin/xcrun simctl pbpaste UDID-1 here", stderr: "" });
  assert.deepEqual(desktop.verbs("bootstrap"), []);

  const withGui = new FakeLaunchd();
  withGui.guiDomain = true;
  const gui = pasteboardInOwnSession({ run: withGui.run, dir: join(tempDir("session-gui"), "session"), uid: UID });
  assert.equal(await gui.ready(), null);
  assert.deepEqual(withGui.verbs("bootstrap"), [], "the GUI session has macOS's own pasteboard server");
  assert.deepEqual(await gui.run("/bin/sh", ["-c", "printf gui"], { timeoutMs: 10_000 }), { code: 0, stdout: "gui", stderr: "" });
  assert.equal(withGui.verbs("bootstrap")[0]![1], `gui/${UID}`);
});

test("the device server's delivery carries the user-session module (F-17)", () => {
  assert.ok(DEVICE_SERVER_FILES.includes("src/device/user-session.ts"));
});
