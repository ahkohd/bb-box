// The plugin in SDK's fake plugin host, with the fake backend: the agent
// tools, enrolment as a BB machine, thread events, the panel's RPC, the CLI
// and settings.

import assert from "node:assert/strict";
import type { BackendContext } from "../src/backends/types.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import type { PluginAgentToolResult, PluginSettingValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { DRIVERS } from "../src/backends/index.ts";
import { BackendError, DEVICE_DISPLAY, type BackendDriver, type BoxKind } from "../src/backends/types.ts";
import { DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, stillsRequestText, testDeviceOffer, type OfferedDevices } from "../src/core/device.ts";
import { DeviceLink } from "../src/core/device-link.ts";
import { devicePaths } from "../src/device/paths.ts";
import { DeviceServer } from "../src/device/server.ts";
import { TestDriver } from "../src/device/test-driver.ts";
import type { BoxPointer } from "../src/transports/types.ts";
import { OPERATOR, SPARES, type BoxRecord } from "../src/core/boxes.ts";
import { ACCESS_CHECK_EXITS } from "../src/core/in-box.ts";
import { INSTALL_ID_KEY, newInstallId } from "../src/core/install.ts";
import { setDesktopSize } from "../src/core/rfb.ts";
import { Phases, removeStaleApp, setAsideOtherMachines, withReachHint } from "../src/plugin/enrol.ts";
import { RETIRED_TITLE } from "../src/plugin/holder.ts";
import { FOLLOW_FRAME_MS, POINTER_NONE, sharpOffered } from "../src/plugin/desktop.ts";
import { setup, type SetupOptions } from "../src/plugin/setup.ts";
import { boxPath, ownProcessHint, workspacePath } from "../src/plugin/tools.ts";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { hostEntry } from "../src/host/entry.ts";
import { PAUSED, RETURNED } from "../src/core/computer.ts";
import { waylandPointerScript } from "../src/backends/wayvnc.ts";
import { FAKE_KINDS, FAKE_PWSH, FAKE_SELKIES_KIND, FAKE_WAYLAND_KIND, FAKE_WINDOWS_KIND, FakeBackend, fakeDriver, loseLastByteOfCopies, type FakeBackendOptions } from "./fake-backend.ts";
import { tasksDesktop, type FakeDesktop } from "./fake-cua.ts";
import { FakeSelkies } from "./fake-selkies.ts";
import { fakeDaemon, fakeFfmpeg, joined, tempDir } from "./helpers.ts";

const THREAD = "thr_one";
const PROJECT = "prj_one";

type Host = ReturnType<typeof makeHostResponse>;
type Thread = ReturnType<typeof makeThreadResponse>;

/** BB's file API refuses a relative path. */
function absolute(path: string): string {
  if (!isAbsolute(path)) throw Object.assign(new Error("HTTP 400: Path must be absolute"), { status: 400 });
  return path;
}

/** As BB's file API reads: a path outside the root it is given is refused (#482). */
function withinRoot(path: string, rootPath: string | undefined): void {
  if (rootPath && relative(rootPath, path).startsWith("..")) throw Object.assign(new Error(`HTTP 400: Path "${path}" escapes read root`), { status: 400 });
}

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} not found`), { status: 404, code: "not_found" });
}

/** What BB's SDK throws for a thread that does not exist or was deleted. */
function threadNotFound(): Error {
  return Object.assign(new Error("HTTP 404: Thread not found"), { status: 404, code: "thread_not_found" });
}

function variables(names: readonly string[]) {
  return names.map((name) => ({ name, note: null, secret: true as const, value: null }));
}

/**
 * `daemonParent` stands in for BB's daemon in the boxes. The fake boxes run
 * on this machine as its user, so it must never match BB's real daemon here.
 */
async function start(
  settings: Record<string, PluginSettingValue> = { "fake-enabled": true },
  options: { daemonParent?: string; computer?: SetupOptions["computer"]; drivers?: readonly BackendDriver<any>[]; variablesWaitMs?: number; logonWaitMs?: number; providerRetryMs?: number; manualRemoveMs?: number; appUrl?: string; keepsSession?: (kind: string) => boolean; controlReconnectMs?: number; controlStaleMs?: number; drainMs?: number; runWaitMs?: number } & Pick<FakeBackendOptions, "resize" | "minSize" | "kinds" | "shell" | "pointer"> = {},
) {
  const root = tempDir("plugin");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  // The thread's storage folder, $BB_THREAD_STORAGE (#482).
  const storage = join(root, "thread-storage", THREAD);
  mkdirSync(storage, { recursive: true });
  const threads = new Map<string, Thread>([[THREAD, makeThreadResponse({ id: THREAD, projectId: PROJECT, environmentId: "env_one", providerId: "claude-code" })]]);
  const hosts = new Map<string, Host>();
  const world = {
    root,
    workspace,
    storage,
    /** Other threads' storage folders, by thread ID; a thread not here has `storage`. */
    storages: new Map<string, string>(),
    threads,
    hosts,
    backend: null as FakeBackend | null,
    /** The context bb-box gave each fake backend it made. */
    contexts: [] as BackendContext[],
    /** Keys BB's bootstrap ran with, in order. */
    bootstraps: [] as string[],
    /** The script BB's installer runs in the box. */
    installer: "echo installed > bb-installed",
    /** False: BB gives no Windows enrolment command (#539). */
    windowsEnrolment: true,
    /** A Windows machine connects once its enrolment command is asked for, as its installer would make it (#539). */
    windowsConnects: false,
    /** BB's machine calls never answer, as for a plugin that is stopping. */
    silent: false,
    /** How many more machine creates BB refuses, not knowing bb-box's provider, as while the plugin restarts. */
    unknownProvider: 0,
    /** BB's built-in Git: "logged in" when it gives machines GH_TOKEN. */
    git: "logged in" as "logged in" | "not logged in" | "disabled" | "overridden",
    /** The machine variables a user set in BB's settings. */
    machineVariables: ["MACHINE_VAR"],
    /** The variables a user set for the thread's project. */
    projectVariables: ["PROJECT_VAR"],
    /** Host calls, in order, to check a machine is removed before its box. */
    events: [] as string[],
    /** Makes threads.get fail with this error, such as a network error. */
    threadsError: null as Error | null,
    /** Makes threads.get fail for one thread. */
    threadErrors: new Map<string, Error>(),
    /** The agent CLIs BB finds on every machine, by provider; null: BB cannot say (#561). */
    agentClis: {
      "claude-code": { displayName: "Claude Code", executableName: "claude", installed: true },
      codex: { displayName: "Codex", executableName: "codex", installed: true },
      "acp-cursor": { displayName: "Cursor", executableName: "cursor-agent", installed: false },
    } as Record<string, { displayName: string; executableName: string; installed: boolean }> | null,
    /** The model of the calling thread's latest turn. */
    parentModel: "claude-opus-5-5" as string | null,
    /** The models each provider's CLI lists on a machine. */
    models: { "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-5.5"] } as Record<string, string[]>,
    /** Calls for the names of BB's machine variables: "system", or the project's ID. */
    names: [] as string[],
    /** Threads bb-box asked BB to start. */
    spawned: [] as unknown[],
    /** The machine the thread's workspace is on. */
    workspaceHost: "host-workspace",
    /**
     * Machines BB owns, as for "New box": deleting one runs BB's removal, which
     * calls the provider's remove and waits for it, with no time limit.
     */
    bbRemovals: new Map<string, () => Promise<unknown>>(),
    /** The resource BB keeps for each machine a provider made, by host ID. */
    resources: new Map<string, { boxId: string }>(),
    /** Changes bb-box made to threads. */
    updated: [] as unknown[],
    /** Threads that run on each BB machine, by host ID. */
    onHost: new Map<string, { id: string; title: string | null; status: string; hasPendingInteraction: boolean; archivedAt: number | null; deletedAt: number | null }[]>(),
    /** The project's sources, by machine, as BB keeps them. */
    sources: [] as { hostId: string; type: string }[],
    /** The thread's project's kind: BB's personal project has no repository. */
    projectKind: "standard" as "standard" | "personal",
    /** How long after bootstrap returns BB shows a machine it has connected again, or null for never, nor a new one. */
    connectAfterMs: 0 as number | null,
    current: null as { inspection: { registrations: { machineProviders: Map<string, unknown> } } } | null,
    /** What BB's bootstrap throws before it runs anything, as for bb connect without a sign-in, or null. */
    bootstrapError: null as string | null,
    /** How many threads run on each machine, by host ID. */
    hostThreads: new Map<string, number>(),
    /** BB's terminal sessions, by ID. */
    terminals: new Map<string, { id: string; hostId: string; title: string; command: string; status: "starting" | "running" | "exited"; createdAt: number; threadId?: string; environmentId?: string }>(),
    /** Calls of bb-box's host entry, by method, with the machine and input. */
    hostCalls: [] as { method: string; hostId: string; input: unknown }[],
    /** Answers a call of bb-box's host entry, as its worker on the machine would. */
    hostEntry: null as ((method: string, hostId: string, input: unknown) => unknown) | null,
  };
  const terminalStarted = new Map<string, () => boolean>();
  const terminal = (id: string) => {
    const session = world.terminals.get(id);
    if (!session) throw notFound("Terminal");
    if (session.status === "starting" && (terminalStarted.get(id)?.() ?? true)) session.status = "running";
    return { ...session };
  };
  const { bb, harness } = createFakePluginHost({
    experimental_callHostRpc: ({ method, hostId, input }) => {
      world.hostCalls.push({ method, hostId, input });
      return world.hostEntry ? world.hostEntry(method, hostId, input) : { started: false, pid: null };
    },
    pluginId: "bb-box",
    appUrl: options.appUrl ?? null,
    settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const error = world.threadsError ?? world.threadErrors.get(threadId);
          if (error) throw error;
          const thread = threads.get(threadId);
          if (!thread) throw threadNotFound();
          return thread;
        },
        count: async ({ hostId }: { hostId: string }) => ({ total: world.hostThreads.get(hostId) ?? 0 }),
        update: async (args: unknown) => {
          world.updated.push(args);
          return makeThreadResponse({ id: (args as { threadId: string }).threadId, projectId: PROJECT });
        },
        list: async ({ hostId }: { hostId?: string }) => (hostId ? (world.onHost.get(hostId) ?? []) : []) as never,
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: world.workspaceHost, storageRootPath: world.storages.get(threadId) ?? storage }),
        defaultExecutionOptions: async () =>
          world.parentModel ? { model: world.parentModel, permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/requested" } : null,
        spawn: async (args: unknown) => {
          world.spawned.push(args);
          return makeThreadResponse({ id: `thr_child${world.spawned.length}`, projectId: PROJECT });
        },
      },
      environments: {
        get: async () => ({ id: "env_one", hostId: world.workspaceHost, path: workspace }) as never,
      },
      terminals: {
        // As BB's: each scope lists only its own sessions, a machine's those of no thread or environment.
        list: async ({ scope }: { scope: { kind: string; hostId?: string; threadId?: string; environmentId?: string } }) => ({
          sessions: [...world.terminals.values()]
            .filter((session) =>
              scope.kind === "thread"
                ? session.threadId === scope.threadId
                : scope.kind === "environment"
                  ? session.environmentId === scope.environmentId
                  : session.hostId === scope.hostId && !session.threadId && !session.environmentId,
            )
            .map((session) => terminal(session.id)),
        }),
        create: async ({ scope, start, title }: { scope: { hostId: string }; start: { command: string }; title: string }) => {
          const id = `term_${world.terminals.size + 1}`;
          world.terminals.set(id, { id, hostId: scope.hostId, title, command: start.command, status: "starting", createdAt: Date.now() });
          return terminal(id);
        },
        get: async ({ terminalId }: { terminalId: string }) => terminal(terminalId),
        close: async ({ terminalId }: { terminalId: string }) => {
          const session = terminal(terminalId);
          world.terminals.get(terminalId)!.status = "exited";
          return session;
        },
      },
      system: {
        machineEnvironment: async () => {
          world.names.push("system");
          return { builtInGit: { status: world.git, statusMessage: "" }, variables: variables(world.machineVariables) };
        },
      },
      projects: {
        list: async () => [{ id: PROJECT, kind: world.projectKind, sources: world.projectKind === "personal" ? [] : world.sources }] as never,
        sources: {
          add: async ({ hostId, type }: { hostId: string; type: string }) => {
            world.sources.push({ hostId, type });
            return { id: `src_${world.sources.length}`, hostId, type: "local_path" } as never;
          },
        },
        machineEnvironment: async ({ projectId }: { projectId: string }) => {
          world.names.push(projectId);
          return {
            builtInGit: { status: world.git, statusMessage: "" },
            inheritedVariables: variables(world.machineVariables),
            variables: variables(projectId === PROJECT ? world.projectVariables : []),
          };
        },
      },
      providers: {
        models: async ({ providerId }: { providerId: string }) => ({ models: (world.models[providerId] ?? []).map((model) => ({ id: model, model })) }),
      },
      hosts: {
        providerCliStatus: async () => {
          if (!world.agentClis) throw new Error("Not found");
          return world.agentClis;
        },
        // A machine's enrolment and reconnect commands, with their Windows forms (#539).
        experimental_getEnrollmentCommand: async ({ hostId }: { hostId: string }) => {
          world.events.push(`enrolment command ${hostId}`);
          // As BB's installer would once it runs: the machine connects a moment later, named after the computer.
          const host = hosts.get(hostId);
          if (host && world.windowsConnects) setTimeout(() => hosts.set(hostId, { ...hosts.get(hostId)!, name: "bb-box-win", status: "connected", lifecycle: { ...host.lifecycle, phase: "active" } }), 50);
          return world.windowsEnrolment ? { command: `sh enrol ${hostId}`, windowsCommand: `& enrol ${hostId}`, expiresAt: Date.now() + 60_000 } : null;
        },
        experimental_reconnect: async ({ hostId }: { hostId: string }) => {
          const host = hosts.get(hostId);
          if (host?.status === "connected") throw Object.assign(new Error("HTTP 409: Machine is connected and doesn't need reconnecting"), { status: 409 });
          world.events.push(`reconnect command ${hostId}`);
          if (host) setTimeout(() => hosts.set(hostId, { ...hosts.get(hostId)!, status: "connected" }), 50);
          return { command: `sh start ${hostId}`, windowsCommand: `& start ${hostId}`, hostId, expiresAt: Date.now() + 60_000 };
        },
        // Like BB: records the machine, then calls the provider's create in
        // the background. A key whose machine BB still has gets it back.
        experimental_create: async ({ key, inputs, machineProviderId }: { key: string; inputs: { boxId: string }; machineProviderId: string }) => {
          const id = `host-${key}`;
          world.events.push(machineProviderId === "manual" ? `create manual ${id}` : `create ${id}`);
          // BB's manual provider: the machine waits for its enrolment command to run (#539).
          if (machineProviderId === "manual") {
            const host = makeHostResponse({ id, status: "disconnected", machineProviderId: "manual" });
            hosts.set(id, { ...host, lifecycle: { ...host.lifecycle, phase: "creating" } });
            return hosts.get(id)!;
          }
          if (world.unknownProvider > 0) {
            world.unknownProvider--;
            throw Object.assign(new Error('HTTP 400: Unknown machine provider "bb-box"'), { status: 400 });
          }
          const existing = hosts.get(id);
          if (existing && existing.lifecycle.phase !== "destroyed") return existing;
          const host = makeHostResponse({ id, status: "disconnected", machineProviderId: "bb-box" });
          hosts.set(id, { ...host, lifecycle: { ...host.lifecycle, phase: "creating" } });
          void (async () => {
            const provider = ((world.current ?? harness) as typeof harness).inspection.registrations.machineProviders.get("bb-box")!;
            const result = await provider.create({
              inputs,
              key,
              attempt: 1,
              checkpoint: async () => {},
              report: { step: () => {}, log: () => {} },
              signal: new AbortController().signal,
            } as never);
            const current = hosts.get(id);
            if (!current) return;
            hosts.set(
              id,
              result.status === "created"
                ? { ...current, name: result.name, status: world.connectAfterMs === null ? "disconnected" : "connected", lifecycle: { ...current.lifecycle, phase: "active" } }
                : { ...current, lifecycle: { ...current.lifecycle, phase: "destroyed", message: result.message } },
            );
          })();
          return hosts.get(id)!;
        },
        list: async () => [...hosts.values()],
        get: async ({ hostId }: { hostId: string }) => {
          // As BB may be for a plugin that is stopping: no answer at all.
          if (world.silent) await new Promise(() => {});
          const host = hosts.get(hostId);
          if (!host) throw notFound("Host");
          return host;
        },
        update: async ({ hostId, name }: { hostId: string; name: string }) => {
          const host = hosts.get(hostId);
          if (!host) throw notFound("Host");
          hosts.set(hostId, { ...host, name });
          return hosts.get(hostId)!;
        },
        delete: async ({ hostId }: { hostId: string }) => {
          world.events.push(`delete ${hostId}`);
          const removal = world.bbRemovals.get(hostId);
          if (removal) {
            await removal();
            return {} as never;
          }
          if (!hosts.delete(hostId)) throw notFound("Host");
          return {} as never;
        },
      },
      files: {
        read: async ({ path, rootPath }: { path: string; rootPath?: string }) => {
          withinRoot(path, rootPath);
          // As BB's file API: a file over 25 MB is refused whole (#485).
          const size = statSync(absolute(path)).size;
          if (size > 25 * 1000 * 1000) throw Object.assign(new Error(`HTTP 413: File size ${size} bytes exceeds the 25 MB limit`), { status: 413 });
          const data = readFileSync(absolute(path));
          return { path, content: data.toString("base64"), contentEncoding: "base64", sha256: "", sizeBytes: data.byteLength } as never;
        },
        write: async ({ path, content }: { path: string; content: string }) => {
          const target = absolute(path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(content, "base64"));
          return { path } as never;
        },
      },
    } as never,
    machineResource: async (hostId) => world.resources.get(hostId) ?? null,
    // BB's installer, in brief: it runs a command in the box through the
    // executor, and a machine BB already has connects again.
    machineBootstrap: {
      async bootstrap({ key, executor, signal }) {
        world.bootstraps.push(key);
        if (world.bootstrapError) throw new Error(world.bootstrapError);
        let output = "";
        const { exitCode } = await executor.exec({ command: ["sh", "-c", world.installer], timeoutMs: 10_000, signal, stdin: "", onOutput: (text) => (output += text) });
        // As BB reports it, with the installer's output.
        if (exitCode !== 0) throw new Error(`Machine bootstrap command failed:\n\n${output}The installer exited with ${exitCode}.`);
        const connect = () => {
          const host = hosts.get(`host-${key}`);
          if (host?.lifecycle.phase === "active") hosts.set(host.id, { ...host, status: "connected" });
        };
        if (world.connectAfterMs === 0) connect();
        else if (world.connectAfterMs !== null) setTimeout(connect, world.connectAfterMs);
        return { hostId: `host-${key}` };
      },
    },
  });
  const setupOptions: SetupOptions = {
    drivers: [fakeDriver(root, world, { resize: options.resize, minSize: options.minSize, kinds: options.kinds, shell: options.shell, keepsSession: options.keepsSession, pointer: options.pointer }), ...(options.drivers ?? [])],
    daemonParent: options.daemonParent ?? join(root, "no-daemon"),
    computer: options.computer,
    variablesWaitMs: options.variablesWaitMs,
    logonWaitMs: options.logonWaitMs,
    providerRetryMs: options.providerRetryMs,
    manualRemoveMs: options.manualRemoveMs,
    controlReconnectMs: options.controlReconnectMs,
    controlStaleMs: options.controlStaleMs,
    drainMs: options.drainMs,
    runWaitMs: options.runWaitMs,
  };
  await bb.storage.kv.set(INSTALL_ID_KEY, newInstallId());
  const app = await setup(bb, setupOptions);
  const tool = (name: string, input: unknown, threadId = THREAD) => harness.behavior.callAgentTool(name, input, { threadId, projectId: PROJECT });
  return { bb, harness, app, world, tool, setupOptions };
}

function text(result: PluginAgentToolResult): string {
  return typeof result === "string" ? result : result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

test("box_image_set and bb box image set, list, show and remove keep a project's image in the configuration (049)", async (t) => {
  const { app, harness, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  const set = await tool("box_image_set", { name: "rust-tools", kinds: ["linux"], script: "#!/bin/bash\necho rust\n", check: "cargo --version\n", script_path: ".bb/box-setup.sh", check_path: ".bb/box-check.sh" });
  assert.match(text(set), /^Set image rust-tools for linux boxes in this thread's project\./);
  const image = app.configuration.exported().images?.["rust-tools"];
  assert.deepEqual([image?.projects, image?.kinds, image?.check, image?.source], [[PROJECT], ["linux"], "cargo --version\n", { script: ".bb/box-setup.sh", check: ".bb/box-check.sh" }]);
  assert.match((await harness.behavior.runCli(["image", "list"])).stdout ?? "", /^rust-tools: linux boxes in prj_one; baked auto; script \.bb\/box-setup\.sh, check \.bb\/box-check\.sh; set \d{4}-\d{2}-\d{2}\.\n$/);
  assert.equal((await harness.behavior.runCli(["image", "show", "rust-tools"])).stdout, "#!/bin/bash\necho rust\n\n# The check, run as the box user:\ncargo --version\n");

  // box_list names a kind's images, and box_acquire chooses one or refuses one there is not.
  assert.match(text(await tool("box_list", {})), /- linux: [^\n]* Images: rust-tools \(this project's, the default\); standard\./);
  const missing = await tool("box_acquire", { kind: "linux", image: "nope" });
  assert.ok(isError(missing));
  assert.match(text(missing), /There is no image nope for linux boxes/);

  // A draft from the project's files.
  const draft = text(await tool("box_image_draft", { files: [{ path: ".nvmrc", text: "20\n" }, { path: "Dockerfile", text: "FROM ubuntu:24.04\nCOPY . /app\n" }] }));
  assert.match(draft, /^Drafted from Dockerfile, \.nvmrc\.\n\nLeft to you, also commented at the top of the script:\n- Dockerfile: COPY \. \/app is commented out/);
  assert.match(draft, /`\.bb\/box-setup\.sh`:\n```bash\n#!\/bin\/bash\n[\s\S]*'node@20'  # \.nvmrc\n[\s\S]*```\n\n`\.bb\/box-check\.sh`:\n```bash\n[\s\S]*node --version\n```/);

  // A try needs a backend that builds images, which the fake host is not; the CLI tries an image already set, on a kind it covers.
  const tried = await tool("box_image_try", { kind: "linux", script: "#!/bin/bash\necho rust\n" });
  assert.ok(isError(tried));
  assert.match(text(tried), /No backend that is on builds linux images\. Proxmox LXC, Docker and Tart do; elsewhere boxes run the script as they start\./);
  const otherKind = await harness.behavior.runCli(["image", "try", "rust-tools", "--kind", "linux-desktop-cpu"]);
  assert.deepEqual([otherKind.exitCode, /Image rust-tools covers linux, not linux-desktop-cpu\./.test(otherKind.stderr ?? "")], [1, true], otherKind.stderr);
  assert.match((await harness.behavior.runCli(["image", "try", "rust-tools"])).stderr ?? "", /No backend that is on builds linux images/);

  // From files, by the CLI: another image for the project's linux boxes is refused, and "standard" is no name.
  const file = join(world.root, "setup.sh");
  writeFileSync(file, "#!/bin/bash\necho other\n");
  const twin = await harness.behavior.runCli(["image", "set", "other", "--kinds", "linux", "--script-file", file, "--project", PROJECT]);
  assert.equal(twin.exitCode, 1);
  assert.match(twin.stderr ?? "", /Project prj_one's linux boxes would get both rust-tools and other/);
  assert.equal((await harness.behavior.runCli(["image", "set", "standard", "--kinds", "linux", "--script-file", file, "--project", "prj_two"])).exitCode, 1);
  const other = await harness.behavior.runCli(["image", "set", "other", "--kinds", "linux", "--script-file", file, "--project", "prj_two", "--bake", "never"]);
  assert.match(other.stdout ?? "", /^Saved image other for linux boxes in project prj_two, at revision \d+\.\n$/, other.stderr);
  assert.deepEqual(app.configuration.exported().images?.other?.source, { script: file });

  // Another project's image is not this thread's to change.
  assert.match(text(await tool("box_image_set", { name: "other", kinds: ["linux"], script: "echo" })), /Image other belongs to prj_two, not this thread's project\. Pick another name\./);

  assert.match((await harness.behavior.runCli(["image", "remove", "rust-tools"])).stdout ?? "", /^Removed image rust-tools, at revision \d+\.\n$/);
  assert.equal(app.configuration.exported().images?.["rust-tools"], undefined);
  assert.equal((await harness.behavior.runCli(["image", "remove", "rust-tools"])).exitCode, 1);
});

function isError(result: PluginAgentToolResult): boolean {
  return typeof result !== "string" && result.isError === true;
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function only(app: Awaited<ReturnType<typeof start>>["app"]): Promise<BoxRecord> {
  const [box, ...rest] = await app.boxes.list(THREAD);
  assert.ok(box && !rest.length, "the thread has one box");
  return box;
}

test("box_grant grants a program in a Mac's box its permissions, says how to run it, and box_status lists the grants (058)", async (t) => {
  const { harness, app, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  assert.ok(!isError(await tool("box_acquire", {})));
  const box = await only(app);
  const refused = await tool("box_grant", { box: box.name, program: "/home/box/tool", permissions: ["accessibility"] });
  assert.ok(isError(refused));
  assert.match(text(refused), /cannot grant macOS permissions: only Tart's macOS boxes and Macs of the SSH host pool with SIP off can\./);
  assert.doesNotMatch(text(await tool("box_status", { box: box.name })), /macOS permissions/);
  // A backend's refusal names the box, not its guest.
  Object.assign(app.backends.get(box.backend)!, {
    grant: async (guest: { ref: string }) => {
      throw new BackendError("unsupported", `Only a macOS box has macOS permissions to grant: ${guest.ref} runs Linux.`);
    },
  });
  const named = await tool("box_grant", { box: box.name, program: "/home/box/tool", permissions: ["accessibility"] });
  assert.equal(text(named).split("\n")[0], `Only a macOS box has macOS permissions to grant: ${box.name} runs Linux.`);

  // A backend that grants, as the SSH host pool does for a Mac.
  const grants: { permission: string; client: string; target: string | null }[] = [];
  let signingIdentity = true;
  Object.assign(app.backends.get(box.backend)!, {
    grant: async (_guest: unknown, request: { program: string; permissions: string[] }) => {
      const client = request.program.endsWith(".app") ? "dev.example.probe" : request.program;
      for (const permission of request.permissions) grants.push({ permission, client, target: null });
      return { client, granted: request.permissions, refused: [] };
    },
    grants: async () => ({ canGrant: true, signingIdentity, grants }),
  });
  assert.match(text(await tool("box_status", { box: box.name })), /\nmacOS permissions granted with box_grant: none\./);
  const granted = await tool("box_grant", { box: box.name, program: "/Users/bbx-0/Applications/Probe.app", permissions: ["accessibility", "screen-recording"] });
  assert.ok(!isError(granted), text(granted));
  assert.match(text(granted), new RegExp(`^Granted accessibility, screen-recording to dev\\.example\\.probe in box ${box.name}\\.`));
  assert.match(text(granted), /Open the app with open, so that it is its own responsible process/);
  const cli = await tool("box_grant", { box: box.name, program: "/Users/bbx-0/bin/tool", permissions: ["microphone"] });
  assert.match(text(cli), /Start it through launchd from a box_run command with desktop true, as launchctl submit -l <label> -o <log> -- \/Users\/bbx-0\/bin\/tool <arguments>/);
  assert.match(ownProcessHint("ssh-pool:macs", "/Users/bbx-0/bin/tool"), /^Run it through bb-box-own, as bb-box-own \/Users\/bbx-0\/bin\/tool <arguments>/, "the SSH host pool's Macs have bb-box-own");
  assert.match(text(await tool("box_status", { box: box.name })), /\nmacOS permissions granted with box_grant: accessibility to dev\.example\.probe, screen-recording to dev\.example\.probe, microphone to \/Users\/bbx-0\/bin\/tool\./);
  await assert.rejects(tool("box_grant", { box: box.name, program: "/Users/bbx-0/bin/tool", permissions: ["telepathy"] }), /expected one of "accessibility"/);
  assert.doesNotMatch(text(await tool("box_status", { box: box.name })), /Signing identity/);
  signingIdentity = false;
  assert.match(text(await tool("box_status", { box: box.name })), /\nSigning identity: missing, so codesign -s "bb-box local code signing" fails in this box\. Tell the Mac's operator: its helper could not make it\.\n/);
});

test("an agent acquires a box, runs commands, copies files both ways and releases it", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  const acquired = await tool("box_acquire", {});
  assert.ok(!isError(acquired), text(acquired));
  const box = await only(app);
  assert.equal(box.state, "ready");
  assert.equal(box.kind, "linux");
  assert.equal(box.projectId, PROJECT);
  assert.match(text(acquired), new RegExp(`Box ${box.name} \\(${box.id}\\)`));
  assert.match(text(acquired), /Next: Run commands with box_run/);

  const ran = await tool("box_run", { box: box.name, command: "echo out; echo err >&2; exit 3" });
  assert.match(text(ran), /Exit code 3/);
  assert.match(text(ran), /stdout:\nout/);
  assert.match(text(ran), /stderr:\nerr/);
  assert.equal(isError(ran), false, "a command that fails is not a tool error");

  // A server started as the hints say, by a shell that waits for it with the
  // session's output open, as bash does for `cd web && nohup server >log 2>&1 &`:
  // box_run returns at once, and the server keeps running.
  const started = Date.now();
  const server = await tool("box_run", {
    box: box.name,
    command: "mkdir -p web && cd web && { nohup sh -c 'echo $$ > server.pid; exec sleep 30' >server.log 2>&1; echo stopped >>server.log; } & echo started",
  });
  assert.match(text(server), /Exit code 0/);
  assert.match(text(server), /stdout:\nstarted/);
  assert.ok(Date.now() - started < 3_000, "box_run returned at once");
  const pid = 'kill -0 "$(cat web/server.pid)" && echo running';
  await until("the server to run after box_run returned", async () => /stdout:\nrunning/.test(text(await tool("box_run", { box: box.name, command: pid }))));
  const stopped = await tool("box_run", { box: box.name, command: 'kill "$(cat web/server.pid)" && echo stopped' });
  assert.match(text(stopped), /stdout:\nstopped/);

  writeFileSync(join(world.workspace, "input.txt"), "from the workspace\n");
  const copiedIn = await tool("box_copy", { box: box.name, direction: "to_box", from: "input.txt" });
  assert.ok(!isError(copiedIn), text(copiedIn));
  assert.match(text(copiedIn), new RegExp(`Copied ${join(world.workspace, "input.txt")} \\(19 bytes, SHA-256 ${createHash("sha256").update("from the workspace\n").digest("hex")}\\) to input.txt in box`));
  const cat = await tool("box_run", { box: box.name, command: "tr a-z A-Z < input.txt > output.txt && cat output.txt" });
  assert.match(text(cat), /FROM THE WORKSPACE/);
  assert.match(text(await tool("box_copy", { box: box.id, direction: "from_box", from: "output.txt", to: "out/result.txt" })), /to .*\/workspace\/out\/result.txt in the workspace/);
  assert.equal(readFileSync(join(world.workspace, "out/result.txt"), "utf8"), "FROM THE WORKSPACE\n");

  const listed = await tool("box_list", {});
  assert.match(text(listed), new RegExp(`- ${box.name}: Linux \\(linux, 2 cores, 4 GiB memory\\), ready`));
  assert.match(text(listed), /Kinds:\n- linux/);
  assert.match(text(listed), /- linux: .* Root: no, the box user cannot use sudo\. Docker: no\./);
  assert.match(text(await tool("box_status", { box: box.name })), /\nRoot: no, the box user cannot use sudo\. box_list shows the kinds that give root\nDocker: no\. box_list says which kinds have it\n/);

  const released = await tool("box_release", { box: box.name });
  assert.match(text(released), new RegExp(`Released box ${box.name}`));
  assert.deepEqual(await app.boxes.list(THREAD), []);
  assert.match(text(await tool("box_list", {})), /This thread has no boxes/);
});

test("a run that times out says how to start a long job in the box's own shell", async (t) => {
  for (const [kind, options, background] of [
    ["linux", {}, "nohup <cmd> >job.log 2>&1 &"],
    ["windows", { kinds: [FAKE_WINDOWS_KIND], shell: FAKE_PWSH }, "Start-Detached { <cmd> } job.log"],
  ] as const) {
    const { harness, tool } = await start({ "fake-enabled": true }, options);
    t.after(() => harness.lifecycle.dispose());
    const name = /Box (\S+) \(/.exec(text(await tool("box_acquire", { kind })))![1]!;
    const ran = await tool("box_run", { box: name, command: "sleep 5", timeout_seconds: 1 });
    assert.equal(isError(ran), true);
    assert.ok(text(ran).endsWith(`Next: Give timeout_seconds more time, or start a long job in the background with ${background} and check on it.`), text(ran));
  }
});

test("a deploy lets box_run's commands finish and takes no new ones, and a command still running goes on as a job (#405)", async (t) => {
  const { harness, app, tool } = await start({ "fake-enabled": true, "enrol-boxes": false }, { drainMs: 1_500 });
  let disposing: Promise<void> | null = null;
  t.after(() => disposing ?? harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;

  // As BB updates a plugin: it aborts the tool calls, then runs the dispose hooks.
  const deploy = new AbortController();
  const call = (command: string) => harness.behavior.callAgentTool("box_run", { box: box.name, command }, { threadId: THREAD, projectId: PROJECT, signal: deploy.signal });
  const short = call("sleep 0.5; echo short");
  const long = call("echo long; sleep 3; exit 4");
  await new Promise((resolve) => setTimeout(resolve, 200));
  deploy.abort("plugin-disposed");
  disposing = harness.lifecycle.dispose();

  const refused = await tool("box_run", { box: box.name, command: "echo new" });
  assert.equal(isError(refused), true);
  assert.equal(text(refused), "bb-box is restarting, as for an update, and takes no new commands until it is back, usually within seconds.\n\nNext: Run the command again in a few seconds, once bb-box is back.");
  const finished = await short;
  assert.equal(isError(finished), false, text(finished));
  assert.match(text(finished), /^Exit code 0 in box .*\n\nstdout:\nshort\n/);

  const stopped = await long;
  assert.equal(isError(stopped), true);
  const job = /It goes on there as job ([0-9a-f]{12})\./.exec(text(stopped))?.[1];
  assert.ok(job, text(stopped));
  assert.ok(text(stopped).endsWith(`Next: Call box_job with box "${box.name}" and job "${job}" for its exit code and output once it ends. bb-box is usually back within seconds; until then the box may not answer.`), text(stopped));
  await disposing;
  assert.equal(readFileSync(join(home, ".local/state/bb-box/jobs", job, "out"), "utf8"), "long\n", "the command's output is in the box");
});

test("box_run returns before BB ends a tool call: a Linux command goes on as a job with its output so far, and a Windows one as a job too (#486, #414)", async (t) => {
  const linux = await start({ "fake-enabled": true, "enrol-boxes": false }, { runWaitMs: 1_000 });
  t.after(() => linux.harness.lifecycle.dispose());
  await linux.tool("box_acquire", {});
  const box = await only(linux.app);
  const long = await linux.tool("box_run", { box: box.name, command: "echo started; sleep 2; echo finished", timeout_seconds: 600 });
  assert.equal(isError(long), false, text(long));
  const job = /as job ([0-9a-f]{12})/.exec(text(long))?.[1];
  assert.ok(job, text(long));
  assert.match(text(long), /^The command still runs in box \S+ after 1 s, and goes on there as job [0-9a-f]{12}: BB ends a tool call at about five minutes, so box_run returns before then\. The end of its output so far:\n\nstdout:\nstarted\n/);
  await until("the job to end", async () => /ended with exit code 0/.test(text(await linux.tool("box_job", { box: box.name, job: job! }))));
  // A short command is answered as before.
  assert.match(text(await linux.tool("box_run", { box: box.name, command: "echo quick" })), /^Exit code 0/);

  const windows = await start({ "fake-enabled": true, "enrol-boxes": false }, { kinds: [FAKE_WINDOWS_KIND], shell: FAKE_PWSH, runWaitMs: 1_000 });
  t.after(() => windows.harness.lifecycle.dispose());
  const name = /Box (\S+) \(/.exec(text(await windows.tool("box_acquire", { kind: "windows" })))![1]!;
  // The fake's PowerShell cannot run a job, but its runner's command waits as a Windows box's does.
  const detached = await windows.tool("box_run", { box: name, command: "Start-Sleep 5", timeout_seconds: 600 });
  assert.equal(isError(detached), false, text(detached));
  assert.match(text(detached), /^The command still runs in box \S+ after 1 s, and goes on there as job [0-9a-f]{12}: BB ends a tool call at about five minutes/);
});

test("a command whose box stops answering as bb-box stops for a deploy, as a Docker box on a BB machine does when BB stops the relay first, names its job (#415)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false }, { drainMs: 1_500 });
  let disposing: Promise<void> | null = null;
  t.after(() => disposing ?? harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);
  const deploy = new AbortController();
  const long = harness.behavior.callAgentTool("box_run", { box: box.name, command: "echo long; sleep 5" }, { threadId: THREAD, projectId: PROJECT, signal: deploy.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // BB stops bb-box's worker on the machine, and the relay with it, then aborts the calls and runs the dispose hooks.
  world.backend!.loseCommands(box.guest!.ref);
  await new Promise((resolve) => setTimeout(resolve, 500));
  deploy.abort("plugin-disposed");
  disposing = harness.lifecycle.dispose();
  const answer = await long;
  assert.equal(isError(answer), true);
  const job = /It may go on there as job ([0-9a-f]{12})\./.exec(text(answer))?.[1];
  assert.ok(job, text(answer));
  assert.ok(text(answer).endsWith(`Next: Call box_job with box "${box.name}" and job "${job}" for its exit code and output once it ends. bb-box is usually back within seconds; until then the box may not answer.`), text(answer));
});

test("box_job gives a job's output while it runs and its exit code once it ends, and the box's next command removes it (#405)", async (t) => {
  const { harness, app, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const job = "0123456789ab";
  const dir = join(home, ".local/state/bb-box/jobs", job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out"), "building\n");
  writeFileSync(join(dir, "err"), "");

  const running = await tool("box_job", { box: box.name, job });
  assert.equal(isError(running), false, text(running));
  assert.equal(text(running), `Job ${job} is still running in box ${box.name}. The end of its output so far:\n\nstdout:\nbuilding\n\n\nNext: Call box_job again later.`);

  writeFileSync(join(dir, "out"), "building\nbuilt\n");
  writeFileSync(join(dir, "err"), "a warning\n");
  writeFileSync(join(dir, "status"), "0\n");
  const ended = await tool("box_job", { box: box.name, job });
  assert.equal(text(ended), `Job ${job} ended with exit code 0 in box ${box.name}.\n\nstdout:\nbuilding\nbuilt\n\n\nstderr:\na warning\n\n\nNext: Run more with box_run.`);
  assert.ok(existsSync(dir), "kept until bb-box's next command");
  assert.match(text(await tool("box_run", { box: box.name, command: "true" })), /Exit code 0/);
  assert.equal(existsSync(dir), false);

  const gone = await tool("box_job", { box: box.name, job });
  assert.equal(isError(gone), true);
  assert.match(text(gone), new RegExp(`^Box ${box.name} has no job ${job}: its result was read already, or it ended more than 7 days ago\\.`));
  await assert.rejects(tool("box_job", { box: box.name, job: "../../x" }));
});

test("files for every box go into a Linux box's home as it joins BB, mode 600, into running boxes when they change, and into a stopped one as it starts, never into a log (#455)", async (t) => {
  const { harness, app, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const SECRET = '{"providers":{"example":{"apiKey":"sk-secret-value"}}}';
  const before = app.configuration.exported();
  const set = await app.configuration.apply({ ...before, general: { ...before.general, files: [{ path: ".pi/agent/models.json", content: SECRET }] } }, before.revision);
  assert.ok(set.ok, JSON.stringify(set.ok ? null : set));
  assert.ok(!JSON.stringify(set).includes("sk-secret-value"), "the answer to the write says only that it is set");

  await tool("box_acquire", {});
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const file = join(home, ".pi", "agent", "models.json");
  await until("the file in the box", async () => existsSync(file) && readFileSync(file, "utf8") === SECRET);
  assert.equal(statSync(file).mode & 0o777, 0o600, "the box user's alone");

  // A change of the content reaches the running box.
  const now = app.configuration.exported();
  await app.configuration.apply({ ...now, general: { ...now.general, files: [{ path: ".pi/agent/models.json", content: "{}" }] } }, now.revision);
  await until("the new content", async () => readFileSync(file, "utf8") === "{}");

  // A box stopped through a change gets it as it starts again.
  await tool("box_stop", { box: box.name });
  const then = app.configuration.exported();
  await app.configuration.apply({ ...then, general: { ...then.general, files: [{ path: ".pi/agent/models.json", content: "[]" }] } }, then.revision);
  assert.equal(readFileSync(file, "utf8"), "{}", "nothing goes into a stopped box");
  const started = await tool("box_start", { box: box.name });
  assert.ok(!isError(started), text(started));
  await until("the content as it starts", async () => readFileSync(file, "utf8") === "[]");

  const doctor = await app.doctor();
  const section = doctor.sections.find((candidate) => candidate.title === "Files for every box");
  assert.match(section?.report.checks[0]?.detail ?? "", new RegExp(`^1 file set; the last write, into box ${box.name} at .+ UTC, worked\\.$`));
  const logs = harness.inspection.logEntries.map((entry) => entry.message).join("\n");
  assert.ok(!logs.includes("sk-secret-value") && !JSON.stringify(doctor).includes("sk-secret-value"), "no log or doctor line holds the content");
});

test("box_copy takes relative paths under the workspace and the box user's home, and names files after their source", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);

  mkdirSync(join(world.workspace, "src"));
  writeFileSync(join(world.workspace, "src", "notes.txt"), "notes\n");
  assert.match(text(await tool("box_copy", { box: box.name, direction: "to_box", from: "src/notes.txt" })), /to notes.txt in box/);
  assert.match(text(await tool("box_copy", { box: box.name, direction: "to_box", from: join(world.workspace, "src/notes.txt"), to: "~/deep/copy.txt" })), /to deep\/copy.txt in box/);
  assert.match(text(await tool("box_run", { box: box.name, command: "cat notes.txt deep/copy.txt > both.txt" })), /Exit code 0/);

  const out = await tool("box_copy", { box: box.name, direction: "from_box", from: "~/both.txt" });
  assert.ok(!isError(out), text(out));
  assert.equal(readFileSync(join(world.workspace, "both.txt"), "utf8"), "notes\nnotes\n");
  await tool("box_copy", { box: box.name, direction: "from_box", from: "both.txt", to: join(world.root, "outside.txt") });
  assert.equal(readFileSync(join(world.root, "outside.txt"), "utf8"), "notes\nnotes\n");
});

test("box_record records a Linux desktop, and stop puts the clip and a page that plays it beside it in the thread's storage, with the line to show it (059)", { skip: process.platform !== "linux" && "needs GNU stat" }, async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  const saved = process.env.PATH;
  process.env.PATH = `${fakeFfmpeg()}:${saved}`;
  t.after(() => (process.env.PATH = saved));

  await tool("box_acquire", { kind: "linux" });
  const server = await only(app);
  const refused = await tool("box_record", { box: server.name, action: "start" });
  assert.ok(isError(refused));
  assert.match(text(refused), /has no desktop to record\./);
  await tool("box_release", { box: server.name });

  await tool("box_acquire", { kind: "linux-desktop" });
  const desktop = (await app.boxes.list(THREAD)).find((box) => box.kind === "linux-desktop")!;
  // The fake's desktop has no display.env, so it is not running.
  assert.match(text(await tool("box_record", { box: desktop.name, action: "start" })), /desktop is not running/);
  const none = await tool("box_record", { box: desktop.name, action: "stop" });
  assert.ok(isError(none));
  assert.match(text(none), /has no recording\./);

  // A recording that ended at its limit, as the box leaves it.
  await tool("box_run", { box: desktop.name, command: "mkdir -p .local/state/bb-box/recording && echo capture > .local/state/bb-box/recording/capture.mkv" });
  const stopped = await tool("box_record", { box: desktop.name, action: "stop", speed: 2 });
  assert.ok(!isError(stopped), text(stopped));
  const said = text(stopped);
  const name = /\$BB_THREAD_STORAGE\/(recordings\/[^ ]+)\.mp4/.exec(said)?.[1];
  assert.ok(name, said);
  assert.match(said, /^Recorded box \S+: a 4\.2 s clip of 10\.0 s recorded, 6\.0 s of still stretches cut, played 2x, 1280x720, 1 KB\. It reached the 5-minute limit/);
  assert.ok(said.includes(`::inline-vis{source="thread-storage" file="${name}.html" height="368"}`), said);
  assert.equal(readFileSync(join(world.storage, `${name}.mp4`), "utf8"), "mp4data");
  assert.ok(readFileSync(join(world.storage, `${name}.html`), "utf8").includes(`<video id="clip" src="${name.split("/").pop()}.mp4"`));
  assert.match(said, /It shows the clip in this thread only:/);

  // A child thread's recording: its parent, and the parent's parent, get a copy, as a parent passes on its child's
  // report with the line, which shows a file of the storage folder of the thread it is in.
  const parents = [join(world.root, "thread-storage", "thr_parent"), join(world.root, "thread-storage", "thr_grand")];
  world.storages.set("thr_parent", parents[0]!);
  world.storages.set("thr_grand", parents[1]!);
  world.threads.set(THREAD, { ...world.threads.get(THREAD)!, parentThreadId: "thr_parent" });
  world.threads.set("thr_parent", makeThreadResponse({ id: "thr_parent", projectId: PROJECT, parentThreadId: "thr_grand" }));
  world.threads.set("thr_grand", makeThreadResponse({ id: "thr_grand", projectId: PROJECT }));
  await tool("box_run", { box: desktop.name, command: "mkdir -p .local/state/bb-box/recording && echo capture > .local/state/bb-box/recording/capture.mkv" });
  const child = text(await tool("box_record", { box: desktop.name, action: "stop" }));
  const clip = /\$BB_THREAD_STORAGE\/(recordings\/[^ ,]+)\.mp4/.exec(child)?.[1];
  assert.ok(clip, child);
  assert.match(child, /and in the storage folder of its parent threads, 2 of them\./);
  assert.match(child, /It shows the clip in this thread and in its parent threads, which have a copy, so a parent can pass the line on:/);
  for (const folder of [world.storage, ...parents]) {
    assert.equal(readFileSync(join(folder, `${clip}.mp4`), "utf8"), "mp4data", folder);
    assert.ok(readFileSync(join(folder, `${clip}.html`), "utf8").includes(`<video id="clip" src="${clip!.split("/").pop()}.mp4"`), folder);
  }

  assert.match(text(await tool("box_record", { box: desktop.name, action: "step", text: "Too early" })), /is not recording\./);
  assert.match(text(await tool("box_record", { box: desktop.name, action: "step" })), /Give text with step/);
  assert.match(text(await tool("box_record", { box: desktop.name, action: "result", text: "Saw it" })), /Give passed with result/);
  await tool("box_run", { box: desktop.name, command: "d=.local/state/bb-box/recording; mkdir -p $d && echo capture > $d/capture.mkv && date +%s.000 > $d/start && { setsid sleep 30 >/dev/null 2>&1 & echo $! > $d/pid; }" });
  assert.match(text(await tool("box_record", { box: desktop.name, action: "step", text: "It keeps the draft when saving fails" })), /^Captioned the next step: ▶ It keeps the draft when saving fails/);
  assert.match(text(await tool("box_record", { box: desktop.name, action: "result", passed: false, text: "The editor closed and lost it" })), /^Captioned the result: ✗ The editor closed and lost it/);
  const captioned = text(await tool("box_record", { box: desktop.name, action: "stop" }));
  assert.match(captioned, /, 1 step captioned, 1 failed\./, captioned);
  const page = /\$BB_THREAD_STORAGE\/(recordings\/[^ ,]+)\.mp4/.exec(captioned)?.[1];
  const html = readFileSync(join(world.storage, `${page}.html`), "utf8");
  assert.match(html, /▶<\/span> It keeps the draft when saving fails<br><span style="color:#ff453a">✗<\/span> The editor closed and lost it/);
  assert.ok(captioned.includes(`file="${page}.html" height="430"`), captioned);
});

test("box_record on an ios box records its device, not the host's desktop: framed, turned and captioned, with no viewer open (063, 7.4)", { skip: (spawnSync("ffmpeg", ["-version"]).status !== 0 || process.platform !== "linux") && "needs ffmpeg with drawtext" }, async (t) => {
  const offer = testDeviceOffer("ios");
  const kind: BoxKind = { ...FAKE_KINDS[0]!, id: "ios", label: "iOS Simulator", capabilities: { ...FAKE_KINDS[0]!.capabilities, displays: [DEVICE_DISPLAY], device: { ...offer, devices: offer.devices.map((device) => ({ ...device, native: "phone" })) } as never } };
  const { harness, app, world, tool } = await start(undefined, { kinds: [kind] });
  t.after(() => harness.lifecycle.dispose());
  assert.ok(!isError(await tool("box_acquire", { kind: "ios" })));
  const phone = await only(app);
  const home = /stdout:\n(\S+)/.exec(text(await tool("box_run", { box: phone.name, command: "pwd" })))![1]!;
  const paths = devicePaths(home);
  const server = new DeviceServer({ paths, platform: "ios", devices: offer.devices as OfferedDevices, driver: new TestDriver("ios"), version: DEVICE_SERVER_VERSION });
  await server.start();
  t.after(() => server.stop());
  for (let tries = 0; server.state.power.is !== "booted" && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  const socket = connect(paths.socket);
  await new Promise((resolve) => socket.once("connect", resolve));
  const web = Duplex.toWeb(socket);
  const control = await DeviceLink.open({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() }, { role: "control", started: 1, instance: "test" });
  t.after(() => control.close());
  Object.assign(app.devices, { recorded: () => undefined, record: (_box: unknown, request: never) => control.request(request) });

  assert.match(text(await tool("box_record", { box: phone.name, action: "stop" })), /has no recording\./);
  const started = text(await tool("box_record", { box: phone.name, action: "start" }));
  assert.match(started, /^Recording box \S+'s device, the iPhone 18 Pro, for at most 5 minutes\. Only the device's own screen is recorded/);
  assert.ok(isError(await tool("box_record", { box: phone.name, action: "start" })));
  assert.match(text(await tool("box_record", { box: phone.name, action: "step", text: "It turns right" })), /^Captioned the next step: ▶ It turns right/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await control.request({ type: "control", control: { action: "rotate", turn: "right" } })).ok, true);
  assert.match(text(await tool("box_record", { box: phone.name, action: "result", passed: true, text: "Turned right" })), /^Captioned the result: ✓ Turned right/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const stopped = text(await tool("box_record", { box: phone.name, action: "stop" }));
  assert.match(stopped, /^Recorded box \S+'s device: a \d+\.\d s clip of \d+\.\d s recorded, .*1280x\d+, \d+ KB, 1 step captioned\./, stopped);
  const clip = /\$BB_THREAD_STORAGE\/(recordings\/[^ ,]+)\.mp4/.exec(stopped)?.[1];
  assert.ok(clip, stopped);
  assert.equal(readFileSync(join(world.storage, `${clip}.mp4`)).subarray(4, 8).toString("latin1"), "ftyp");
  assert.match(text(await tool("box_record", { box: phone.name, action: "step", text: "Late" })), /is not recording\./);
});

test("box_copy takes files in the thread's storage folder both ways, by its variable or its path (#482)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const { name } = await only(app);
  mkdirSync(join(world.storage, "prof"));
  writeFileSync(join(world.storage, "prof", "check.mjs"), "stored\n");

  const byPath = await tool("box_copy", { box: name, direction: "to_box", from: join(world.storage, "prof", "check.mjs") });
  assert.ok(!isError(byPath), text(byPath));
  assert.match(text(byPath), /\(7 bytes, SHA-256 [0-9a-f]{64}\) to check\.mjs in box/);
  assert.ok(!isError(await tool("box_copy", { box: name, direction: "to_box", from: "$BB_THREAD_STORAGE/prof/check.mjs", to: "again.mjs" })));
  assert.match(text(await tool("box_run", { box: name, command: "cat check.mjs again.mjs > both.txt" })), /Exit code 0/);

  const back = await tool("box_copy", { box: name, direction: "from_box", from: "both.txt", to: "${BB_THREAD_STORAGE}/out/both.txt" });
  assert.ok(!isError(back), text(back));
  assert.match(text(back), /in this thread's storage folder\./);
  assert.equal(readFileSync(join(world.storage, "out", "both.txt"), "utf8"), "stored\nstored\n");
  // A path in neither folder is still the workspace's, and BB refuses to read one outside it.
  writeFileSync(join(world.root, "other.txt"), "x");
  const outside = await tool("box_copy", { box: name, direction: "to_box", from: join(world.root, "other.txt") });
  assert.ok(isError(outside));
  assert.match(text(outside), /escapes read root/);
});

test("box_copy streams a file too large for BB's file API through the thread's machine, both ways, and checks its SHA-256 (#492)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  const saved = process.env.BB_SERVER_URL;
  process.env.BB_SERVER_URL = "https://bb.example.com";
  t.after(() => (saved === undefined ? delete process.env.BB_SERVER_URL : (process.env.BB_SERVER_URL = saved)));
  // bb-box's worker on the thread's machine, its WebSocket joined to bb-box's route in memory.
  const { urls, connectTo } = joined(() => app.files);
  const worker = experimental_createHostEntryHarness(hostEntry({ files: { connect: connectTo } }));
  t.after(() => worker.experimental_dispose());
  world.hostEntry = (method, _hostId, input) => (method === "file" ? worker.experimental_call("file", input as never) : { started: false, pid: null });
  await tool("box_acquire", {});
  const { name } = await only(app);
  const big = join(world.workspace, "setup.bin");
  const content = randomBytes(26 * 1024 * 1024);
  writeFileSync(big, content);
  const sha = createHash("sha256").update(content).digest("hex");

  const sent = await tool("box_copy", { box: name, direction: "to_box", from: big });
  assert.ok(!isError(sent), text(sent));
  assert.match(text(sent), new RegExp(`^Copied ${big} \\(${content.length} bytes, SHA-256 ${sha}\\) to setup\\.bin in box ${name}, streamed through the thread's machine\\.`));
  assert.match(urls[0]!, /^wss:\/\/bb\.example\.com\/api\/v1\/plugins\/bb-box\/http\/file-relay\?s=[0-9a-f]{32}$/);
  const inBox = text(await tool("box_run", { box: name, command: "sha256sum setup.bin; ls" }));
  assert.ok(inBox.includes(`${sha}  setup.bin\n`), inBox);
  assert.doesNotMatch(inBox, /bb-box-part/, "the part file took the file's place");

  const back = await tool("box_copy", { box: name, direction: "from_box", from: "setup.bin", to: "back.bin" });
  assert.ok(!isError(back), text(back));
  assert.match(text(back), new RegExp(`^Copied setup\\.bin \\(${content.length} bytes, SHA-256 ${sha}\\) from box ${name} to ${join(world.workspace, "back.bin")} in the workspace, streamed through the thread's machine\\.`));
  assert.equal(createHash("sha256").update(readFileSync(join(world.workspace, "back.bin"))).digest("hex"), sha);
  assert.ok(!existsSync(join(world.workspace, "back.bin.bb-box-part")));
  // The worker's lease goes once bb-box closes the link.
  await until("the lease to go", async () => worker.experimental_getRetainedWorkerLeaseCount() === 0);
});

test("a kind a backend changes by itself, as when a Mac reports Windows video ready after a restart, reaches the boxes made before (#916)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", { kind: "linux" });
  const box = await only(app);
  const kind = world.backend!.kinds().find((candidate) => candidate.id === box.kind)!;
  // The backend adds a display to the kind, as the Tart backend adds video once a Mac is ready, and says so.
  const video = { id: "video", protocol: "selkies", resizable: true } as const;
  world.backend!.offer(world.backend!.kinds().map((each) => (each.id === kind.id ? { ...each, capabilities: { ...each.capabilities, displays: [...each.capabilities.displays, video] } } : each)));
  world.contexts.at(-1)!.kindsChanged!();
  await until("the box to take the kind's displays", async () => (await app.boxes.find(box.id))?.capabilities.displays.some((display) => display.id === "video") ?? false);
});

test("after a Windows box enrols, and after it reconnects, bb-box hides the windows of BB's daemon's consoles, which BB starts in front (bb-requests 27)", async (t) => {
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, enrol: true } };
  const shell = join(tempDir("windows-shell"), "pwsh");
  // Each run in the desktop session, BB's installer and the hide alike, says it found and hid one console window.
  writeFileSync(shell, `#!/bin/sh\ncase "$2" in *Schedule.Service*) echo "consoles=1 hidden=1"; exit 0 ;; *"]::Daemon("*) exit ${ACCESS_CHECK_EXITS.noDaemon} ;; esac\nexit 1\n`);
  chmodSync(shell, 0o755);
  const { harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [kind], shell, logonWaitMs: 100 });
  t.after(() => harness.lifecycle.dispose());
  world.windowsConnects = true;
  const hid = (name: string) => harness.inspection.logEntries.filter((entry) => entry.message === `Hid 1 of BB's 1 console window on box ${name}'s desktop (bb-requests 27).`).length;
  await tool("box_acquire", { kind: "windows" });
  const box = await only(app);
  await until("the hide after the enrolment", async () => hid(box.name) === 1);
  const hostId = `host-${box.id}`;
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await tool("box_stop", { box: box.name });
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  await until("the hide after the reconnect", async () => hid(box.name) === 2);
});

test("a Windows box on trial enrols as a machine of BB's manual provider, which bb-box owns: release, a failure and the sweep remove it, and a start reconnects only a disconnected one (#539)", async (t) => {
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, enrol: true } };
  // A box's PowerShell that runs the desktop session's command as BB's installer would, and exits 0.
  // Its access check finds no BB daemon (#560); anything else fails.
  const dir = tempDir("windows-shell");
  const shell = join(dir, "pwsh");
  // The look for BB's daemon on its way says what the file daemon says (#917): none to begin with.
  const daemon = join(dir, "daemon");
  writeFileSync(daemon, "none\n");
  writeFileSync(shell, `#!/bin/sh\ncase "$2" in *Schedule.Service*) exit 0 ;; *"]::Daemon("*) exit ${ACCESS_CHECK_EXITS.noDaemon} ;; *install-machine-windows*) cat '${daemon}'; exit 0 ;; esac\nexit 1\n`);
  chmodSync(shell, 0o755);
  const { bb, harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [kind], shell, logonWaitMs: 400 });
  t.after(() => harness.lifecycle.dispose());
  world.windowsConnects = true;
  await tool("box_acquire", { kind: "windows" });
  const box = await only(app);
  await until("the enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const hostId = `host-${box.id}`;
  assert.ok(world.events.includes(`create manual ${hostId}`), world.events.join("\n"));
  assert.ok(world.events.includes(`enrolment command ${hostId}`));
  assert.deepEqual(world.bootstraps, [], "BB's POSIX bootstrap is not run");
  assert.equal(world.hosts.get(hostId)?.name, box.name, "the machine is named after the box once it connects");
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), [`manual-machine/${hostId}`]);
  // A start runs BB's reconnect command only when BB shows the machine disconnected.
  await tool("box_stop", { box: box.name });
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  assert.ok(!world.events.includes(`reconnect command ${hostId}`), world.events.join("\n"));
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await tool("box_stop", { box: box.name });
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  assert.ok(world.events.includes(`reconnect command ${hostId}`), world.events.join("\n"));
  assert.equal((await app.boxes.find(box.id))?.enrol.error, null);
  // After a boot, BB's logon entry starts the daemon: bb-box waits for it to connect, and starts no second supervisor (#917).
  const reconnects = () => world.events.filter((event) => event === `reconnect command ${hostId}`).length;
  const before = reconnects();
  writeFileSync(daemon, "logon\n");
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await tool("box_stop", { box: box.name });
  setTimeout(() => world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "connected" }), 150);
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  await until("the daemon to connect", async () => world.hosts.get(hostId)?.status === "connected");
  assert.equal(reconnects(), before, "no reconnect while the logon starts the daemon");
  // A daemon on its way that never connects gets BB's reconnect once the wait is over.
  writeFileSync(daemon, "running\n");
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await tool("box_stop", { box: box.name });
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  await until("the reconnect after the wait", async () => reconnects() === before + 1);
  // Releasing the box removes its machine, and bb-box's record of it.
  assert.ok(!isError(await tool("box_release", { box: box.name })));
  assert.equal(world.hosts.has(hostId), false);
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), []);

  // A failed enrolment removes its machine.
  world.windowsConnects = false;
  world.windowsEnrolment = false;
  await tool("box_acquire", { kind: "windows" });
  const failed = await only(app);
  await until("the enrolment to fail", async () => (await app.boxes.find(failed.id))?.enrol.state === "failed");
  assert.match((await app.boxes.find(failed.id))!.enrol.error!, /BB gave no Windows enrolment command/);
  assert.equal(world.hosts.has(`host-${failed.id}`), false);
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), []);

  // The sweep removes a manual machine whose box is gone.
  const leftover = makeHostResponse({ id: "host-left", status: "connected", machineProviderId: "manual" });
  world.hosts.set("host-left", leftover);
  await bb.storage.kv.set("manual-machine/host-left", { boxId: "bxgone", at: 0 });
  await app.enrolment.sweep();
  assert.equal(world.hosts.has("host-left"), false);
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), []);
});

test("a Windows box sets up the thread's access while BB's installer runs, not after it, as that takes most of a minute (#916)", async (t) => {
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, enrol: true } };
  const dir = tempDir("windows-shell");
  const shell = join(dir, "pwsh");
  const order = join(dir, "order");
  // BB's installer, in the desktop session, takes a second; the access setup notes when it ran.
  writeFileSync(
    shell,
    `#!/bin/sh\ncase "$2" in *Schedule.Service*) sleep 1; echo installed >> '${order}'; exit 0 ;; *"]::Daemon("*) exit ${ACCESS_CHECK_EXITS.noDaemon} ;; *"gh auth setup-git"*) echo access >> '${order}'; echo 5; exit 0 ;; esac\nexit 1\n`,
  );
  chmodSync(shell, 0o755);
  const { harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [kind], shell });
  t.after(() => harness.lifecycle.dispose());
  world.windowsConnects = true;
  await tool("box_acquire", { kind: "windows" });
  const box = await only(app);
  await until("the enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  assert.deepEqual(readFileSync(order, "utf8").trim().split("\n"), ["access", "installed"]);
});

test("a Windows box's release ends its threads' processes, waits for BB to finish removing its manual machine, and keeps its record of one BB is slow to remove (#539)", async (t) => {
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, enrol: true } };
  const dir = tempDir("windows-shell");
  const shell = join(dir, "pwsh");
  // The script that ends the threads' processes leaves a mark, and says it ended 2.
  const ended = join(dir, "ended");
  writeFileSync(
    shell,
    `#!/bin/sh\ncase "$2" in *Schedule.Service*) exit 0 ;; *"]::Daemon("*) exit ${ACCESS_CHECK_EXITS.noDaemon} ;; *BbProcessDirectory*) : > '${ended}'; echo ended=2; exit 0 ;; esac\nexit 1\n`,
  );
  chmodSync(shell, 0o755);
  const { bb, harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [kind], shell, manualRemoveMs: 300 });
  t.after(() => harness.lifecycle.dispose());
  world.windowsConnects = true;
  const acquire = async () => {
    await tool("box_acquire", { kind: "windows" });
    const box = await only(app);
    await until("the enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
    return { box, hostId: `host-${box.id}` };
  };
  // As BB: the delete returns at once, and BB removes the machine once it has torn down the environments on it.
  const removing = (hostId: string, message: string | null) => {
    const host = world.hosts.get(hostId)!;
    world.hosts.set(hostId, { ...host, lifecycle: { ...host.lifecycle, phase: "removing", message } });
  };

  const first = await acquire();
  let releasedFirst: boolean | null = null;
  let endedFirst: boolean | null = null;
  world.bbRemovals.set(first.hostId, async () => {
    endedFirst = existsSync(ended);
    removing(first.hostId, null);
    setTimeout(() => {
      releasedFirst = world.backend!.calls.some((call) => call.startsWith("release "));
      world.hosts.delete(first.hostId);
    }, 100);
  });
  assert.ok(!isError(await tool("box_release", { box: first.box.name })));
  assert.equal(releasedFirst, false, "the box goes once BB has removed its machine");
  assert.equal(endedFirst, true, "the threads' processes ended before BB was asked to remove the machine");
  assert.ok(harness.inspection.logEntries.some((entry) => entry.message === `Ended 2 processes of threads in box ${first.box.name} before its BB machine's removal, so that BB can remove their worktrees.`));
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), []);

  // BB is still removing it when the wait ends, as when the box went first: the box goes, and bb-box keeps its record and logs it once.
  const second = await acquire();
  world.bbRemovals.set(second.hostId, async () => removing(second.hostId, "Host is not connected"));
  assert.ok(!isError(await tool("box_release", { box: second.box.name })));
  assert.deepEqual(await app.boxes.list(THREAD), []);
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), [`manual-machine/${second.hostId}`]);
  const stuck = () => harness.inspection.logEntries.map((entry) => entry.message).filter((line) => line.startsWith(`BB has not finished removing machine ${second.hostId}`));
  assert.equal(stuck().length, 1);
  // With the machine's name, which is its box's.
  assert.match(stuck()[0]!, new RegExp(`s after bb-box asked: "${second.box.name}" is removing, Host is not connected\\. bb-box keeps its record, and its sweep looks again\\.$`));
  // The sweep looks again without logging it again, and forgets it once BB no longer has it.
  await app.enrolment.sweep();
  assert.equal(stuck().length, 1);
  assert.equal(world.hosts.has(second.hostId), true);
  world.hosts.delete(second.hostId);
  await app.enrolment.sweep();
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), []);
});

test("a box_copy under 16 MiB checks the size and SHA-256 at both ends, both ways, and a short copy fails, leaving nothing written here", async (t) => {
  const { harness, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  t.after(() => loseLastByteOfCopies(null));
  const name = /Box (\S+) \(/.exec(text(await tool("box_acquire", {})))![1]!;
  const content = "a file that must arrive whole\n";
  const sum = `${content.length} bytes, SHA-256 ${createHash("sha256").update(content).digest("hex")}`;
  const short = `${content.length - 1} bytes, SHA-256 ${createHash("sha256").update(content.slice(0, -1)).digest("hex")}`;
  writeFileSync(join(world.workspace, "whole.txt"), content);

  loseLastByteOfCopies("write");
  const sentShort = await tool("box_copy", { box: name, direction: "to_box", from: "whole.txt" });
  assert.ok(isError(sentShort));
  assert.match(text(sentShort), new RegExp(`The copy of ${join(world.workspace, "whole.txt")} did not arrive whole: ${sum} went, and whole\\.txt in the box has ${short}\\. Copy it again\\.`));

  loseLastByteOfCopies(null);
  const sent = await tool("box_copy", { box: name, direction: "to_box", from: "whole.txt" });
  assert.match(text(sent), new RegExp(`^Copied ${join(world.workspace, "whole.txt")} \\(${sum}\\) to whole\\.txt in box ${name}\\.`));

  loseLastByteOfCopies("read");
  const backShort = await tool("box_copy", { box: name, direction: "from_box", from: "whole.txt", to: "back.txt" });
  assert.ok(isError(backShort));
  assert.match(text(backShort), new RegExp(`The copy of whole\\.txt did not arrive whole: the box has ${sum}, and ${short} came\\. Nothing was written\\. Try again\\.`));
  assert.ok(!existsSync(join(world.workspace, "back.txt")));

  loseLastByteOfCopies(null);
  const back = await tool("box_copy", { box: name, direction: "from_box", from: "whole.txt", to: "back.txt" });
  assert.match(text(back), new RegExp(`^Copied whole\\.txt \\(${sum}\\) from box ${name} to ${join(world.workspace, "back.txt")} in the workspace\\.`));
  assert.equal(readFileSync(join(world.workspace, "back.txt"), "utf8"), content);
});

test("box_copy names a file from a Windows box after its source", async (t) => {
  // Without FAKE_PWSH, the fake box copies files with sh, as it does for Linux.
  const { harness, world, tool } = await start({ "fake-enabled": true }, { kinds: [FAKE_WINDOWS_KIND] });
  t.after(() => harness.lifecycle.dispose());
  const name = /Box (\S+) \(/.exec(text(await tool("box_acquire", { kind: "windows" })))![1]!;
  writeFileSync(join(world.workspace, "in.txt"), "from Windows\n");
  const into = await tool("box_copy", { box: name, direction: "to_box", from: "in.txt", to: "C:\\Users\\box\\out.txt" });
  assert.ok(!isError(into), text(into));
  const out = await tool("box_copy", { box: name, direction: "from_box", from: "C:\\Users\\box\\out.txt" });
  assert.ok(!isError(out), text(out));
  assert.equal(readFileSync(join(world.workspace, "out.txt"), "utf8"), "from Windows\n");
});

test("workspace and box paths", () => {
  assert.equal(workspacePath("/work/thread", "a/../b.txt"), "/work/thread/b.txt");
  assert.equal(workspacePath("/work/thread", "/etc/hosts"), "/etc/hosts");
  assert.equal(workspacePath("C:\\work", "a\\b.txt"), "C:\\work\\a\\b.txt");
  assert.throws(() => workspacePath(null, "b.txt"), /b.txt is a relative path, and this thread's workspace has no directory/);
  assert.equal(boxPath("~/x/y"), "x/y");
  assert.equal(boxPath("x/y"), "x/y");
  assert.equal(boxPath("/tmp/y"), "/tmp/y");
});

test("a ready box becomes a BB machine, and its machine goes before the box", async (t) => {
  const daemon = await fakeDaemon([{ GH_TOKEN: "value-token", MACHINE_VAR: "value-machine", PROJECT_VAR: "value-project", UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent });
  t.after(() => harness.lifecycle.dispose());
  // The thread's access is set up while BB's installer runs: it sees ~/.bashrc change.
  world.installer =
    'for i in $(seq 50); do grep -qs "Added by bb-box" .bashrc && break; sleep 0.1; done; grep -c "Added by bb-box" .bashrc > access-during-install; echo installed > bb-installed';
  // A box has gh, which the access setup makes git's helper: here a stand-in whose setup-git fails, as when gh is not
  // logged in, so the setup adds the helper itself, whether or not this machine has gh.
  const bin = tempDir("fake-gh");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  t.after(() => {
    process.env.PATH = path;
  });

  // box_acquire waits for enrolment, as box_run would, and says how long it took.
  const acquired = text(await tool("box_acquire", { kind: "linux" }));
  assert.match(acquired, /BB machine: enrolled/);
  assert.match(acquired, /Timings: .*total \d+(?: ms|\.\d s), BB enrolment \d+(?: ms|\.\d s)/);
  const box = await only(app);
  const enrolled = await until("enrolment", async () => {
    const current = await app.boxes.find(box.id);
    return current?.enrol.state === "enrolled" ? current : null;
  });
  assert.equal(enrolled.enrol.hostId, `host-${box.id}`);
  assert.equal(enrolled.timings.enrol, Object.values(enrolled.timings).at(-1), "enrolment is timed after the start-up steps");
  assert.ok(enrolled.timings.enrol! >= 0);
  assert.deepEqual(world.bootstraps, [box.id], "BB's bootstrap runs once, keyed by the box ID");
  assert.equal(world.hosts.get(`host-${box.id}`)?.name, box.name);
  assert.equal(text(await tool("box_run", { box: box.name, command: "cat access-during-install" })).match(/stdout:\n(\d)/)?.[1], "1");

  // The log says how long each step took, counted from when the box was ready.
  const logged = harness.inspection.logEntries.map((entry) => entry.message).find((line) => line.startsWith(`Enrolled box ${box.name} `));
  assert.ok(logged, "the enrolment is logged");
  const s = String.raw`\d+\.\d\d s`;
  for (const step of ["BB calling bb-box's create", "reaching the box", "BB preparing the enrolment", "BB's installer in the box", "BB waiting for the daemon"]) {
    assert.match(logged, new RegExp(`, ${step} ${s},`), step);
  }
  assert.match(logged, new RegExp(`^Enrolled box ${box.name} ${s} after it was ready: asking BB ${s} alongside, BB calling bb-box's create ${s}, .*, finishing ${s}\\.$`));
  const parts = ["fetching the variable names", "reaching the box and back", "running the script"].map((part) => `${part} ${s}`);
  assert.match(logged, new RegExp(`, setting up the thread's access ${s} alongside \\(${parts.join(", ")}\\), `));
  // Once bootstrap returns, bb-box notices the machine connected at once rather than at its next 500 ms poll.
  assert.match(logged, /, BB showing the machine connected 0\.[0-2]\d s,/);

  // BB's installer ran in the box, and commands see the box's identity.
  const installed = await tool("box_run", { box: box.name, command: 'cat bb-installed; echo "$BB_BOX_NAME $BB_THREAD_ID $BB_HOST_ID"' });
  assert.match(text(installed), new RegExp(`installed\n${box.name} ${THREAD} host-${box.id}`));
  assert.match(text(await tool("box_status", { box: box.name })), /BB machine: enrolled\n.*BB enrolment \d+(?: ms|\.\d s)/);
  assert.match(text(await tool("box_list", {})), /enrolled as a BB machine in \d+(?: ms|\.\d s)/);

  // Commands take the listed variables from BB's daemon, and nothing else.
  const access = await tool("box_run", { box: box.name, command: 'printf "%s|" "${GH_TOKEN:+token}" "$MACHINE_VAR" "$PROJECT_VAR" "${UNLISTED-unset}"' });
  assert.match(text(access), /stdout:\ntoken\|value-machine\|value-project\|unset\|/);
  // So do SSH commands, through ~/.bashrc. git asks gh for GitHub credentials, and fetches GitHub's SSH URLs over HTTPS.
  const shells = await tool("box_run", {
    box: box.name,
    command:
      'head -n 1 .bashrc; bash -c \'unset MACHINE_VAR; . ~/.bashrc; printf "%s\\n" "$MACHINE_VAR"\'; git config --global --get-all credential.https://github.com.helper; ' +
      "git ls-remote --get-url git@github.com:o/r.git",
  });
  assert.match(text(shells), /stdout:\n# Added by bb-box: .*\nvalue-machine\n(.*\n)*.*gh auth git-credential\nhttps:\/\/github\.com\/o\/r\.git\n/);
  // BB was asked for the names once, as the box started, and not again for each command.
  assert.deepEqual(world.names.sort(), [PROJECT, "system"]);

  await tool("box_release", { box: box.name });
  assert.deepEqual(world.events, [`create host-${box.id}`, `delete host-${box.id}`]);
  assert.equal(world.hosts.size, 0);
  assert.deepEqual(world.backend!.calls.filter((call) => call.startsWith("release")).length, 1);
});

test("the enrolment waits for BB's daemon to start a worker with the thread's variables, so the first command has them", async (t) => {
  const connected = join(tempDir("connected"), "connected");
  const daemon = await fakeDaemon([{ GH_TOKEN: "value-token", MACHINE_VAR: "value-machine" }], { startOn: { file: connected, seconds: 1 } });
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent });
  t.after(() => harness.lifecycle.dispose());
  // BB shows the machine connected as its installer returns, and its daemon starts the workers a second later.
  world.installer = `: > '${connected}'`;

  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const run = await tool("box_run", { box: box.name, command: 'printf "%s|%s\\n" "${GH_TOKEN:+token}" "$MACHINE_VAR"' });
  assert.match(text(run), /stdout:\ntoken\|value-machine\n/);
  const logged = harness.inspection.logEntries.map((entry) => entry.message).find((line) => line.startsWith(`Enrolled box ${box.name} `));
  assert.match(logged ?? "", /, waiting for a worker with the thread's variables (0\.[5-9]|[1-4]\.\d)\d s, finishing /);
});

test("the enrolment waits for GH_TOKEN, which BB can give a new machine after its other variables, so the first command has it and the git identity", async (t) => {
  const connected = join(tempDir("connected"), "connected");
  const identity = { GIT_AUTHOR_NAME: "A Person", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A Person", GIT_COMMITTER_EMAIL: "a@example.com" };
  // A worker with the git identity a second after the machine connects; GH_TOKEN a second or so later.
  const daemon = await fakeDaemon([identity], { startOn: { file: connected, seconds: 1 } });
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent });
  t.after(() => harness.lifecycle.dispose());
  world.installer = `: > '${connected}'; (sleep 2; : > '${connected}.token') >/dev/null 2>&1 &`;
  void (async () => {
    for (let i = 0; i < 200 && !existsSync(`${connected}.token`); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    daemon.start({ ...identity, GH_TOKEN: "value-token" });
  })();

  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const logged = harness.inspection.logEntries.map((entry) => entry.message).find((line) => line.startsWith(`Enrolled box ${box.name} `));
  assert.match(logged ?? "", /, waiting for a worker with the thread's variables [1-9]\.\d+ s, finishing /, "past the identity, until GH_TOKEN");
  const run = await tool("box_run", { box: box.name, command: 'printf "%s\\n" "${GH_TOKEN:+token}"; git var GIT_AUTHOR_IDENT; git var GIT_COMMITTER_IDENT' });
  assert.match(text(run), /stdout:\ntoken\nA Person <a@example\.com> \d+ [+-]\d{4}\nA Person <a@example\.com> \d+ [+-]\d{4}\n/);
});

test("box_start waits for the box's BB daemon to start again with a worker with the thread's variables", async (t) => {
  const parent = join(tempDir("daemon"), "daemon-bundle");
  const { harness, app, world, tool } = await start(undefined, { daemonParent: parent });
  t.after(() => harness.lifecycle.dispose());
  // Nothing runs the daemon's program yet, so the enrolment does not wait.
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  await tool("box_stop", { box: box.name });

  // Bootstrap starts the daemon again, and it starts the workers a second later.
  const restarted = join(tempDir("restarted"), "restarted");
  const daemon = await fakeDaemon([{ GH_TOKEN: "value-token", MACHINE_VAR: "value-machine" }], { parent, startOn: { file: restarted, seconds: 1 } });
  t.after(daemon.stop);
  world.installer = `: > '${restarted}'`;
  const started = await tool("box_start", { box: box.name });
  assert.ok(!isError(started), text(started));
  assert.equal(daemon.workers().length, 1, "box_start returned once the worker started");
  const run = await tool("box_run", { box: box.name, command: 'printf "%s|%s\\n" "${GH_TOKEN:+token}" "$MACHINE_VAR"' });
  assert.match(text(run), /stdout:\ntoken\|value-machine\n/);
});

test("commands in an enrolled box keep the thread's access when BB's workers that had it are gone, from bb-box's host entry, and its old terminal is closed", async (t) => {
  // No worker has the variables, as after a plugin reload stopped BB's plugin workers in the box.
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent, variablesWaitMs: 300 });
  t.after(() => harness.lifecycle.dispose());
  // BB's worker for bb-box's host entry starts a process with the daemon's variables, below the daemon.
  let started: (() => boolean) | null = null;
  world.hostEntry = (_method, hostId) => {
    if (!started) {
      // The terminal bb-box kept for this before (#217), there before the first call.
      world.terminals.set("term_old", { id: "term_old", hostId, title: RETIRED_TITLE, command: "sleep 2147483647", status: "running", createdAt: 1 });
      started = daemon.start({ GH_TOKEN: "value-token", MACHINE_VAR: "value-machine" });
    }
    return { started: true, pid: 1 };
  };

  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const hostId = `host-${box.id}`;
  await until("the host entry's process", async () => started?.() ?? false);
  const show = { box: box.name, command: 'printf "%s|%s\\n" "${GH_TOKEN:+token}" "$MACHINE_VAR"' };
  assert.match(text(await tool("box_run", show)), /stdout:\ntoken\|value-machine\n/);
  assert.match(text(await tool("box_run", show)), /stdout:\ntoken\|value-machine\n/);

  const calls = world.hostCalls.filter((call) => call.method === "access");
  assert.ok(calls.length >= 1 && calls.every((call) => call.hostId === hostId), JSON.stringify(calls));
  assert.ok(calls.length <= 2, "within 30 s, commands do not call again");
  const names = (calls[0]!.input as { names: string[] }).names;
  assert.ok(names.includes("GH_TOKEN") && names.includes("MACHINE_VAR"), names.join(" "));
  await until("the old terminal to close", async () => world.terminals.get("term_old")?.status === "exited");
});

test("the sweeper stops at once when the plugin stops, mid-reconnect or with BB not answering, though a backend's call would wait", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const hostId = `host-${box.id}`;

  // BB shows the machine disconnected, so the sweep starts its daemon again, and BB's installer takes minutes.
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  world.installer = "sleep 300";
  const before = world.bootstraps.length;
  const first = harness.behavior.runService("sweeper");
  await until("the reconnect to start", async () => world.bootstraps.length > before);
  let stopped = Date.now();
  first.controller.abort(new Error("the plugin is stopping"));
  await first.done;
  assert.ok(Date.now() - stopped < 1_000, `the sweeper stopped in ${Date.now() - stopped} ms, not when the installer ends`);

  // BB no longer answers the plugin's calls about machines, as for a plugin that is stopping.
  world.silent = true;
  const second = harness.behavior.runService("sweeper");
  await new Promise((resolve) => setTimeout(resolve, 100));
  stopped = Date.now();
  second.controller.abort(new Error("the plugin is stopping"));
  await second.done;
  assert.ok(Date.now() - stopped < 1_000, `the sweeper stopped in ${Date.now() - stopped} ms`);
  world.silent = false;
});

test("the images-after-a-BB-update service ends within a second when the plugin stops during its look at the images (#852)", async (t) => {
  // BB's server takes the look's question about its app and never answers, as one that is going away.
  const asked: ServerResponse[] = [];
  const server = createServer((_request, response) => void asked.push(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { harness, app } = await start(undefined, { appUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  // The plugin first, as it can ask again until it stops; then every connection, as the server answers none, and the server.
  t.after(async () => {
    await harness.lifecycle.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, general: { ...rest.general, nightlyImages: true } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));

  const service = harness.behavior.runService("bb-update-images");
  await until("the look to ask BB's server", async () => asked.length > 0);
  const stopped = Date.now();
  service.controller.abort(new Error("the plugin is stopping"));
  // Before #852 it ended only when its wait for the next look ran out, about 5 minutes later.
  const ended = await Promise.race([service.done.then(() => true), new Promise<boolean>((resolve) => setTimeout(resolve, 1_000, false).unref())]);
  assert.ok(ended, "the service did not end within a second of the plugin stopping");
  assert.ok(Date.now() - stopped < 1_000, `the service ended in ${Date.now() - stopped} ms`);
});

test("box_start waits for BB to show the box's machine connected again, but only so long", async (t) => {
  const { harness, app, world, tool } = await start(undefined, { variablesWaitMs: 300 });
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const hostId = `host-${box.id}`;
  const stop = async () => {
    await tool("box_stop", { box: box.name });
    world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  };

  await stop();
  world.connectAfterMs = 200;
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  assert.equal(world.hosts.get(hostId)?.status, "connected", "box_start returned once BB showed the machine connected");

  await stop();
  world.connectAfterMs = null;
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(messages.includes(`BB did not show box ${box.name}'s machine connected 0.3 s after its daemon started again.`), messages.join("\n"));
});

test("a box whose machine BB removes while bb-box waits for the variables is not enrolled", async (t) => {
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent, variablesWaitMs: 1_500 });
  t.after(() => harness.lifecycle.dispose());

  const acquired = tool("box_acquire", { kind: "linux" });
  const box = await until("BB to show the machine connected", async () => {
    const [current] = await app.boxes.list(THREAD);
    return current && world.hosts.get(`host-${current.id}`)?.status === "connected" ? current : null;
  });
  // The enrolment notices within 100 ms, then waits for a worker that never starts.
  await new Promise((resolve) => setTimeout(resolve, 500));
  world.hosts.delete(`host-${box.id}`);
  await app.enrolment.forgetHost(`host-${box.id}`);
  assert.ok(!isError(await acquired));
  // The wait ends at its next look, well before its 1.5 s are up.
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "off", hostId: null, error: null });
  assert.ok(!messages.some((line) => line.startsWith(`Enrolled box ${box.name} `) || line.startsWith(`BB's daemon in box ${box.name} had no worker`)), messages.join("\n"));
});

test("a box whose machine BB removes while its daemon starts again is not enrolled", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  await tool("box_stop", { box: box.name });

  const go = join(tempDir("go"), "go");
  world.installer = `while [ ! -e '${go}' ]; do sleep 0.05; done`;
  const started = tool("box_start", { box: box.name });
  await until("bootstrap", async () => world.bootstraps.length === 2);
  world.hosts.delete(`host-${box.id}`);
  await app.enrolment.forgetHost(`host-${box.id}`);
  writeFileSync(go, "");
  assert.ok(!isError(await started));
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "off", hostId: null, error: null });
});

test("without GitHub in BB, a new box waits only for the machine variables a user set, not for GH_TOKEN", async (t) => {
  const connected = join(tempDir("connected"), "connected");
  const daemon = await fakeDaemon([{ MACHINE_VAR: "value-machine" }], { startOn: { file: connected, seconds: 0.5 } });
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent });
  t.after(() => harness.lifecycle.dispose());
  world.git = "not logged in";
  world.installer = `: > '${connected}'`;
  const started = Date.now();
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  assert.ok(Date.now() - started < 10_000, `no wait for a token BB does not give: ${Date.now() - started} ms`);
  const box = await only(app);
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(!messages.some((line) => line.includes("had no process with the thread's GH_TOKEN")), messages.join("\n"));
  const run = await tool("box_run", { box: box.name, command: 'printf "%s|%s" "${GH_TOKEN:-none}" "$MACHINE_VAR"' });
  assert.match(text(run), /stdout:\nnone\|value-machine/);
});

test("without GitHub or machine variables in BB, a new box does not wait at all, as BB gives git's identity only with its GitHub login", async (t) => {
  const connected = join(tempDir("connected"), "connected");
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }], { startOn: { file: connected, seconds: 0.5 } });
  t.after(daemon.stop);
  const { harness, world, tool } = await start(undefined, { daemonParent: daemon.parent });
  t.after(() => harness.lifecycle.dispose());
  world.git = "not logged in";
  world.machineVariables = [];
  world.projectVariables = [];
  world.installer = `: > '${connected}'`;
  const started = Date.now();
  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  assert.ok(Date.now() - started < 10_000, `no wait for variables BB does not give: ${Date.now() - started} ms`);
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(!messages.some((line) => line.includes("had no process with the thread's")), messages.join("\n"));
});

test("the enrolment waits only so long for a worker with the thread's variables", async (t) => {
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, tool } = await start(undefined, { daemonParent: daemon.parent, variablesWaitMs: 300 });
  t.after(() => harness.lifecycle.dispose());

  assert.match(text(await tool("box_acquire", { kind: "linux" })), /BB machine: enrolled/);
  const box = await only(app);
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(
    messages.includes(`BB's daemon in box ${box.name} had no process with the thread's GH_TOKEN 0.3 s after the machine connected. Its commands take it once one has.`),
    messages.join("\n"),
  );
  // The wait counts from when the machine connected, so any wait for the access setup is part of it.
  const line = messages.find((entry) => entry.startsWith(`Enrolled box ${box.name} `)) ?? "";
  const step = (label: string) => Number(new RegExp(`, ${label} (\\d+\\.\\d+) s,`).exec(line)?.[1] ?? 0);
  assert.match(line, /, waiting for a worker with the thread's variables 0\.\d+ s, finishing /);
  assert.ok(step("waiting for the access setup") + step("waiting for a worker with the thread's variables") >= 0.29, line);
});

test("an enrolment fails, and says why, when BB's daemon stops soon after the machine connects, as in a box out of memory (#286)", async (t) => {
  // A worker without the thread's variables keeps the enrolment waiting while the daemon stops.
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent, variablesWaitMs: 1_500 });
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { presets: { small: { memoryMiB: 1024 } } } } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));

  const acquired = tool("box_acquire", { kind: "linux", size: "small" });
  const box = await until("BB to show the machine connected", async () => {
    const [current] = await app.boxes.list(THREAD);
    return current && world.hosts.get(`host-${current.id}`)?.status === "connected" ? current : null;
  });
  // The enrolment notices within 100 ms, then waits for a worker with the thread's variables.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const hostId = `host-${box.id}`;
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });

  const reason =
    `BB's daemon in box ${box.name} stopped soon after it connected, and BB did not show the machine connected again within 1.5 s. ` +
    "The box has 1 GiB memory: with less than 2 GiB it can run out of memory as it becomes a BB machine.";
  const result = text(await acquired);
  assert.ok(result.includes(`BB machine: enrolment failed: ${reason}\n`), result);
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "failed", hostId, error: reason });
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(messages.includes(reason), messages.join("\n"));
  assert.ok(!messages.some((line) => line.startsWith(`Enrolled box ${box.name} `)), messages.join("\n"));

  // Its machine goes with it.
  await tool("box_release", { box: box.name });
  assert.deepEqual(world.events, [`create ${hostId}`, `delete ${hostId}`]);
});

test("an enrolment that finds the machine disconnected as its waits end gives BB a while to show it connected again (#286)", async (t) => {
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  const { harness, app, world, tool } = await start(undefined, { daemonParent: daemon.parent, variablesWaitMs: 1_000 });
  t.after(() => harness.lifecycle.dispose());

  const acquired = tool("box_acquire", { kind: "linux" });
  const box = await until("BB to show the machine connected", async () => {
    const [current] = await app.boxes.list(THREAD);
    return current && world.hosts.get(`host-${current.id}`)?.status === "connected" ? current : null;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const hostId = `host-${box.id}`;
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await until("the wait for the variables to end", async () =>
    harness.inspection.logEntries.some((entry) => entry.message.startsWith(`BB's daemon in box ${box.name} had no process`)),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "connected" });

  assert.match(text(await acquired), /BB machine: enrolled\n/);
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "enrolled", hostId, error: null });
});

test("a reload during an enrolment stops the replaced instance's enrolment at once: it logs no error and leaves the box enrolling, and the next run carries on (#1032)", async (t) => {
  const { harness, app, world, setupOptions } = await start(undefined, { variablesWaitMs: 30_000 });
  let host = harness;
  let sweeper: ReturnType<typeof harness.behavior.runService> | null = null;
  t.after(async () => {
    if (sweeper) {
      sweeper.controller.abort(new Error("the test ends"));
      await sweeper.done;
    }
    await host.lifecycle.dispose();
  });
  world.connectAfterMs = null;
  await host.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux" });
  const box = await until("the enrolment to wait for BB to show the machine connected, its installer done", async () => {
    const [current] = await app.boxes.list(THREAD);
    const machine = current?.enrol.hostId ? world.hosts.get(current.enrol.hostId) : undefined;
    return current?.enrol.state === "enrolling" && machine?.lifecycle.phase === "active" ? current : null;
  });
  const old = harness;
  let restarted: Awaited<ReturnType<typeof setup>> | null = null;
  const next = await host.lifecycle.reload(async (bb) => {
    restarted = await setup(bb, setupOptions);
  });
  host = next.harness;
  world.current = next.harness as never;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const oldErrors = old.inspection.logEntries.filter((entry) => /enrol/i.test(entry.message) && /stale|reloaded|error|failed/i.test(entry.message));
  assert.deepEqual(oldErrors.map((entry) => entry.message), [], "the replaced instance logs nothing about the enrolment it stopped");
  const hostId = `host-${box.id}`;
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "connected" });
  sweeper = next.harness.behavior.runService("sweeper");
  await until("the next run to enrol the box", async () => (await restarted!.boxes.find(box.id))?.enrol.state === "enrolled");
});

test("a reload while BB's installer runs in a box ends the installer, and the next run adds the box again and enrols it, rather than leave it failed (#1032)", async (t) => {
  const { harness, app, world, setupOptions } = await start();
  let host = harness;
  let sweeper: ReturnType<typeof harness.behavior.runService> | null = null;
  t.after(async () => {
    if (sweeper) {
      sweeper.controller.abort(new Error("the test ends"));
      await sweeper.done;
    }
    await host.lifecycle.dispose();
  });
  const installer = world.installer;
  world.installer = "sleep 30";
  await host.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux" });
  const box = await until("BB's installer to run in the box", async () => {
    const [current] = await app.boxes.list(THREAD);
    return current?.enrol.state === "enrolling" && world.bootstraps.length ? current : null;
  });
  const old = harness;
  let restarted: Awaited<ReturnType<typeof setup>> | null = null;
  const next = await host.lifecycle.reload(async (bb) => {
    restarted = await setup(bb, setupOptions);
  });
  host = next.harness;
  world.current = next.harness as never;
  world.installer = installer;
  sweeper = next.harness.behavior.runService("sweeper");
  await until("the next run to enrol the box", async () => (await restarted!.boxes.find(box.id))?.enrol.state === "enrolled");
  assert.ok(world.bootstraps.length >= 2, "BB's installer ran again");
  assert.deepEqual(old.inspection.logEntries.filter((entry) => /enrol/i.test(entry.message) && /fail|error|stale/i.test(entry.message)).map((entry) => entry.message), []);
  assert.ok(next.harness.inspection.logEntries.some((entry) => entry.message === `BB removed box ${box.name}'s machine while bb-box restarted, as when a restart ended BB's installer in it; bb-box adds the box again.`));
});

test("an enrolment fails, and says why, when BB does not show the machine connected soon after its daemon started (#286)", async (t) => {
  const { harness, app, world, tool } = await start(undefined, { variablesWaitMs: 300 });
  t.after(() => harness.lifecycle.dispose());
  world.connectAfterMs = null;

  // box_acquire waits for the enrolment for 20 s at most, well short of its 5 minutes.
  const result = text(await tool("box_acquire", { kind: "linux" }));
  const box = await only(app);
  const reason = `BB's daemon in box ${box.name} started, but BB did not show the machine connected within 0.3 s.`;
  assert.ok(result.includes(`BB machine: enrolment failed: ${reason}\n`), result);
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "failed", hostId: `host-${box.id}`, error: reason });
});

test("the nightly rebuilds run on bb-box's own schedule at 03:00 while General's switch is on, and not while it is off", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());
  assert.deepEqual(
    harness.inspection.registrations.schedules.filter((schedule) => schedule.name === "nightly-images").map((schedule) => schedule.cron),
    ["0 3 * * *"],
  );
  const started = () => harness.inspection.logEntries.filter((entry) => entry.message.startsWith("Rebuilding the standard images that are due")).length;
  await harness.runSchedule("nightly-images");
  assert.equal(started(), 0, "off unless set");
  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, general: { ...rest.general, nightlyImages: true } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  await harness.runSchedule("nightly-images");
  assert.equal(started(), 1);
});

test("a box BB could not add as a machine says why, after BB removes the machine (the newcomer check: bb connect without a sign-in)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.bootstrapError = "Sign in to your bb account to use bb connect";

  const acquired = tool("box_acquire", { kind: "linux" });
  const box = await until("BB to give up on the machine", async () => {
    const [current] = await app.boxes.list(THREAD);
    return current && world.hosts.get(`host-${current.id}`)?.lifecycle.phase === "destroyed" ? current : null;
  });
  // As BB does then: it removes the machine through bb-box's provider, and says it is deleted.
  const hostId = `host-${box.id}`;
  const host = world.hosts.get(hostId)!;
  await harness.inspection.registrations.machineProviders.get("bb-box")!.remove({ hostId, resource: { boxId: box.id } } as never);
  world.hosts.delete(hostId);
  await app.enrolment.forgetHost(host.id);

  const reason = `Enrolling box ${box.name} failed: Sign in to your bb account to use bb connect`;
  assert.match(text(await acquired), /BB machine: enrolment failed: .*Sign in to your bb account to use bb connect/);
  assert.deepEqual((await app.boxes.find(box.id))?.enrol, { state: "failed", hostId: null, error: reason });
});

test("the enrolment's log lists its steps in the order they started, with the access setup's parts", () => {
  const timeline = (marks: Record<string, number>) => {
    const phases = new Phases(1_000);
    for (const [step, at] of Object.entries(marks)) phases.mark(step, 1_000 + at);
    return phases.line("b");
  };
  // BB answers the request after it calls create; the access setup runs alongside the installer.
  const marks = { called: 20, prepared: 20, install: 40, requested: 100, access: 110, names: 500, env: 800, accessed: 3_730, installed: 5_020, bootstrapped: 5_050, connected: 5_150 };
  assert.equal(
    timeline({ ...marks, enrolled: 5_150 }),
    "Enrolled box b 5.15 s after it was ready: asking BB 0.10 s alongside, BB calling bb-box's create 0.02 s, reaching the box 0.00 s, " +
      "BB preparing the enrolment 0.02 s, BB's installer in the box 4.98 s, setting up the thread's access 3.62 s alongside " +
      "(fetching the variable names 0.39 s, reaching the box and back 0.30 s, running the script 2.93 s), " +
      "BB waiting for the daemon 0.03 s, BB showing the machine connected 0.10 s, finishing 0.00 s.",
  );
  // An access setup that ends after the machine connects is waited for; without the script's own time, its parts are left out.
  const { env: _, ...untimed } = marks;
  assert.match(
    timeline({ ...untimed, accessed: 5_650, enrolled: 5_660 }),
    /^Enrolled box b 5\.66 s after .*, setting up the thread's access 5\.54 s alongside, BB waiting .*, BB showing the machine connected 0\.10 s, waiting for the access setup 0\.50 s, finishing 0\.01 s\.$/,
  );
});

test("an enrolment followed again after a restart is timed from then, not from when the box was ready", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);
  // As if bb-box restarted while BB installed its daemon, an hour after the box was ready.
  const hostId = `host-${box.id}`;
  const host = makeHostResponse({ id: hostId, status: "connected", machineProviderId: "bb-box" });
  world.hosts.set(hostId, { ...host, lifecycle: { ...host.lifecycle, phase: "active" } });
  await app.boxes.update(box, () => ({ readyAt: box.readyAt! - 3_600_000, enrol: { state: "enrolling", hostId, error: null } }));
  await app.enrolment.resume();
  const enrolled = await until("enrolment", async () => {
    const current = await app.boxes.find(box.id);
    return current?.enrol.state === "enrolled" ? current : null;
  });
  assert.equal(enrolled.timings.enrol, undefined, "the box shows no enrolment time");
  const logged = harness.inspection.logEntries.map((entry) => entry.message).find((line) => line.startsWith(`Enrolled box ${box.name} `));
  assert.match(logged ?? "", new RegExp(`^Enrolled box ${box.name} [0-4]\\.\\d\\d s after bb-box resumed following it: `));
});

test("a stopped box starts again and BB's daemon is started with the same key", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  assert.match(text(await tool("box_stop", { box: box.name })), /is stopped/);
  const refused = await tool("box_run", { box: box.name, command: "true" });
  assert.ok(isError(refused));
  assert.match(text(refused), /Next: Call box_status to see its state. box_start starts a stopped box./);
  assert.match(text(await tool("box_start", { box: box.name })), /State: ready/);
  await until("reconnect", async () => world.bootstraps.length === 2);
  assert.deepEqual(world.bootstraps, [box.id, box.id]);
});

test("on a Mac that booted, BB's daemon loaded at login is unloaded and the bootstrap runs again, so the reconnect works (#416)", async (t) => {
  // A launchctl that keeps whether the job is loaded in a file in the box's home.
  const bin = tempDir("launchctl");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$*" >> "$HOME/launchctl.log"\ncase "$1" in print) [ -f "$HOME/loaded" ] ;; bootout) rm -f "$HOME/loaded" ;; esac\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const macos: BoxKind = { ...FAKE_KINDS[0]!, id: "macos", label: "macOS", capabilities: { ...FAKE_KINDS[0]!.capabilities, os: "macos", features: [] } };
  const { harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [macos] });
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", { kind: "macos" });
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  // BB's installer, as on a Mac: launchctl bootstrap fails while the job is loaded.
  world.installer = `mkdir -p Library/LaunchAgents && : > Library/LaunchAgents/app.getbb.host-daemon.srv-host-${box.id}.plist && : > Library/LaunchAgents/app.getbb.host-daemon.srv-host-other.plist; if [ -f loaded ]; then echo 'Bootstrap failed: 5: Input/output error'; exit 1; fi; : > loaded`;
  // launchd loads it at login after the boot.
  await tool("box_run", { box: box.name, command: ": > loaded" });
  assert.match(text(await tool("box_stop", { box: box.name })), /is stopped/);
  assert.match(text(await tool("box_start", { box: box.name })), /State: ready/);
  await until("the bootstrap again", async () => world.bootstraps.length === 3);
  const log = text(await tool("box_run", { box: box.name, command: "cat launchctl.log" }));
  assert.match(log, new RegExp(`print gui/\\d+/app\\.getbb\\.host-daemon\\.srv-host-${box.id}\\nbootout gui/\\d+/app\\.getbb\\.host-daemon\\.srv-host-${box.id}\\nprint`));
  assert.doesNotMatch(log, /host-other/, "another machine's daemon is left alone");
  const after = (await app.boxes.find(box.id))!;
  assert.equal(after.enrol.state, "enrolled");
  assert.equal(after.enrol.error, null);
  assert.deepEqual(world.bootstraps, [box.id, box.id, box.id]);
});

test("the sweep starts BB's daemon again in a ready box that BB shows disconnected", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  await app.enrolment.sweep();
  assert.deepEqual(world.bootstraps, [box.id], "a connected machine is left alone");

  // The box rebooted without bb-box: BB's daemon is not running.
  const hostId = `host-${box.id}`;
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await app.enrolment.sweep();
  assert.deepEqual(world.bootstraps, [box.id, box.id], "bootstrapped again with the box ID");

  // BB no longer has the machine: the box is no longer enrolled.
  world.hosts.delete(hostId);
  await app.enrolment.sweep();
  assert.equal((await app.boxes.find(box.id))?.enrol.state, "off");
  assert.equal(world.bootstraps.length, 2);
});

test("a kind keeps a spare box as a BB machine, which box_acquire claims, renames and reconnects, and another takes its place (032)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  const hostId = `host-${spare.id}`;
  await until("its machine", async () => world.hosts.get(hostId)?.lifecycle.phase === "active");
  assert.equal(world.hosts.get(hostId)?.name, `${spare.name} (spare)`);
  assert.doesNotMatch(text(await tool("box_list", {})), new RegExp(spare.name));

  // The panel and the settings page show it as ready (#121).
  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { kinds: { id: string; spares: unknown }[] };
  assert.deepEqual(state.kinds.find((kind) => kind.id === "linux")!.spares, { target: 1, ready: 1, making: 0 });
  const config = (await harness.behavior.callRpc("config.get", null)) as { kinds: { id: string; spares: unknown }[] };
  assert.deepEqual(config.kinds.find((kind) => kind.id === "linux")!.spares, { ready: 1, making: 0 });

  // A thread runs on the spare's machine, so an acquire leaves it.
  world.onHost.set(hostId, [{ id: "thr_picker", title: null, status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const other = text(await tool("box_acquire", { kind: "linux" }));
  assert.doesNotMatch(other, new RegExp(spare.name));
  await tool("box_release", { box: (await only(app)).name });
  // An archived thread does not hold it (036).
  world.onHost.set(hostId, [{ id: "thr_picker", title: null, status: "idle", hasPendingInteraction: false, archivedAt: 1, deletedAt: null }]);

  // BB shows the spare's machine disconnected, as after the box rebooted.
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  const bootstraps = world.bootstraps.length;
  const acquired = text(await tool("box_acquire", { kind: "linux" }));
  assert.match(acquired, new RegExp(`\\b${spare.name}\\b`));
  assert.match(acquired, /BB machine: enrolled/);
  assert.match(acquired, /Timings: claiming a spare \d+(?: ms|\.\d s), total \d+(?: ms|\.\d s)/);
  const box = await only(app);
  assert.equal(box.id, spare.id);
  assert.equal(world.hosts.get(hostId)?.name, box.name);
  assert.equal(text(await tool("box_run", { box: box.name, command: "echo claimed" })).match(/stdout:\n(\w+)/)?.[1], "claimed");
  assert.deepEqual(world.bootstraps.slice(bootstraps).filter((key) => key === box.id), [box.id], "the claim started BB's daemon again, with the box ID");
  assert.equal(world.hosts.get(hostId)?.status, "connected");

  const next = await until("another spare", async () => (await app.boxes.list(SPARES)).find((spare) => spare.enrol.state === "enrolled"));
  assert.notEqual(next.id, box.id);
  await until("its machine", async () => world.hosts.get(`host-${next.id}`)?.name === `${next.name} (spare)`);
});

test("where a stop keeps a box's session, a spare waits stopped as a BB machine, which a claim starts and then renames, and another takes its place (#539)", async (t) => {
  const { harness, app, world, tool } = await start(undefined, { keepsSession: (kind) => kind === "linux" });
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  const waiting = async (not?: string) => (await app.boxes.list(SPARES)).find((box) => box.id !== not && box.state === "stopped" && box.enrol.state === "enrolled");
  const spare = await until("a spare waiting stopped", () => waiting());
  const hostId = `host-${spare.id}`;
  // Its machine's name says it waits stopped, as BB shows the machine offline meanwhile.
  await until("its machine named as a stopped spare", async () => world.hosts.get(hostId)?.name === `${spare.name} (spare, stopped)`);
  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { kinds: { id: string; spares: unknown; offers: { ready: number; spareStarts?: boolean }[] }[] };
  const linux = state.kinds.find((kind) => kind.id === "linux")!;
  assert.deepEqual(linux.spares, { target: 1, ready: 1, making: 0 }, "it counts as ready");
  // The form says the spare is ready in seconds rather than now, as a claim resumes it first.
  assert.deepEqual(linux.offers.map((offer) => [offer.ready, offer.spareStarts]), [[1, true]]);

  // BB shows its machine disconnected while it waits, and the upkeep keeps it.
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await app.boxes.keepSpares();
  assert.equal((await app.boxes.list(SPARES)).find((box) => box.id === spare.id)?.state, "stopped");

  const relabels = world.backend!.relabels.length;
  // Its resume takes a moment, which the claim's time counts.
  world.backend!.powerGate = new Promise((resolve) => setTimeout(resolve, 300));
  const acquired = text(await tool("box_acquire", { kind: "linux" }));
  world.backend!.powerGate = null;
  assert.match(acquired, new RegExp(`\\b${spare.name}\\b`));
  assert.match(acquired, /State: ready/);
  assert.match(acquired, /BB machine: enrolled/);
  assert.match(acquired, /\nTimings: claiming a spare \d+ ms, resuming it [\d.]+ (ms|s), total [\d.]+ (ms|s)/);
  const box = await only(app);
  assert.equal(box.id, spare.id);
  const { spare: claim = 0, spareResume = 0, total = 0, spareReconnect = 0 } = box.timings;
  assert.ok(spareResume >= 250, `the resume, ${spareResume} ms`);
  assert.equal(total, claim + spareResume, "the claim's total counts the resume");
  // Until BB shows its machine connected with the thread's access, from the claim, as a step of its own after the total.
  assert.match(acquired, /, total [\d.]+ (ms|s)(, naming it for its owner [\d.]+ (ms|s))?, BB machine reconnecting [\d.]+ (ms|s)/);
  assert.ok(spareReconnect >= spareResume, `the reconnect, ${spareReconnect} ms, from the claim`);
  await until("the rename", async () => world.hosts.get(hostId)?.name === box.name);
  await until("the start to reconnect its machine", async () => world.hosts.get(hostId)?.status === "connected");
  assert.deepEqual(world.backend!.relabelPowers.slice(relabels), ["running"], "relabelled once it had started");
  assert.equal(text(await tool("box_run", { box: box.name, command: "echo claimed" })).match(/stdout:\n(\w+)/)?.[1], "claimed");

  await until("another spare waiting stopped", () => waiting(box.id));
});

test("a Windows kind keeps its spare as a manual machine enrolled ahead, which a claim renames and a release removes, and New box refuses Windows by name (#539)", async (t) => {
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, enrol: true } };
  const shell = join(tempDir("windows-shell"), "pwsh");
  writeFileSync(shell, `#!/bin/sh\ncase "$2" in *Schedule.Service*) exit 0 ;; *"]::Daemon("*) exit ${ACCESS_CHECK_EXITS.noDaemon} ;; esac\nexit 1\n`);
  chmodSync(shell, 0o755);
  const { bb, harness, app, world, tool } = await start({ "fake-enabled": true }, { kinds: [kind], shell });
  t.after(() => harness.lifecycle.dispose());
  world.windowsConnects = true;

  const provider = harness.inspection.registrations.machineProviders.get("bb-box-new")!;
  const refused = (await provider.validate!({ inputs: { kind: "windows" } } as never)) as { action: string; message: string };
  assert.equal(refused.action, "refuse");
  assert.match(refused.message, /^A thread cannot start on a new Windows box: BB adds a new box's machine with its installer for Linux and macOS only\./);

  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { windows: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  const hostId = `host-${spare.id}`;
  assert.ok(world.events.includes(`create manual ${hostId}`), world.events.join("\n"));
  assert.equal(world.hosts.get(hostId)?.name, `${spare.name} (spare)`, "named as a spare once it connects");
  assert.deepEqual(await bb.storage.kv.list("manual-machine/"), [`manual-machine/${hostId}`]);

  const acquired = text(await tool("box_acquire", { kind: "windows" }));
  assert.match(acquired, new RegExp(`\\b${spare.name}\\b`));
  assert.match(acquired, /BB machine: enrolled/);
  assert.match(acquired, /Timings: claiming a spare/);
  const box = await only(app);
  assert.equal(box.id, spare.id);
  await until("the rename", async () => world.hosts.get(hostId)?.name === box.name);
  assert.equal(world.hosts.get(hostId)?.status, "connected");

  assert.ok(!isError(await tool("box_release", { box: box.name })));
  assert.equal(world.hosts.has(hostId), false);
  assert.ok(!(await bb.storage.kv.list("manual-machine/")).includes(`manual-machine/${hostId}`));
});

test("an enrolment BB refuses for not knowing bb-box's machine provider, as while the plugin restarts, asks again and enrols (#285)", async (t) => {
  const { harness, app, world, tool } = await start(undefined, { providerRetryMs: 20 });
  t.after(() => harness.lifecycle.dispose());
  world.unknownProvider = 2;

  assert.match(text(await tool("box_acquire", {})), /BB machine: enrolled/);
  const box = await only(app);
  assert.equal(world.events.filter((event) => event === `create host-${box.id}`).length, 3);
  const messages = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(messages.includes(`Enrolling box ${box.name}: BB does not know bb-box's machine provider yet, as while the plugin restarts. Asking again in 0.02 s, 5 more times at most.`), messages.join("\n"));

  // BB that never knows it: six tries, then the box says why it is not a BB machine.
  world.unknownProvider = 100;
  await tool("box_acquire", {}, "thr_two");
  const [other] = await app.boxes.list("thr_two");
  await until("the enrolment to give up", async () => (await app.boxes.find(other!.id))?.enrol.state === "failed");
  assert.match((await app.boxes.find(other!.id))?.enrol.error ?? "", /Unknown machine provider "bb-box"/);
  assert.equal(world.events.filter((event) => event === `create host-${other!.id}`).length, 6);
});

test("when BB removes a box's machine, the box is no longer enrolled", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const host = world.hosts.get(`host-${box.id}`)!;
  world.hosts.delete(host.id);
  await harness.behavior.emitThreadEvent("experimental_host.deleted", { host });
  await until("the host to be forgotten", async () => (await app.boxes.find(box.id))?.enrol.state === "off");
  assert.equal((await only(app)).state, "ready", "the box stays");
});

test("box_thread starts a child thread on a box's BB machine, with the thread's project (#55)", async (t) => {
  const { harness, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: { name: string; enrol: { hostId: string } }[] };
  const name = box.boxes[0]!.name;

  const started = text(await tool("box_thread", { box: name, prompt: "Run uname -a" }));
  assert.match(started, new RegExp(`^Started thread thr_child1 on box ${name}\\.`));
  const [args] = world.spawned as Record<string, unknown>[];
  assert.deepEqual(args, {
    projectId: PROJECT,
    lifecycleOwnerThreadId: THREAD,
    environment: { type: "host", hostId: box.boxes[0]!.enrol.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    prompt: "Run uname -a",
    title: `On box ${name}`,
    providerId: "claude-code",
    model: "claude-opus-5-5",
    origin: "plugin",
    originPluginId: "bb-box",
  });

  assert.deepEqual(world.sources, [{ hostId: box.boxes[0]!.enrol.hostId, type: "clone" }], "the first thread clones the project onto the box");

  const panel = (await harness.behavior.callRpc("thread", { threadId: THREAD, box: name, prompt: "Again" })) as { threadId: string; error: null };
  assert.deepEqual(panel, { threadId: "thr_child2", error: null });
  const cli = await harness.behavior.runCli(["thread", name, "--prompt", "Once more", "--thread", THREAD]);
  assert.equal(cli.stdout, `Started thread thr_child3 on box ${name}.\n`);
  assert.equal(world.sources.length, 1, "later threads use the same clone");
});

test("box_thread starts the child on its parent's provider and model when the box has them, a CLI the box has otherwise, and refuses a box with no agent CLI (#561)", async (t) => {
  const { harness, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const { boxes } = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: { name: string }[] };
  const name = boxes[0]!.name;
  const agent = async () => {
    const started = await tool("box_thread", { box: name, prompt: "Run uname -a" });
    assert.ok(!isError(started), text(started));
    const { providerId, model } = world.spawned.at(-1) as { providerId?: string; model?: string };
    return { providerId, model };
  };

  // The box's CLI does not list the parent's model: that CLI's default.
  world.parentModel = "claude-opus-4-1";
  assert.deepEqual(await agent(), { providerId: "claude-code", model: undefined });
  // The box lacks the parent's CLI: the first it has, in BB's order, with its default model, not BB's default, which the box may lack too (#47).
  world.agentClis!["claude-code"] = { ...world.agentClis!["claude-code"]!, installed: false };
  assert.deepEqual(await agent(), { providerId: "codex", model: undefined });
  // The parent's provider unknown, as BB cannot read the thread: the first CLI the box has, though the parent's is there too.
  const listed = world.agentClis!;
  world.agentClis = { codex: listed.codex!, "claude-code": { ...listed["claude-code"]!, installed: true } };
  world.threadErrors.set(THREAD, new Error("thread not readable"));
  assert.deepEqual(await agent(), { providerId: "codex", model: undefined });
  world.threadErrors.delete(THREAD);
  world.agentClis = listed;
  // BB cannot say which CLIs the box has: BB's default.
  const clis = world.agentClis;
  world.agentClis = null;
  assert.deepEqual(await agent(), { providerId: undefined, model: undefined });

  // None of BB's CLIs: refused before anything is started.
  world.agentClis = Object.fromEntries(Object.entries(clis!).map(([id, cli]) => [id, { ...cli, installed: false }]));
  const spawned = world.spawned.length;
  const refused = await tool("box_thread", { box: name, prompt: "Run uname -a" });
  assert.ok(isError(refused));
  assert.match(
    text(refused),
    new RegExp(`^A thread cannot run on box ${name}: it has none of the agent CLIs BB runs threads with: Claude Code \\(claude\\), Codex \\(codex\\), Cursor \\(cursor-agent\\)\\. Install one there, then start the thread again\\.`),
  );
  assert.equal(world.spawned.length, spawned);
});

test("in BB's personal project, a thread on a box takes a personal workspace there, with no clone (#55)", async (t) => {
  const { harness, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.projectKind = "personal";
  await tool("box_acquire", {});
  const { boxes } = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: { name: string; enrol: { hostId: string } }[] };
  const started = text(await tool("box_thread", { box: boxes[0]!.name, prompt: "Run uname -a" }));
  assert.match(started, /^Started thread thr_child1 on box /);
  const [args] = world.spawned as { environment: { hostId: string }; parentThreadId?: string }[];
  assert.equal(args!.environment.hostId, boxes[0]!.enrol.hostId, "the child's machine is the box's");
  assert.deepEqual(args!.environment, { type: "host", hostId: boxes[0]!.enrol.hostId, workspace: { type: "personal" } });
  // Spawned with a parent, BB would give it the parent's environment; it is linked afterwards.
  assert.equal(args!.parentThreadId, undefined);
  assert.deepEqual(world.updated, [{ threadId: "thr_child1", parentThreadId: THREAD }]);
  assert.deepEqual(world.sources, [], "nothing is cloned");
});

test("a box a thread is working on is not released or stopped unless forced, and an idle thread does not stop it", async (t) => {
  const { harness, app, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await app.boxes.enrolled(await only(app));
  const thread = (id: string, title: string, status: string, others: { archivedAt?: number; hasPendingInteraction?: boolean } = {}) => ({
    id,
    title,
    status,
    hasPendingInteraction: false,
    archivedAt: null,
    deletedAt: null,
    ...others,
  });
  world.onHost.set(box.enrol.hostId!, [thread("thr_worker", "Build the app", "active"), thread("thr_done", "Tests", "idle"), thread("thr_old", "Old", "idle", { archivedAt: 1 })]);

  for (const [name, action] of [["box_release", "Releasing"], ["box_stop", "Stopping"]] as const) {
    const refused = await tool(name, { box: box.name });
    assert.ok(isError(refused), name);
    assert.match(text(refused), new RegExp(`^${action} box ${box.name} would end the work of thread "Build the app" \\(thr_worker\\), which is working on it\\. Wait until it is done\\.`));
  }
  const panel = (await harness.behavior.callRpc("release", { threadId: THREAD, box: box.name })) as { box: { state: string }; threads: unknown[] };
  assert.equal(panel.box.state, "ready", "the panel's release leaves it for the user to confirm");
  assert.deepEqual(panel.threads, [{ id: "thr_worker", title: "Build the app", running: true }]);
  const cli = await harness.behavior.runCli(["release", box.name, "--thread", THREAD]);
  assert.equal(cli.exitCode, 1);

  // A thread waiting on a question to the user is working too.
  world.onHost.set(box.enrol.hostId!, [thread("thr_asking", "Asks", "idle", { hasPendingInteraction: true }), thread("thr_done", "Tests", "idle")]);
  assert.ok(isError(await tool("box_stop", { box: box.name })));

  // Once it has finished, the box goes, and the answer says which threads lost their machine.
  world.onHost.set(box.enrol.hostId!, [thread("thr_done", "Tests", "idle")]);
  const released = text(await tool("box_release", { box: box.name }));
  assert.match(released, new RegExp(`^Released box ${box.name}\\. Thread "Tests" \\(thr_done\\), idle on it, lost its machine\\. Archive it if it is done\\.`));
  assert.deepEqual(await app.boxes.list(THREAD), []);
});

test("the panel and the CLI release a box with only idle threads at once, and force a working one", async (t) => {
  const { harness, app, tool, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  await tool("box_acquire", {});
  const [first, second] = await Promise.all((await app.boxes.list(THREAD)).map((box) => app.boxes.enrolled(box)));
  const idle = { id: "thr_done", title: "Tests", status: "idle", hasPendingInteraction: false, archivedAt: null, deletedAt: null };
  world.onHost.set(first!.enrol.hostId!, [idle]);
  world.onHost.set(second!.enrol.hostId!, [{ ...idle, id: "thr_worker", status: "active" }]);

  assert.deepEqual(await harness.behavior.callRpc("release", { threadId: THREAD, box: first!.name }), { box: null, error: null });
  const cli = await harness.behavior.runCli(["release", second!.name, "--thread", THREAD, "--force"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.deepEqual(await app.boxes.list(THREAD), []);
});
test("bb box machines --help names its add, resize and remove commands, not the list alone", async (t) => {
  const { harness } = await start();
  t.after(() => harness.lifecycle.dispose());
  const help = await harness.behavior.runCli(["machines", "--help"]);
  const words = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  for (const command of ["bb box machines add <kind>", "bb box machines resize <machine>", "bb box machines remove <machine>"]) assert.ok(words.includes(command), words);
});

test("a box made before its kind's boxes joined BB stays a box only, and box_status and box_thread say so (#539)", async (t) => {
  // A Windows kind whose boxes do not join BB, then do, as when the switch comes on.
  const { harness, app, tool, world } = await start({ "fake-enabled": true }, { kinds: [FAKE_WINDOWS_KIND] });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", { kind: "windows" });
  const box = await only(app);
  assert.equal(box.enrol.state, "off");
  await app.boxes.update(box, (current) => ({ capabilities: { ...current.capabilities, enrol: true } }));

  assert.match(
    text(await tool("box_status", { box: box.name })),
    /BB machine: not enrolled: it was made while boxes of its kind did not join BB, and stays so until it is released\. A new one joins BB when bb-box enrols boxes/,
  );
  const refused = await tool("box_thread", { box: box.name, prompt: "Run Get-Date" });
  assert.ok(isError(refused));
  assert.match(text(refused), new RegExp(`^A thread cannot run on box ${box.name}: it was made before Windows boxes joined BB, and stays a box only until it is released\\. Acquire another windows box, which joins BB, for the thread\\.`));
  assert.deepEqual(world.spawned, []);
});

test("a box that is not a BB machine cannot run a thread, and says why (#55)", async (t) => {
  const { harness, tool, world } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const { boxes } = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: { name: string }[] };
  const refused = await tool("box_thread", { box: boxes[0]!.name, prompt: "Run uname -a" });
  assert.ok(isError(refused));
  assert.match(text(refused), /A thread cannot run on box \S+: it is not a BB machine\. Its kind does not enrol, or enrolment is off in bb-box's settings\./);
  assert.deepEqual(world.spawned, []);
});

/** BB's call of a machine provider's create: the key, inputs and steps it reports. */
function createContext(key: string, inputs: unknown) {
  const steps: string[] = [];
  const checkpoints: unknown[] = [];
  return {
    steps,
    checkpoints,
    context: {
      inputs,
      key,
      attempt: 1,
      checkpoint: async (resource: unknown) => void checkpoints.push(resource),
      report: { step: (step: string) => void steps.push(step), log: () => {} },
      signal: new AbortController().signal,
    } as never,
  };
}

test("New box: BB's new-thread screen makes a box that is the thread's own machine, and removes it with the thread (033)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "boxes-per-thread": 1 });
  t.after(() => harness.lifecycle.dispose());
  const provider = harness.inspection.registrations.machineProviders.get("bb-box-new")!;
  assert.ok(provider, "the provider is registered");
  assert.equal(provider.ephemeral, true);

  assert.deepEqual(await provider.validate!({ inputs: { kind: "linux" } } as never), { action: "accept" });
  assert.equal((await provider.validate!({ inputs: { kind: "macos" } } as never)).action, "refuse");

  const { context, steps, checkpoints } = createContext(THREAD, { kind: "linux", size: "medium" });
  const created = (await provider.create(context)) as { status: string; name: string; resource: { boxId: string } };
  assert.equal(created.status, "created", JSON.stringify(created));
  const [box] = await app.boxes.list(THREAD);
  assert.equal(box!.role, "machine");
  assert.deepEqual(box!.size, { cores: 4, memoryMiB: 8192, diskGiB: null });
  assert.deepEqual(created.resource, { boxId: box!.id });
  assert.deepEqual(checkpoints, [{ boxId: box!.id }]);
  assert.deepEqual(world.bootstraps, [THREAD], "BB's daemon joins under the thread's key, once");
  assert.deepEqual(box!.enrol, { state: "enrolled", hostId: `host-${THREAD}`, error: null });
  assert.deepEqual(steps, ["Making a box", `Installing BB in box ${box!.name}`]);
  assert.match(text(await tool("box_list", {})), /this thread's machine/);
  // It does not count against the per-thread limit of 1.
  assert.ok(!isError(await tool("box_acquire", {})));

  assert.deepEqual(await provider.remove({ resource: created.resource, hostId: `host-${THREAD}` } as never), { status: "removed" });
  assert.deepEqual((await app.boxes.list(THREAD)).map((each) => each.role), ["box"], "the thread's machine went");
});

/** Fails rather than hangs when `promise` does not settle in time. */
function within<T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms))]);
}

/** A "New box" box made for the thread as BB would, with BB owning its machine. */
async function newBox(harness: Awaited<ReturnType<typeof start>>["harness"], world: Awaited<ReturnType<typeof start>>["world"]) {
  const provider = harness.inspection.registrations.machineProviders.get("bb-box-new")!;
  const created = (await provider.create(createContext(THREAD, { kind: "linux" }).context)) as unknown as { resource: { boxId: string } };
  const hostId = `host-${THREAD}`;
  world.hosts.set(hostId, makeHostResponse({ id: hostId, status: "connected", machineProviderId: "bb-box-new" }));
  world.resources.set(hostId, created.resource);
  // BB's removal of the machine, started once, as BB's removeMachine does.
  let removing: Promise<unknown> | null = null;
  const removal = () => (removing ??= provider.remove({ resource: created.resource, hostId } as never));
  world.bbRemovals.set(hostId, removal);
  return { removal, hostId, boxId: created.resource.boxId };
}

test("New box: archiving the thread removes its box without waiting on itself (033)", async (t) => {
  const { harness, app, world } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const { removal, hostId } = await newBox(harness, world);
  assert.deepEqual(await within(removal(), "BB's removal"), { status: "removed" });
  assert.deepEqual(await app.boxes.list(THREAD), []);
  assert.ok(!world.events.includes(`delete ${hostId}`), "bb-box leaves BB's machine to BB");
});

test("New box: the sweep releases the box of a thread that ended, and BB's removal after it finds nothing left (033)", async (t) => {
  const { harness, app, world } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const { removal, hostId } = await newBox(harness, world);
  world.threads.delete(THREAD);
  await within(app.boxes.sweep(), "the sweep");
  assert.equal((await app.boxes.list(THREAD)).length, 1, "BB has said so at one sweep");
  await within(app.boxes.sweep(), "the next sweep");
  assert.deepEqual(await app.boxes.list(THREAD), []);
  assert.ok(!world.events.includes(`delete ${hostId}`), "bb-box leaves BB's machine to BB");
  assert.deepEqual(await within(removal(), "BB's removal"), { status: "removed" });
});

test("New box: after bb-box loses its storage, the sweep restores the thread's box as BB's machine for the thread, which does not enrol again (#127)", async (t) => {
  const { harness, bb, app, world } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  // Another thread's New box machine, which BB lists first, is not this box's.
  world.hosts.set("host-thr_other", makeHostResponse({ id: "host-thr_other", status: "connected", machineProviderId: "bb-box-new" }));
  world.resources.set("host-thr_other", { boxId: "bxother" });
  const { hostId, boxId } = await newBox(harness, world);
  for (const key of [...(await bb.storage.kv.list("box/")), ...(await bb.storage.kv.list("index/"))]) await bb.storage.kv.delete(key);

  assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes restored from their guests: 1/);
  const restored = await app.boxes.settled({ threadId: THREAD, id: boxId });
  assert.equal(restored?.role, "machine");
  assert.equal(restored?.projectId, PROJECT);
  assert.deepEqual(restored?.enrol, { state: "enrolled", hostId, error: null });
  assert.equal(restored?.restoredAt, null, "it is not waiting to enrol");
  assert.deepEqual(world.events, [], "bb-box makes no other machine for the box");
});

test("New box: a retry makes a new box rather than reuse one that failed (033)", async (t) => {
  const { harness, app } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const provider = harness.inspection.registrations.machineProviders.get("bb-box-new")!;
  const failed = await app.boxes.acquire({ threadId: THREAD, projectId: PROJECT, kind: "linux", role: "machine" });
  await app.boxes.settled(failed);
  await app.boxes.update((await app.boxes.find(failed.id))!, () => ({ state: "failed", error: "it did not start" }));
  const created = (await provider.create(createContext(THREAD, { kind: "linux" }).context)) as unknown as { status: string; resource: { boxId: string } };
  assert.equal(created.status, "created");
  assert.notEqual(created.resource.boxId, failed.id);
  assert.deepEqual((await app.boxes.list(THREAD)).map((box) => box.id), [created.resource.boxId], "the failed box was released");
});

test("New box: a create cut short is cleaned up, and a key that is no thread fails with a message (033)", async (t) => {
  const { harness, app } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const provider = harness.inspection.registrations.machineProviders.get("bb-box-new")!;

  const none = (await provider.create(createContext("thr_nope", { kind: "linux" }).context)) as { status: string; message: string };
  assert.equal(none.status, "failed");
  assert.match(none.message, /BB named none \(key thr_nope\)/);

  await app.boxes.acquire({ threadId: THREAD, projectId: PROJECT, kind: "linux", role: "machine" });
  assert.deepEqual(await provider.reconcileCleanup({ key: THREAD, report: { step: () => {}, log: () => {} }, signal: new AbortController().signal } as never), { status: "removed" });
  assert.deepEqual(await app.boxes.list(THREAD), []);
});

/** One of your machines added over RPC, waited for until it is a BB machine. */
async function addMachine(harness: Awaited<ReturnType<typeof start>>["harness"], app: Awaited<ReturnType<typeof start>>["app"], input: Record<string, unknown>) {
  const added = (await harness.behavior.callRpc("machines.add", input)) as { box: { id: string; name: string } | null; error: string | null };
  assert.equal(added.error, null);
  const box = (await app.boxes.find(added.box!.id))!;
  return app.boxes.enrolled((await app.boxes.settled(box)) ?? box);
}

test("your machines: added in settings under a name, BB machines whatever the enrolment setting, and kept by the sweep (036)", async (t) => {
  const { harness, app, world } = await start({ "fake-enabled": true, "enrol-boxes": false, "boxes-per-thread": 1 });
  t.after(() => harness.lifecycle.dispose());
  const box = await addMachine(harness, app, { kind: "linux", name: "build-1" });
  assert.equal(box.threadId, OPERATOR);
  assert.equal(box.projectId, null);
  assert.equal(box.enrol.state, "enrolled", "it enrols although enrolment is off");
  assert.equal(world.hosts.get(box.enrol.hostId!)?.name, "build-1");

  const taken = (await harness.behavior.callRpc("machines.add", { kind: "linux", name: "build-1" })) as { error: string };
  assert.equal(taken.error, "There is a machine called build-1 already.", "the words the settings form shows under the field");
  const bad = (await harness.behavior.callRpc("machines.add", { kind: "linux", name: "Build_1" })) as { error: string };
  assert.match(bad.error, /"Build_1" is not one\./);
  const named = await addMachine(harness, app, { kind: "linux" });
  assert.match(named.name, /^[a-z]+-[a-z]+$/, "bb-box picks a name");

  // No thread exists, and BB says so: the sweep keeps them all.
  world.threads.clear();
  await app.boxes.sweep();
  const listed = (await harness.behavior.callRpc("machines.list", null)) as { machines: { box: { name: string }; threads: unknown[] }[]; kinds: { id: string }[] };
  assert.deepEqual(listed.machines.map((entry) => [entry.box.name, entry.threads.length]), [["build-1", 0], [named.name, 0]]);
  assert.ok(listed.kinds.some((kind) => kind.id === "linux"));
});

test("your machines: removed in settings or in BB, without either waiting on the other (036)", async (t) => {
  const { harness, app, world } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const provider = harness.inspection.registrations.machineProviders.get("bb-box")!;
  const bbOwned = (box: { id: string; enrol: { hostId: string | null } }) => {
    let removing: Promise<unknown> | null = null;
    const removal = () => (removing ??= provider.remove({ resource: { boxId: box.id }, hostId: box.enrol.hostId } as never));
    world.bbRemovals.set(box.enrol.hostId!, removal);
    return removal;
  };

  // Removed in settings: the release deletes its BB machine, and BB's removal calls back.
  const first = await addMachine(harness, app, { kind: "linux", name: "first" });
  bbOwned(first);
  assert.deepEqual(await within(harness.behavior.callRpc("machines.remove", { box: "first" }), "removing in settings"), { box: null, error: null });
  assert.equal(await app.boxes.find(first.id), null);

  // Removed in BB: the box goes too.
  const second = await addMachine(harness, app, { kind: "linux", name: "second" });
  const removal = bbOwned(second);
  assert.deepEqual(await within(removal(), "BB's removal"), { status: "removed" });
  assert.equal(await app.boxes.find(second.id), null);

  const unjoined = await addMachine(harness, app, { kind: "linux", name: "unjoined" });
  await app.boxes.update(unjoined, (current) => ({ enrol: { state: "failed", hostId: current.enrol.hostId, error: "BB at http://127.0.0.1:38886 is not reachable from the box." } }));
  assert.deepEqual(await within(bbOwned(unjoined)(), "BB's removal of a machine that never joined"), { status: "removed" });
  const kept = await app.boxes.find(unjoined.id);
  assert.equal(kept?.state, "ready");
  assert.deepEqual(kept?.enrol, { state: "failed", hostId: null, error: "BB at http://127.0.0.1:38886 is not reachable from the box." });
});

test("your machines: removing or stopping one a thread is working on asks first (036)", async (t) => {
  const { harness, app, world } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const box = await addMachine(harness, app, { kind: "linux", name: "busy" });
  world.onHost.set(box.enrol.hostId!, [{ id: "thr_worker", title: "Build", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const listed = (await harness.behavior.callRpc("machines.list", null)) as { machines: { threads: unknown[] }[] };
  assert.deepEqual(listed.machines[0]!.threads, [{ id: "thr_worker", title: "Build", running: true }]);
  // A thread with no title yet goes by BB's fallback, the start of its prompt.
  world.onHost.set(box.enrol.hostId!, [
    { id: "thr_worker", title: "Build", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null },
    { id: "thr_new", title: null, titleFallback: "Run the tests", status: "idle", hasPendingInteraction: false, archivedAt: null, deletedAt: null } as never,
  ]);
  const fallback = (await harness.behavior.callRpc("machines.list", null)) as { machines: { threads: { title: string }[] }[] };
  assert.deepEqual(fallback.machines[0]!.threads.map((thread) => thread.title), ["Build", "Run the tests"]);
  for (const method of ["machines.remove", "machines.stop"]) {
    const asked = (await harness.behavior.callRpc(method, { box: "busy" })) as { box: { state: string }; threads: unknown[] };
    assert.equal(asked.box.state, "ready", method);
    assert.deepEqual(asked.threads, [{ id: "thr_worker", title: "Build", running: true }]);
  }
  const cli = await harness.behavior.runCli(["machines", "remove", "busy"]);
  assert.equal(cli.exitCode, 1);
  assert.deepEqual(await harness.behavior.callRpc("machines.remove", { box: "busy", force: true }), { box: null, error: null });
});

test("a spare a thread started on through BB's picker becomes yours, not another thread's, and a new spare is made (036)", async (t) => {
  const { harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  assert.ok(((await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean }).ok);
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  world.onHost.set(spare.enrol.hostId!, [{ id: "thr_picker", title: null, status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);

  await app.boxes.keepSpares();
  const [yours] = await app.boxes.list(OPERATOR);
  assert.equal(yours?.id, spare.id);
  assert.equal(yours?.name, spare.name);
  await until("its machine renamed", async () => world.hosts.get(spare.enrol.hostId!)?.name === spare.name);
  assert.ok(harness.inspection.logEntries.some((entry) => entry.message === `Spare box ${spare.name} is now yours: thread thr_picker started on it from BB's picker.`));
  await until("a new spare", async () => (await app.boxes.list(SPARES)).some((box) => box.id !== spare.id));
});

test("a thread that runs on one of your machines sees it in box_list, uses it with the box tools, and cannot release or stop it (036)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  const machine = await addMachine(harness, app, { kind: "linux", name: "build-1" });
  world.workspaceHost = machine.enrol.hostId!;

  const listed = text(await tool("box_list", {}));
  assert.match(listed, /^The machine this thread runs on:\n- build-1: Linux .*; yours\n\nThis thread has no boxes\./);
  assert.match(text(await tool("box_run", { box: "build-1", command: "echo on it" })), /stdout:\non it/);
  assert.match(text(await tool("box_status", { box: "build-1" })), /^Box build-1 /);
  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { runsOn: { box: { name: string }; owner: string } };
  assert.deepEqual([state.runsOn.box.name, state.runsOn.owner], ["build-1", "yours"]);

  for (const name of ["box_release", "box_stop"]) {
    const refused = await tool(name, { box: "build-1" });
    assert.ok(isError(refused), name);
    assert.match(text(refused), /^Box build-1 is your machine, which this thread runs on\. Remove or stop it in BB Box's settings\.\n\nNext: Keep using it with box_run/);
  }
  assert.equal((await app.boxes.find(machine.id))?.state, "ready");
});

/** A cgroup for box commands, as a container's shows its memory (061): `usedMiB` in use, `cacheMiB` of it file cache it can drop. */
function fakeCgroup(t: { after(fn: () => void): void }, usedMiB: number, cacheMiB = 0): void {
  const dir = tempDir("cgroup");
  writeFileSync(join(dir, "memory.current"), `${(usedMiB + cacheMiB) * 1048576}\n`);
  writeFileSync(join(dir, "memory.stat"), `anon ${usedMiB * 1048576}\ninactive_file ${cacheMiB * 1048576}\n`);
  const before = process.env.BBBOX_CGROUP;
  process.env.BBBOX_CGROUP = dir;
  t.after(() => {
    if (before === undefined) delete process.env.BBBOX_CGROUP;
    else process.env.BBBOX_CGROUP = before;
  });
}

test("box_resize resizes a box live where its backend can, says first what it would do with check, and records the resize (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const backend = world.backend!;
  assert.doesNotMatch(text(await tool("box_list", {})), /Resize:/, "a kind no offer resizes says nothing of it");
  backend.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  assert.match(text(await tool("box_list", {})), /- linux: Linux\. .* Resize: cores, memory and disk live, the disk only growing\. On: /);
  await tool("box_acquire", { kind: "linux", disk_gib: 20 });
  const box = await only(app);
  fakeCgroup(t, 1200, 2000);

  const checked = text(await tool("box_resize", { box: box.name, cores: 4, memory_gib: 8, disk_gib: 30, check: true }));
  assert.equal(
    checked,
    `Resizing box ${box.name} from 2 cores, 4 GiB memory, 20 GiB disk to 4 cores, 8 GiB memory, 30 GiB disk would change:\n` +
      "- live, while everything in it runs on: cores 2 to 4; memory 4 GiB to 8 GiB; disk 20 GiB to 30 GiB\n" +
      `Its host has room for it.\n\nNext: Call box_resize without check to make the change.`,
  );
  assert.equal(backend.resized.length, 0, "a check changes nothing");

  const grown = text(await tool("box_resize", { box: box.name, cores: 4, memory_gib: 8, disk_gib: 30 }));
  assert.match(grown, new RegExp(`^Resized box ${box.name} from 2 cores, 4 GiB memory, 20 GiB disk to 4 cores, 8 GiB memory, 30 GiB disk in \\d+ ms\\.\\nLive, with everything in it still running: cores 2 to 4; memory 4 GiB to 8 GiB; disk 20 GiB to 30 GiB\\.\\nNew cores can take up to 15 s to show in the box\\.`));
  assert.deepEqual(backend.resized.map((resize) => [resize.to, resize.restart]), [[{ cores: 4, memoryMiB: 8192, diskGiB: 30 }, false]]);
  const status = text(await tool("box_status", { box: box.name }));
  assert.match(status, /\nSize: 4 cores, 8 GiB memory, 30 GiB disk\n/);
  assert.match(status, /\nLast resize: to 4 cores, 8 GiB memory, 30 GiB disk, at \d{4}-\d\d-\d\d \d\d:\d\d UTC, done in /);
  const record = (await app.boxes.find(box.id))!;
  assert.deepEqual(record.size, { cores: 4, memoryMiB: 8192, diskGiB: 30 });
  assert.equal(record.resize?.state, "done");

  // A preset gives its cores and memory and leaves the disk; 1.2 GiB in use leaves room in 4 GiB.
  assert.match(text(await tool("box_resize", { box: box.name, size: "small" })), /^Resized box .* to 2 cores, 4 GiB memory, 30 GiB disk in /);
  assert.match(text(await tool("box_resize", { box: box.name, size: "small" })), /^Box .* is 2 cores, 4 GiB memory, 30 GiB disk already, so nothing changed\./);
  const smaller = await tool("box_resize", { box: box.name, disk_gib: 25 });
  assert.ok(isError(smaller));
  assert.match(text(smaller), /^A box's disk only grows, and this box's is 30 GiB, more than the 25 GiB asked for\./);
  assert.match(text(await tool("box_resize", { box: box.name, memory_gib: 1 })), /needs at least 2 GiB memory/);
  assert.match(text(await tool("box_resize", { box: box.name, cores: 64 })), /can be at most 16 cores, 32 GiB memory, 256 GiB disk/);
});

test("box_resize refuses a live shrink of memory below what the box uses, with a margin, and changes nothing (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  await tool("box_acquire", { kind: "linux", memory_gib: 8 });
  const box = await only(app);
  // 3.6 GiB in use, besides cache it can drop: 4 GiB leaves too little, and 5 GiB enough.
  fakeCgroup(t, 3700, 4000);
  // A check refuses it up front, as the panel's dialog asks one before Resize is pressed.
  const checked = await tool("box_resize", { box: box.name, memory_gib: 4, check: true });
  assert.ok(isError(checked));
  assert.match(text(checked), new RegExp(`^Box ${box.name} uses 3\\.6 GiB of memory now, so 4 GiB would leave less than 512 MiB free`));
  assert.match(text(await tool("box_resize", { box: box.name, memory_gib: 5, check: true })), /would change:\n- live, while everything in it runs on: memory 8 GiB to 5 GiB\n/);
  const refused = await tool("box_resize", { box: box.name, memory_gib: 4 });
  assert.ok(isError(refused));
  assert.match(
    text(refused),
    new RegExp(`^Box ${box.name} uses 3\\.6 GiB of memory now, so 4 GiB would leave less than 512 MiB free, and the kernel could end its processes\\. Give it at least 5 GiB, or free memory in it first\\. bb-box changed nothing\\.\\n\\nNext: Give the box at least the memory this names`),
  );
  assert.equal(world.backend!.resized.length, 0);
  assert.equal((await app.boxes.find(box.id))?.resize ?? null, null, "nothing was recorded");
  assert.match(text(await tool("box_resize", { box: box.name, memory_gib: 5 })), /^Resized box .* to 2 cores, 5 GiB memory in /);
});

test("box_resize makes a change that needs a restart only when asked, and never of the box the thread runs on, or while a person or a thread works on it (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const backend = world.backend!;
  backend.resizeWays = { cores: "restart", memory: "restart", disk: "live", shrinks: true };
  await tool("box_acquire", { kind: "linux" });
  const box = await only(app);

  const asked = await tool("box_resize", { box: box.name, cores: 4 });
  assert.ok(isError(asked));
  assert.match(
    text(asked),
    new RegExp(`^Resizing box ${box.name} to 4 cores, 4 GiB memory needs a restart for its cores: the box shuts down and starts again, for about 8 s, which ends everything running in it\\. bb-box changed nothing\\.\\n\\nNext: Call box_resize again with restart true`),
  );
  // The disk alone is live.
  assert.match(text(await tool("box_resize", { box: box.name, disk_gib: 40 })), /^Resized box .* to 2 cores, 4 GiB memory, 40 GiB disk in /);

  // A thread works on the box's machine.
  const thread = { id: "thr_worker", title: "Build the app", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null };
  world.onHost.set(box.enrol.hostId!, [thread]);
  const working = await tool("box_resize", { box: box.name, cores: 4, restart: true });
  assert.ok(isError(working));
  assert.match(text(working), /^Restarting box .* would end the work of thread "Build the app" \(thr_worker\), which is working on it\./);
  world.onHost.set(box.enrol.hostId!, [{ ...thread, status: "idle" }]);

  assert.match(text(await tool("box_resize", { box: box.name, disk_gib: 50 })), /^Resized box /);

  const restarted = text(await tool("box_resize", { box: box.name, cores: 4, restart: true }));
  assert.match(restarted, /^Resized box .* to 4 cores, 4 GiB memory, 50 GiB disk in .*\nWith a restart, which ended what was running in it: cores 2 to 4\./);
  assert.deepEqual(backend.resized.at(-1), { ref: box.guest!.ref, to: { cores: 4, memoryMiB: 4096, diskGiB: 50 }, restart: true });
  assert.match(text(await tool("box_status", { box: box.name })), /\nLast resize: to 4 cores, 4 GiB memory, 50 GiB disk, with a restart, at /);
});

test("an agent resizes the machine its thread runs on live, but not with a restart, which would end its own session (061)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "restart", disk: "live", shrinks: true };
  const machine = await addMachine(harness, app, { kind: "linux", name: "build-1" });
  world.workspaceHost = machine.enrol.hostId!;
  assert.match(text(await tool("box_resize", { box: "build-1", cores: 4 })), /^Resized box build-1 from 2 cores, 4 GiB memory to 4 cores, 4 GiB memory in /);
  const own = await tool("box_resize", { box: "build-1", memory_gib: 8, restart: true });
  assert.ok(isError(own));
  assert.match(
    text(own),
    /^Resizing box build-1 needs a restart, which would end this thread's session on it\. Ask the user to resize it with bb box machines resize build-1 --restart and the size, from a terminal elsewhere, which restarts it; the thread's session comes back once it is up\./,
  );
  assert.equal((await app.boxes.find(machine.id))?.size?.memoryMiB, 4096);
});

test("box_resize does not restart a desktop box while a person holds its control, but resizes it live (061)", async (t) => {
  const { harness, world, box, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "restart", disk: "live", shrinks: true };
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null };
  assert.equal(took.error, null);
  const refused = await tool("box_resize", { box: box.name, memory_gib: 12, restart: true });
  assert.ok(isError(refused));
  assert.match(text(refused), new RegExp(`^A person holds control of box ${box.name}'s desktop, and a restart would end what they are doing\\. Ask them to hand control back first\\.`));
  assert.match(text(await tool("box_resize", { box: box.name, cores: 6 })), /^Resized box .* to 6 cores, /);
});

test("bb box machines resize resizes one of your machines, checks first with --check, and restarts it only with --restart, and not while a thread works on it unless --force (061)", async (t) => {
  const { harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "restart", disk: "live", shrinks: true };
  const machine = await addMachine(harness, app, { kind: "linux", name: "build-1" });
  const checked = await harness.behavior.runCli(["machines", "resize", "build-1", "--cores", "4", "--memory-gib", "8", "--check"]);
  assert.equal(checked.exitCode ?? 0, 0);
  assert.match(String(checked.stdout), /would change:\n- live, while everything in it runs on: cores 2 to 4\n- with a restart of about 8 s, which ends everything running in it: memory 4 GiB to 8 GiB\n/);
  const asked = await harness.behavior.runCli(["machines", "resize", "build-1", "--cores", "4", "--memory-gib", "8"]);
  assert.equal(asked.exitCode, 1);
  assert.match(String(asked.stderr), /needs a restart for its memory/);
  world.onHost.set(machine.enrol.hostId!, [{ id: "thr_worker", title: "Build", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const busy = await harness.behavior.runCli(["machines", "resize", "build-1", "--memory-gib", "8", "--restart"]);
  assert.equal(busy.exitCode, 1);
  assert.match(String(busy.stderr), /Restarting box build-1 would end the work of thread "Build"/);
  const forced = await harness.behavior.runCli(["machines", "resize", "build-1", "--memory-gib", "8", "--restart", "--force"]);
  assert.equal(forced.exitCode ?? 0, 0, String(forced.stderr));
  assert.match(String(forced.stdout), /^Resized box build-1 from 2 cores, 4 GiB memory to 2 cores, 8 GiB memory in /);
  const thread = await harness.behavior.runCli(["resize", "nope", "--cores", "2"]);
  assert.equal(thread.exitCode, 1);
});

test("the panel's resize plans first, asks before a restart, names the threads working on the box until forced, and logs it as the panel's (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const backend = world.backend!;
  backend.resizeWays = { cores: "live", memory: "restart", disk: "live", shrinks: true };
  await tool("box_acquire", { kind: "linux", disk_gib: 20 });
  const box = await only(app);
  type Result = { box: { sizeNow: unknown; resizing: unknown; lastResize: { state: string; restart: boolean } | null } | null; plan: { parts: unknown[]; room: { ok: boolean }; downSeconds: number | null } | null; changed: boolean; needsRestart: boolean; threads?: { id: string }[]; presets: { name: string }[]; largest: { cores: number } | null; error: string | null };
  const resize = async (input: Record<string, unknown>) => (await harness.behavior.callRpc("resize", { threadId: THREAD, box: box.name, ...input })) as Result;

  // The box's view says what it has and what its backend changes, for the dialog.
  const opened = await resize({ check: true });
  assert.deepEqual(opened.box?.sizeNow, { cores: 2, memoryGiB: 4, diskGiB: 20, words: "2 cores, 4 GiB memory, 20 GiB disk" });
  assert.deepEqual(opened.box?.resizing, { cores: "live", memory: "restart", disk: "live", shrinks: true });
  assert.equal(opened.plan, null, "the size it has changes nothing");
  assert.deepEqual(opened.presets.map((preset) => preset.name), ["small", "medium", "large"]);
  assert.equal(opened.largest?.cores, 16);

  const planned = await resize({ size: { cores: 4, memoryGiB: 8, diskGiB: 30 }, check: true });
  assert.deepEqual(planned.plan?.parts, [
    { part: "cores", from: 2, to: 4, way: "live" },
    { part: "memory", from: 4, to: 8, way: "restart" },
    { part: "disk", from: 20, to: 30, way: "live" },
  ]);
  assert.equal(planned.plan?.room.ok, true);
  assert.equal(planned.plan?.downSeconds, 8);
  assert.equal(backend.resized.length, 0, "a check changes nothing");

  // Without the person's yes to a restart, nothing changes, and the answer says why.
  const asked = await resize({ size: { cores: 4, memoryGiB: 8 } });
  assert.equal(asked.needsRestart, true);
  assert.match(asked.error ?? "", /needs a restart for its memory/);
  assert.equal(backend.resized.length, 0);

  // A thread works on the box: the panel names it and asks again, then forces.
  world.onHost.set(box.enrol.hostId!, [{ id: "thr_worker", title: "Build", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const working = await resize({ size: { cores: 4, memoryGiB: 8 }, restart: true });
  assert.deepEqual(working.threads?.map((thread) => thread.id), ["thr_worker"]);
  assert.equal(working.error, null);
  assert.equal(backend.resized.length, 0);
  const forced = await resize({ size: { cores: 4, memoryGiB: 8 }, restart: true, force: true });
  assert.equal(forced.error, null);
  assert.equal(forced.changed, true);
  assert.deepEqual(forced.box?.lastResize && { state: forced.box.lastResize.state, restart: forced.box.lastResize.restart }, { state: "done", restart: true });
  assert.ok(harness.inspection.logEntries.some((entry) => new RegExp(`^Resized box ${box.name} .* to 4 cores, 8 GiB memory, 20 GiB disk, with a restart, as the panel asked, in \\d+ ms\\.$`).test(entry.message)));

  // Refusals come back in words, logged as the panel's.
  const smaller = await resize({ size: { diskGiB: 10 } });
  assert.match(smaller.error ?? "", /^A box's disk only grows/);
  assert.equal(smaller.needsRestart, false);
  assert.ok(harness.inspection.logEntries.some((entry) => entry.message.startsWith(`Refused to resize box ${box.name}`) && entry.message.includes("as the panel asked")));
  const missing = await resize({ box: "nope", check: true });
  assert.match(missing.error ?? "", /nope/);
});

test("the panel restarts a desktop box for a resize though a person holds its control: they are the one asking (061)", async (t) => {
  const { harness, world, box } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "restart", disk: "live", shrinks: true };
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  assert.equal(((await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null }).error, null);
  const done = (await harness.behavior.callRpc("resize", { threadId: THREAD, box: box.id, size: { memoryGiB: 12 }, restart: true })) as { changed: boolean; error: string | null };
  assert.deepEqual(done, { ...done, changed: true, error: null });
});

test("settings' Machines resizes one of your machines through machines.resize (061)", async (t) => {
  const { harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  const machine = await addMachine(harness, app, { kind: "linux", name: "build-1" });
  const done = (await harness.behavior.callRpc("machines.resize", { box: "build-1", size: { cores: 4 } })) as { changed: boolean; to: { cores: number }; error: string | null; box: { id: string } };
  assert.equal(done.error, null);
  assert.equal(done.changed, true);
  assert.equal(done.to.cores, 4);
  assert.equal(done.box.id, machine.id);
  assert.ok(harness.inspection.logEntries.some((entry) => entry.message.startsWith("Resized box build-1 ") && entry.message.includes("live, as the panel asked")));
});

test("after a live change of a BB machine's cores, box_resize says BB keeps the old count and how to set the thread limit, where it cannot restart BB's daemon there (061, BB request 28)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.backend!.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  await tool("box_acquire", { kind: "linux" });
  const box = await only(app);
  assert.equal(box.enrol.state, "enrolled");
  world.onHost.set(box.enrol.hostId!, [{ id: "thr_worker", title: "Build", status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const busy = text(await tool("box_resize", { box: box.name, cores: 4 }));
  assert.match(
    busy,
    new RegExp(
      `\\nBB still counts 2 processors on machine ${box.name}, and its automatic thread limit stays at 2, until BB's daemon there restarts, as it does when the box next starts\\. ` +
        `bb-box does not restart it while thread "Build" \\(thr_worker\\) works on the machine, as that would end its turn\\. ` +
        `To raise the limit now: bb concurrency-limit host ${box.name} 4, and then bb concurrency-limit host ${box.name} auto once BB counts the new cores\\.\\n\\nNext:`,
    ),
  );
  // An idle thread there, with a terminal of its own open, and then one of the machine's.
  world.onHost.set(box.enrol.hostId!, [{ id: "thr_worker", title: "Build", status: "idle", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  const session = { hostId: box.enrol.hostId!, command: "sh", status: "running" as const, createdAt: 1 };
  world.terminals.set("term_thread", { ...session, id: "term_thread", title: "Shell", threadId: "thr_worker" });
  world.terminals.set("term_machine", { ...session, id: "term_machine", title: "Shell" });
  assert.match(text(await tool("box_resize", { box: box.name, cores: 6 })), /\nBB still counts 4 processors .*\. bb-box does not restart it while 2 BB terminals are open on the machine, as that would end them\. To raise the limit now: bb concurrency-limit host .* 6,/);
  world.terminals.get("term_thread")!.status = "exited";
  assert.match(text(await tool("box_resize", { box: box.name, cores: 7 })), /bb-box does not restart it while a BB terminal is open on the machine, as that would end it\./);
  // No thread works there and no terminal is open, so bb-box tries the restart: a test's fake box has no daemon of BB's to restart.
  world.terminals.get("term_machine")!.status = "exited";
  const idle = text(await tool("box_resize", { box: box.name, cores: 8 }));
  assert.match(idle, /\nBB still counts 7 processors on machine .*, as it does when the box next starts\. To raise the limit now: bb concurrency-limit host .* 8,/);
  assert.doesNotMatch(idle, /does not restart it while/);
  assert.doesNotMatch(text(await tool("box_resize", { box: box.name, memory_gib: 6 })), /BB still counts/, "memory alone leaves the count alone");
});

test("box_resize refuses a size with no room, and a failed resize is recorded, with the box's size unchanged (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const backend = world.backend!;
  backend.resizeWays = { cores: "live", memory: "live", disk: "no", shrinks: true };
  await tool("box_acquire", { kind: "linux" });
  const box = await only(app);
  const disk = await tool("box_resize", { box: box.name, disk_gib: 40 });
  assert.match(text(disk), /^Fake host cannot change the disk of its linux boxes\. Resize: cores and memory live\./);

  backend.resizeRoom = { ok: false, message: "The host has 1 GiB of memory free, less than the 4 GiB more the box needs.", warm: null, hosts: [] };
  const full = await tool("box_resize", { box: box.name, memory_gib: 8 });
  assert.match(text(full), /^The host has 1 GiB of memory free, less than the 4 GiB more the box needs\.\n\nNext: Try again later/);
  backend.resizeRoom = { ok: true, message: null, warm: null, hosts: [] };

  backend.resizeFault = new Error("The provider said no.");
  const failed = await tool("box_resize", { box: box.name, memory_gib: 8 });
  assert.ok(isError(failed));
  assert.match(text(failed), /^Resizing the box failed: The provider said no\./);
  const record = (await app.boxes.find(box.id))!;
  assert.deepEqual([record.resize?.state, record.resize?.error, record.size?.memoryMiB], ["failed", "The provider said no.", 4096]);
  assert.match(text(await tool("box_status", { box: box.name })), /\nSize: 2 cores, 4 GiB memory\n[\s\S]*\nLast resize: to 2 cores, 8 GiB memory, at .* UTC, failed: The provider said no\./);
});

test("a resize bb-box restarted in the middle of ends at the next sweep with the size the guest says (061)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const backend = world.backend!;
  backend.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  await tool("box_acquire", { kind: "linux" });
  const box = await only(app);
  await tool("box_resize", { box: box.name, memory_gib: 6 });
  // As if bb-box stopped after recording a resize to 8 GiB: the guest still has 6 GiB.
  await app.boxes.update(box, (current) => ({ resize: { ...current.resize!, to: { cores: 2, memoryMiB: 8192, diskGiB: null }, state: "resizing", ms: null } }));
  await app.boxes.sweep();
  const record = (await app.boxes.find(box.id))!;
  assert.equal(record.resize?.state, "failed");
  assert.match(record.resize?.error ?? "", /^bb-box restarted before the resize finished/);
  assert.equal(record.guest?.size?.memoryMiB, 6144);
  assert.equal(record.size?.memoryMiB, 6144);
});

test("a thread found on a spare makes it yours at once, not at the next sweep (036)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  assert.ok(((await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean }).ok);
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  world.workspaceHost = spare.enrol.hostId!;
  world.onHost.set(spare.enrol.hostId!, [{ id: THREAD, title: null, status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  await tool("box_list", {});
  await until("yours", async () => (await app.boxes.find(spare.id))?.threadId === OPERATOR);
});

test("a spare is yours as soon as BB says a thread on its machine is working, not at the next upkeep (036, #155)", async (t) => {
  const { harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  assert.ok(((await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean }).ok);
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  await app.boxes.idle();
  world.workspaceHost = spare.enrol.hostId!;
  world.onHost.set(spare.enrol.hostId!, [{ id: "thr_picker", title: null, status: "active", hasPendingInteraction: false, archivedAt: null, deletedAt: null }]);
  // BB creates the thread before its environment, so its machine is not known yet.
  const created = makeThreadResponse({ id: "thr_picker", projectId: PROJECT, environmentId: null });
  world.threads.set("thr_picker", created);
  await harness.behavior.emitThreadEvent("thread.created", { thread: created });
  const working = makeThreadResponse({ id: "thr_picker", projectId: PROJECT, environmentId: "env_picker", status: "active" });
  world.threads.set("thr_picker", working);
  await harness.behavior.emitThreadEvent("thread.active", { thread: working });
  await until("yours", async () => (await app.boxes.find(spare.id))?.threadId === OPERATOR);
  await until("a new spare", async () => (await app.boxes.list(SPARES)).some((box) => box.id !== spare.id));
});

test("a spare a thread started on reads as becoming yours until it is, and is not released from the thread (036)", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  assert.ok(((await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { spares: 1 } } }, revision: rest.revision })) as { ok: boolean }).ok);
  const spare = await until("a spare", async () => (await app.boxes.list(SPARES)).find((box) => box.enrol.state === "enrolled"));
  world.workspaceHost = spare.enrol.hostId!;
  assert.match(text(await tool("box_list", {})), new RegExp(`^The machine this thread runs on:\\n- ${spare.name}: .*; a spare, which becomes your machine`));
  const refused = await tool("box_release", { box: spare.name });
  assert.ok(isError(refused));
  assert.match(text(refused), new RegExp(`^Box ${spare.name} is a spare, which becomes your machine, and this thread runs on it\\.`));
  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { runsOn: { owner: string } };
  assert.equal(state.runsOn.owner, "yours");
});

test("a box this thread runs on that belongs to another thread is named with that thread, and only that thread releases it (036)", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true });
  t.after(() => harness.lifecycle.dispose());
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT, environmentId: "env_two" }));
  const theirs = await app.boxes.enrolled((await app.boxes.settled(await app.boxes.acquire({ threadId: "thr_two", projectId: PROJECT, kind: "linux" }))) ?? (null as never));
  world.workspaceHost = theirs.enrol.hostId!;
  assert.match(text(await tool("box_list", {})), new RegExp(`^The machine this thread runs on:\\n- ${theirs.name}: .*; thread thr_two's`));
  const refused = await tool("box_release", { box: theirs.name });
  assert.match(text(refused), new RegExp(`Box ${theirs.name} is thread thr_two's, and this thread runs on it\\. Release it from that thread\\.`));
  // A box of its own still comes first in its lookups.
  assert.match(text(await tool("box_status", { box: "nope" })), /There is no box "nope"|not found|no box/i);
});

test("enrolment can be switched off", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  assert.equal((await only(app)).enrol.state, "off");
  assert.equal(world.hosts.size, 0);
});

test("archiving or deleting a thread releases its boxes, once BB says so when asked, and the log has BB's answer", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT }));

  await tool("box_acquire", {});
  await tool("box_acquire", {}, "thr_two");
  const archivedAt = Date.now();
  const archived = makeThreadResponse({ id: THREAD, projectId: PROJECT, archivedAt });
  const logs = () => harness.inspection.logEntries.map((entry) => entry.message);
  await harness.behavior.emitThreadEvent("thread.archived", { thread: archived });
  await until("the check with BB", async () => logs().includes(`Kept the boxes of thread ${THREAD}: BB said it was archived, but says now that it is live. BB's answer: archivedAt null, deletedAt null.`));
  assert.equal((await app.boxes.list(THREAD)).length, 1);
  world.threads.set(THREAD, archived);
  await harness.behavior.emitThreadEvent("thread.archived", { thread: archived });
  await until("the archived thread's box to go", async () => (await app.boxes.list(THREAD)).length === 0);
  const answer = `BB's answer: archivedAt ${new Date(archivedAt).toISOString()}, deletedAt null.`;
  assert.ok(logs().some((line) => line.startsWith("Releasing box ") && line.endsWith(` of thread ${THREAD}: its thread was archived. ${answer}`)));
  // BB finds no such thread: the box goes at the next sweep if BB still finds none.
  world.threads.delete("thr_two");
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_two" }) });
  const missing = `BB's answer: status 404, code thread_not_found, message "HTTP 404: Thread not found".`;
  await until("the check with BB", async () => logs().includes(`Kept the boxes of thread thr_two: BB said it was deleted, but finds no such thread now, and the next sweep releases them if BB still finds none. ${missing}`));
  assert.equal((await app.boxes.list("thr_two")).length, 1);
  await within(app.boxes.sweep(), "the sweep");
  assert.deepEqual(await app.boxes.list("thr_two"), []);
  await app.boxes.idle();
  assert.equal(world.hosts.size, 0, "their machines went too");
});

test("the sweep releases boxes of threads that are gone, but not when BB does not answer", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  world.threads.delete(THREAD);
  const answers: [string, Error][] = [
    ["a network error", new Error("connect ECONNREFUSED 127.0.0.1:3000")],
    ["a 404 from a route BB does not have yet", Object.assign(new Error("HTTP 404: Not Found"), { status: 404 })],
    ["another resource's not-found", Object.assign(new Error("HTTP 404: Plugin not found"), { status: 404, code: "plugin_not_found" })],
    ["a not-found that mentions the thread", Object.assign(new Error("HTTP 404: Not found: project of thread"), { status: 404, code: "not_found" })],
  ];
  for (const [what, error] of answers) {
    world.threadsError = error;
    assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes of ended threads released: 0/);
    assert.equal((await app.boxes.list(THREAD)).length, 1, `${what} does not end a thread`);
  }

  world.threadsError = null;
  const first = (await harness.behavior.runCli(["sweep"])).stdout ?? "";
  assert.match(first, /Boxes of ended threads released: 0/);
  assert.match(first, /Boxes and guests kept until the next sweep, as BB says their thread ended only now: 1/);
  assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes of ended threads released: 1/);
  assert.deepEqual(await app.boxes.list(THREAD), []);
});

test("after bb-box loses its storage, the sweep restores a live thread's box from its guest and leaves it running", async (t) => {
  const { harness, bb, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT }));
  world.threads.set("thr_three", makeThreadResponse({ id: "thr_three", projectId: PROJECT }));

  await tool("box_acquire", {});
  await tool("box_acquire", {}, "thr_two");
  await tool("box_acquire", {}, "thr_three");
  const [live] = await app.boxes.list(THREAD);
  const [ended] = await app.boxes.list("thr_two");
  const [unsure] = await app.boxes.list("thr_three");
  await tool("box_run", { box: live!.name, command: "echo kept > work.txt" });
  // The plugin's storage loses every box record; the guests keep running.
  for (const key of await bb.storage.kv.list("box/")) await bb.storage.kv.delete(key);
  for (const key of await bb.storage.kv.list("index/")) await bb.storage.kv.delete(key);
  const archivedAt = Date.now();
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT, archivedAt }));
  world.threads.set("thr_three", { ...makeThreadResponse({ id: "thr_three", projectId: PROJECT }), deletedAt: undefined } as unknown as Thread);
  world.threadErrors.set("thr_three", Object.assign(new Error("HTTP 404: Not Found"), { status: 404 }));

  const swept = (await harness.behavior.runCli(["sweep"])).stdout ?? "";
  assert.match(swept, /Boxes restored from their guests: 1/);
  assert.match(swept, /Leftover guests removed: 0/);
  assert.match(swept, /Guests kept until BB says whether their thread ended: 1/);
  assert.match(swept, /Boxes and guests kept until the next sweep, as BB says their thread ended only now: 1/);
  assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Leftover guests removed: 1/);

  const restored = (await app.boxes.list(THREAD))[0]!;
  assert.equal(restored.id, live!.id);
  assert.equal(restored.name, live!.name);
  assert.equal(restored.kind, live!.kind);
  assert.equal(restored.projectId, PROJECT);
  assert.equal(restored.state, "ready");
  assert.equal(restored.error, null);
  assert.deepEqual(restored.guest, live!.guest);
  // It is a BB machine again, keyed by its box ID: BB gives back the machine it still has.
  const enrolled = await until("enrolment", async () => {
    const current = await app.boxes.find(live!.id);
    return current?.enrol.state === "enrolled" ? current : null;
  });
  assert.equal(enrolled.enrol.hostId, `host-${live!.id}`);
  assert.equal(world.bootstraps.filter((key) => key === live!.id).length, 1, "its daemon was still connected");
  const result = await tool("box_run", { box: live!.name, command: "cat work.txt" });
  assert.match(text(result), /kept/);
  assert.deepEqual(await app.boxes.list("thr_two"), [], "the archived thread's guest went");
  assert.deepEqual(await app.boxes.list("thr_three"), [], "no record until BB answers");
  const held = (await world.backend!.held()).map((guest) => guest.owner?.boxId).sort();
  assert.deepEqual(held, [live!.id, unsure!.id].sort());
  assert.ok(!held.includes(ended!.id));
  const logs = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(logs.some((line) => line.startsWith(`Restored box ${live!.name} of thread ${THREAD}`)), "the restore is logged");
  assert.ok(logs.some((line) => line.includes(`${ended!.id}, which no box records: its box's thread thr_two ended, as BB says at this sweep and the last. BB's answer: archivedAt ${new Date(archivedAt).toISOString()}, deletedAt null.`)));
  assert.ok(logs.some((line) => line.endsWith(`BB did not say whether thread thr_three still exists. BB's answer: status 404, code none, message "HTTP 404: Not Found".`)));
  assert.ok(logs.some((line) => line.startsWith(`Kept guest`) && line.includes(unsure!.id)));

  world.threadErrors.clear();
  assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes restored from their guests: 1/);
  assert.equal((await app.boxes.list("thr_three"))[0]?.id, unsure!.id, "restored once BB answers");
});

test("a box the sweep restores enrols again with its box ID once it answers, timed from then", async (t) => {
  const { harness, bb, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  await tool("box_acquire", {});
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const hostId = `host-${box.id}`;
  // The guest says the box was made an hour ago.
  const label = `backend/fake/guest/${box.guest!.ref}`;
  const guest = (await bb.storage.kv.get(label)) as { owner: { createdAt: number } };
  await bb.storage.kv.set(label, { ...guest, owner: { ...guest.owner, createdAt: guest.owner.createdAt - 3_600_000 } });
  const restore = async () => {
    for (const key of [...(await bb.storage.kv.list("box/")), ...(await bb.storage.kv.list("index/"))]) await bb.storage.kv.delete(key);
    assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes restored from their guests: 1/);
  };
  const enrolled = () =>
    until("enrolment", async () => {
      const current = await app.boxes.find(box.id);
      return current?.enrol.state === "enrolled" ? current : null;
    });
  const logged = () => harness.inspection.logEntries.map((entry) => entry.message).filter((line) => line.startsWith(`Enrolled box ${box.name} `));

  // The box rebooted, so BB still has its machine but its daemon is not running: bootstrap starts it again.
  world.hosts.set(hostId, { ...world.hosts.get(hostId)!, status: "disconnected" });
  await restore();
  const again = await enrolled();
  assert.equal(again.enrol.hostId, hostId);
  assert.deepEqual(world.bootstraps, [box.id, box.id]);
  assert.ok(again.timings.enrol! < 60_000, "timed from the restore, not from when the box was made");
  assert.match(logged().at(-1) ?? "", /^Enrolled box \S+ \d+\.\d\d s after bb-box found the restored box answering: .*BB waiting for the daemon /);
  assert.deepEqual(world.events, [`create ${hostId}`, `create ${hostId}`], "the same key, and BB's machine is kept");
  assert.equal(world.hosts.get(hostId)?.status, "connected");

  // BB no longer has the machine: it is made again with the same key.
  world.hosts.delete(hostId);
  await restore();
  assert.equal((await enrolled()).enrol.hostId, hostId);
  assert.deepEqual(world.bootstraps, [box.id, box.id, box.id]);
  assert.equal(world.events.length, 3);

  // A stopped box is restored stopped, and enrols when it starts.
  await tool("box_stop", { box: box.name });
  await restore();
  const stopped = await app.boxes.find(box.id);
  assert.equal(stopped?.state, "stopped");
  assert.equal(stopped?.enrol.state, "off");
  assert.ok(stopped?.restoredAt, "marked to enrol later");
  assert.equal(world.events.length, 3);
  assert.match(text(await tool("box_status", { box: box.name })), /BB machine: not enrolled since bb-box restored its lost record/);
  assert.ok(!isError(await tool("box_start", { box: box.name })));
  const started = await enrolled();
  assert.equal(started.enrol.hostId, hostId, "BB gives back the machine it still has");
  assert.equal(started.restoredAt, null);
  assert.deepEqual(world.events, [`create ${hostId}`, `create ${hostId}`, `create ${hostId}`, `create ${hostId}`]);
  assert.match(logged().at(-1) ?? "", /^Enrolled box \S+ \d+\.\d\d s after bb-box found the restored box answering: /);

  // Once enrolled, it reconnects when it starts again rather than enrolling.
  const bootstraps = world.bootstraps.length;
  await tool("box_stop", { box: box.name });
  await tool("box_start", { box: box.name });
  await until("reconnect", async () => world.bootstraps.length === bootstraps + 1);
  assert.equal(world.events.length, 4);
});

test("box_acquire takes a kind's ID from before 027, and the tools show the current one", async (t) => {
  const { harness, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  assert.match(text(await tool("box_acquire", { kind: "linux-headless", wait: false })), /^Acquiring box \S+ \(linux, 2 cores, 4 GiB memory\)\./);
  const listed = text(await tool("box_list", {}));
  assert.match(listed, /\(linux, /);
  assert.doesNotMatch(listed, /headless/);
});

test("refusals say what to do next", async (t) => {
  const { harness, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  const missing = await tool("box_run", { box: "nope", command: "true" });
  assert.ok(isError(missing));
  assert.match(text(missing), /This thread has no box "nope". It has no boxes.\n\nNext: Call box_list/);
  const kind = await tool("box_acquire", { kind: "linux-mainframe" });
  assert.ok(isError(kind));
  assert.match(text(kind), /There is no "linux-mainframe" kind. The kinds are: linux, linux-desktop.\n\nNext: Call box_list/);
  const desktop = await tool("box_acquire", { kind: "linux" });
  const name = /Box (\S+) \(/.exec(text(desktop))![1]!;
  const noDesktop = await tool("box_run", { box: name, command: "true", desktop: true });
  assert.match(text(noDesktop), /has no desktop/);
});

test("box_acquire takes the provider in the words box_list gives after On:, and a wrong name is refused with them (044)", async (t) => {
  const { harness, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const listed = text(await tool("box_list", {}));
  assert.match(listed, /- linux: .* On: Fake host\./);
  const refused = text(await tool("box_acquire", { kind: "linux", on: "elsewhere" }));
  assert.match(refused, /No provider is called "elsewhere"\. linux comes from: Fake host\. Leave "on" out for the first with room\./);
  assert.match(refused, /each kind's line ends with its providers/);
  const acquired = text(await tool("box_acquire", { kind: "linux", on: "fake host", wait: false }));
  assert.match(acquired, /^Acquiring box \S+ \(linux/);
  // A provider copied with what box_list says of its boxes, in brackets, names it too.
  const copied = text(await tool("box_acquire", { kind: "linux", on: "Fake host (physical machines, each lent whole)", wait: false }));
  assert.match(copied, /^Acquiring box \S+ \(linux/);
});

test("with no backend on, the plugin asks for its settings, and a saved configuration takes effect at once", async (t) => {
  const { harness, app, tool } = await start({});
  t.after(() => harness.lifecycle.dispose());

  assert.deepEqual(harness.inspection.needsConfigurationMessages, ["Set a backend up in BB Box's settings and turn it on."]);
  assert.match(text(await tool("box_list", {})), /No backend is set up/);
  const refused = await tool("box_acquire", {});
  assert.match(text(refused), /No backend is set up, so there are no boxes to acquire/);

  const { revision } = app.configuration.document;
  const applied = await harness.behavior.callRpc("config.apply", { draft: { backends: [{ id: "fake", type: "fake", enabled: true }] }, revision });
  assert.equal((applied as { ok: boolean }).ok, true);
  await until("the backend", async () => (await app.kinds()).length > 0);
  assert.ok(harness.inspection.realtimeSignals.some((signal) => signal.channel === "changed"));
  assert.ok(!isError(await tool("box_acquire", {})));
});
test("box_acquire takes a preset or a custom size, and box_list shows each kind's sizes (028)", async (t) => {
  const { harness, app, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  assert.match(
    text(await tool("box_list", {})),
    /- linux: .* Sizes: small \(2 cores, 4 GiB memory, the default\), medium \(4 cores, 8 GiB memory\), large \(8 cores, 16 GiB memory\); custom up to 16 cores, 32 GiB memory, 256 GiB disk\./,
  );
  assert.match(text(await tool("box_acquire", { size: "medium" })), /4 cores, 8 GiB memory/);
  const custom = text(await tool("box_acquire", { size: "large", memory_gib: 12, disk_gib: 40, wait: false }));
  assert.match(custom, /^Acquiring box \S+ \(linux, 8 cores, 12 GiB memory, 40 GiB disk\)\./);
  const sizes = (await app.boxes.list(THREAD)).map((box) => box.size);
  assert.deepEqual(
    sizes.sort((a, b) => a!.cores - b!.cores),
    [
      { cores: 4, memoryMiB: 8192, diskGiB: null },
      { cores: 8, memoryMiB: 12288, diskGiB: 40 },
    ],
  );
  assert.match(text(await tool("box_list", {})), /4 cores, 8 GiB memory/);

  const refused = await tool("box_acquire", { cores: 64 });
  assert.ok(isError(refused));
  assert.match(text(refused), /^A linux box can be at most 16 cores, 32 GiB memory, 256 GiB disk, not 64 cores, 4 GiB memory\./);
  assert.match(text(refused), /Pick a preset, or a custom size within the largest\. box_list shows each kind's sizes\./);
  assert.equal((await app.boxes.list(THREAD)).length, 2, "a refused size makes no box");
});

test("sizes saved in the Proxmox LXC settings before 028 become the kinds' default sizes, once (028)", async (t) => {
  const { harness, app, tool, setupOptions } = await start(
    { "fake-enabled": true, "proxmox-lxc-linux-cores": 6, "proxmox-lxc-linux-memory-mib": 6144 },
    { drivers: DRIVERS },
  );
  t.after(() => harness.lifecycle.dispose());

  const linux = (await app.kinds()).find((kind) => kind.id === "linux")!;
  assert.equal(linux.defaultPreset, "small");
  assert.deepEqual(linux.presets.map((preset) => preset.words), ["6 cores, 6 GiB memory", "6 cores, 8 GiB memory", "8 cores, 16 GiB memory"]);
  assert.match(text(await tool("box_acquire", {})), /6 cores, 6 GiB memory/);
  assert.deepEqual((await only(app)).size, { cores: 6, memoryMiB: 6144, diskGiB: null });
  const desktop = (await app.kinds()).find((kind) => kind.id === "linux-desktop")!;
  assert.equal(desktop.presets[0]!.words, "4 cores, 8 GiB memory", "a kind with nothing saved keeps the shipped sizes");

  // The operator takes the entry out. A restart does not put it back.
  // Proxmox LXC moved in on, as it was, with problems: a write that keeps it on is refused, so it goes off.
  const { kinds: _, ...rest } = app.configuration.exported();
  const draft = { ...rest, backends: rest.backends.map((backend) => (backend.type === "proxmox-lxc" ? { ...backend, enabled: false } : backend)) };
  const applied = (await harness.behavior.callRpc("config.apply", { draft, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  let restarted: Awaited<ReturnType<typeof setup>> | null = null;
  const next = await harness.lifecycle.reload(async (bb) => {
    restarted = await setup(bb, setupOptions);
  });
  t.after(() => next.harness.lifecycle.dispose());
  const again = (await restarted!.kinds()).find((kind) => kind.id === "linux")!;
  assert.equal(again.presets[0]!.words, "2 cores, 4 GiB memory");
});
test("a box-sizes entry with a mistake is left out of the configuration, and the copy says so (028, 029)", async (t) => {
  const { harness, app } = await start({ "fake-enabled": true, "box-sizes": '{"linux":{"default":"huge"},"linux-desktop":{"default":"large"}}' });
  t.after(() => harness.lifecycle.dispose());

  const kinds = await app.kinds();
  assert.equal(kinds.find((kind) => kind.id === "linux")!.defaultPreset, "small");
  assert.equal(kinds.find((kind) => kind.id === "linux-desktop")!.defaultPreset, "large", "a good entry still counts");
  const copy = await app.configuration.migrated();
  assert.deepEqual(copy!.notes, ["Box sizes: linux.default must be small, medium or large. bb-box ignored it, so it was left out."]);
  assert.equal(copy!.values["box-sizes"], '{"linux":{"default":"huge"},"linux-desktop":{"default":"large"}}', "the copy keeps the setting as it was");
});
test("wrong settings are named in the status and the doctor", async (t) => {
  const { harness } = await start({ "fake-enabled": true, "fake-broken": true });
  t.after(() => harness.lifecycle.dispose());

  assert.deepEqual(harness.inspection.needsConfigurationMessages, ["Fake host: Fill in the fake host's address."]);
  const doctor = await harness.behavior.runCli(["doctor"]);
  assert.equal(doctor.exitCode, 1);
  assert.match(doctor.stdout ?? "", /Fake host: Its settings need fixing.\n {2}\[fail\] Settings: Fill in the fake host's address./);
});

test("the doctor warns, and does not fail, when a Linux preset has less than 2 GiB memory", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());

  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, kinds: { linux: { presets: { small: { memoryMiB: 1024 } } } } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  const doctor = await harness.behavior.runCli(["doctor"]);
  assert.equal(doctor.exitCode, 0);
  assert.match(
    doctor.stdout ?? "",
    /Sizes: Some presets of Linux kinds have less than 2 GiB memory.\n {2}\[warn\] Box sizes: The small linux preset, 2 cores, 1 GiB memory, has less than 2 GiB memory, so its boxes can run out of memory as they become BB machines.\n {8}Fix: Give it at least 2 GiB memory in bb-box's settings, under Kinds./,
  );
});

test("the panel lists, acquires, stops, starts and releases boxes over RPC", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());

  const empty = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: unknown[]; kinds: { id: string }[]; backends: { type: string; state: string; setup: { guide: string } }[] };
  assert.deepEqual(empty.boxes, []);
  assert.deepEqual(empty.kinds.map((kind) => kind.id), ["linux", "linux-desktop"]);
  assert.deepEqual(empty.backends.map((backend) => [backend.type, backend.state, backend.setup.guide]), [["fake", "active", "setup/fake/README.md"]]);

  const acquired = (await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" })) as { box: { id: string; desktop: boolean }; error: null };
  assert.equal(acquired.error, null);
  assert.equal(acquired.box.desktop, true);
  await app.boxes.idle();
  const box = await only(app);
  assert.equal(box.projectId, PROJECT);

  const stopped = (await harness.behavior.callRpc("stop", { threadId: THREAD, box: box.name })) as { box: { state: string } };
  assert.equal(stopped.box.state, "stopped");
  const started = (await harness.behavior.callRpc("start", { threadId: THREAD, box: box.id })) as { box: { state: string; canStopStart: boolean } };
  assert.deepEqual([started.box.state, started.box.canStopStart], ["ready", true]);
  const missing = (await harness.behavior.callRpc("release", { threadId: THREAD, box: "nope" })) as { box: null; error: string };
  assert.match(missing.error, /no box "nope"/);
  assert.deepEqual(await harness.behavior.callRpc("release", { threadId: THREAD, box: box.name }), { box: null, error: null });

  const backends = (await harness.behavior.callRpc("backends")) as { type: string; state: string }[];
  assert.deepEqual(backends.map((backend) => [backend.type, backend.state]), [["fake", "active"]]);
  const doctor = (await harness.behavior.callRpc("doctor")) as { ok: boolean; sections: { title: string }[] };
  assert.deepEqual([doctor.ok, doctor.sections.map((section) => section.title)], [true, ["Fake host"]]);
});

/** Everything the plugin sent a desktop viewer, joined. */
function sentTo(session: { sent: readonly (string | Uint8Array)[] }): Buffer {
  return Buffer.concat(session.sent.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));
}

test("the desktop route relays a box's desktop, and only the viewer with control reaches it", async (t) => {
  const { harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  const acquired = (await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" })) as { box: { id: string } };
  await app.boxes.idle();
  const box = await only(app);
  assert.equal(box.id, acquired.box.id);

  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { desktopPath: string };
  assert.equal(state.desktopPath, "/api/v1/plugins/bb-box/http/desktop");
  assert.deepEqual(
    ((await harness.behavior.callRpc("allBoxes", null)) as { threadId: string; box: { id: string } }[]).map((entry) => [entry.threadId, entry.box.id]),
    [[THREAD, box.id]],
  );

  const viewer = "viewer-one-0001";
  const refused = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string };
  assert.match(refused.error, /This viewer is not connected to the box's desktop/);

  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  const init = sentTo(session);
  assert.equal(init.subarray(0, 12).toString(), "RFB 003.008\n");
  assert.deepEqual([...init.subarray(12, 18)], [1, 1, 0, 0, 0, 0], "the relay offers None, and answered the box's password itself");
  assert.deepEqual([init.readUInt16BE(18), init.readUInt16BE(20)], [1280, 800]);
  const [rfb] = world.backend!.rfb.connections;
  assert.equal(rfb!.shared, 1);

  const key = (down: number) => Uint8Array.of(4, down, 0, 0, 0, 0, 0, 0x61);
  await session.receive(key(1));
  assert.equal(rfb!.received.byteLength, 0, "a viewer without control sends no input");

  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { box: { control: unknown }; error: null };
  assert.equal(took.error, null);
  assert.deepEqual(took.box.control, { owner: "human", holder: viewer });
  await session.receive(key(1));
  await until("the key to reach the box", async () => rfb!.received.byteLength === 8);

  const back = (await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.name })) as { box: { control: unknown } };
  assert.deepEqual(back.box.control, { owner: "agent", holder: null });
  await until("the key to be let go", async () => rfb!.received.byteLength === 16);
  assert.deepEqual([...rfb!.received.subarray(8)], [...key(0)]);

  await session.close();
  const noId = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=short`);
  await noId.receive(new TextEncoder().encode("RFB 003.008\n"));
  await noId.receive(Uint8Array.of(1));
  assert.match(sentTo(noId).subarray(12).toString(), /The viewer gave no viewer ID/);

  assert.deepEqual(await harness.behavior.callRpc("release", { threadId: THREAD, box: box.name }), { box: null, error: null });
  assert.deepEqual(await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id }), { box: null, desktopPath: state.desktopPath, terminalPath: "/api/v1/plugins/bb-box/http/terminal", video: false, videoByDefault: false, sharp: null, switching: false });
});

test("a box whose video is shown only by choice, as a Tart Mac's, offers video but opens VNC first; others open video", async (t) => {
  const state = async (kind: BoxKind) => {
    const { harness, box } = await desktopBox({ kind });
    t.after(() => harness.lifecycle.dispose());
    return (await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { video: boolean; videoByDefault: boolean };
  };
  const byChoice: BoxKind = {
    ...FAKE_SELKIES_KIND,
    capabilities: { ...FAKE_SELKIES_KIND.capabilities, displays: FAKE_SELKIES_KIND.capabilities.displays.map((display) => (display.protocol === "selkies" && display.shows !== "device" ? { ...display, byChoice: true } : display)) },
  };
  const chosen = await state(byChoice);
  assert.deepEqual([chosen.video, chosen.videoByDefault], [true, false]);
  const usual = await state(FAKE_SELKIES_KIND);
  assert.deepEqual([usual.video, usual.videoByDefault], [true, true]);
});

test("a box whose video comes from elsewhere, as a Windows VM's on a Mac, gets a viewer's keys on its own server, which gives the viewer with control its clipboard, and is told no size, while the pointer goes to the video's source (#865)", async (t) => {
  const { harness, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const own = new FakeSelkies();
  world.backend!.apartInput = own;
  const video = world.backend!.selkies;
  const rfb = world.backend!.rfb;
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("the viewer's page, on the video's source", async () => video.pages[0]);
  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: null };
  assert.equal(took.error, null);
  const input = await until("the input connection, on the box's own server", async () => own.pages[0]);
  assert.equal(video.pages.length, 1, "no input connection on the video's source");
  await session.receive("kd,97");
  await until("the key", async () => input.received.includes("kd,97"));
  assert.ok(!video.pages[0]!.received.includes("kd,97"));
  // The pointer goes to the video's source, which gives it to QEMU's tablet, and again after a key, the same.
  await session.receive("m,40,50,0,0,3");
  await until("the pointer on the video's source", async () => video.pages[0]!.received.includes("m,40,50,0,0"));
  await session.receive("kd,98");
  await until("the pointer again after a key", async () => video.pages[0]!.received.filter((message) => message === "m,40,50,0,0").length === 2);
  assert.ok(!input.received.some((message) => typeof message === "string" && message.startsWith("m,")), "no pointer to the box's own server");
  // The clipboard comes by the box's own server only, to the viewer with control.
  await own.clipboard("copied");
  await until("the clipboard", async () => session.sent.includes(`clipboard,${Buffer.from("copied").toString("base64")}`));
  // The video's source follows the desktop itself: the box's server is told no size.
  await session.receive("r,1024x768");
  await until("the resize", async () => rfb.width === 1024 && rfb.height === 768);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!input.received.some((message) => typeof message === "string" && message.includes("manual_resolution")), JSON.stringify(input.received));
  await session.close();
});

test("the desktop route carries a box's Selkies stream message by message, and only the viewer with control reaches the box, sizes it and gets its clipboard (056)", async (t) => {
  const { harness, app, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  // Video is on by default (056): an install with no value set, as one upgrading, gets it; one that sets it off keeps it off.
  const video = async () => ((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { video: boolean }).video;
  assert.equal(app.configuration.exported().general.video, undefined, "no value set");
  assert.equal(await video(), true);
  const set = async (value: boolean) => {
    const exported = app.configuration.exported();
    const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...exported, general: { ...exported.general, video: value } }, revision: exported.revision })) as { ok: boolean };
    assert.ok(applied.ok, JSON.stringify(applied));
  };
  await set(false);
  assert.equal(await video(), false, "set off, it stays off");
  await set(true);
  assert.equal(await video(), true);
  const refused = (await harness.behavior.callRpc("config.check", { draft: { ...app.configuration.exported(), general: { video: "yes" } } })) as { problems: { path: string; message: string }[] };
  assert.deepEqual(refused.problems.find((problem) => problem.path === "general.video")?.message, "video is true or false.");
  const selkies = world.backend!.selkies;
  const rfb = world.backend!.rfb;
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  const page = await until("the viewer's page", async () => selkies.pages[0]);
  assert.equal(page.role, "viewer");
  await until("Selkies' first message", async () => session.sent.includes("MODE websockets"));
  await session.receive("SETTINGS,{}");
  await session.receive("kd,97");
  await session.receive("r,1024x768");
  await until("the settings", async () => page.received.includes("SETTINGS,{}"));
  await selkies.frame(1, true, 1280, 800);
  await until("the frame", async () => session.sent.some((message) => typeof message !== "string"));
  assert.equal(selkies.pages.length, 1, "no input connection, and no input, without control");
  assert.deepEqual([rfb.width, rfb.height], [1280, 800], "no resize without control");
  await selkies.clipboard("copied");
  await selkies.clipboardImage("image/png", Uint8Array.of(1, 2, 3, 4, 5), 2);
  await session.receive("cb,image/png,AQID");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!session.sent.some((message) => typeof message === "string" && message.startsWith("clipboard")), "no clipboard, text or image, without control");
  assert.ok(!page.received.some((message) => typeof message === "string" && message.startsWith("cb,")), "no paste without control");

  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: null };
  assert.equal(took.error, null);
  // The input connection opens as control is taken, before any key.
  const input = await until("the input connection", async () => selkies.pages[1]);
  assert.equal(input.role, "controller");
  await until("its STOP_VIDEO", async () => input.received[1] === "STOP_VIDEO");
  await session.receive("kd,97");
  await until("the key", async () => input.received.includes("kd,97"));
  await session.receive("r,1024x768");
  await until("the resize", async () => rfb.width === 1024 && rfb.height === 768);
  // Selkies captures a desktop that grew at its old size, so the input connection tells it the size the desktop took.
  const follow = (width: number, height: number) =>
    `SETTINGS,${JSON.stringify({ displayId: "primary", manual_resolution: true, manual_width: width, manual_height: height, force_aligned_resolution: false })}`;
  await until("the video following the size", async () => input.received.includes(follow(1024, 768)));
  // Asking for video and stopping it first, so Selkies moves its capture to the size rather than stopping it, even after the
  // pages' video stopped and started again, as for a restart or a hidden tab.
  const told = input.received.indexOf(follow(1024, 768));
  assert.deepEqual(input.received.slice(told - 2, told), ["START_VIDEO", "STOP_VIDEO"]);
  // Selkies shows the size it was told, here at once, as it does with no person in control.
  await selkies.frame(2, true, 1024, 768);
  // A width of a multiple of 8 and an even height, which Selkies keeps as they are.
  await session.receive("r,1101x701");
  await until("such a size", async () => rfb.width === 1096 && rfb.height === 700);
  await until("the video following it", async () => input.received.includes(follow(1096, 700)));
  await selkies.frame(3, true, 1096, 700);
  // Once a frame of the size comes, the video is not paused: a pause while Selkies moves its capture leaves its own monitor at the
  // old size (the owner's note of 18 October 2026).
  const restarts = () => page.received.filter((message) => message === "STOP_VIDEO").length;
  await new Promise((resolve) => setTimeout(resolve, FOLLOW_FRAME_MS + 200));
  assert.equal(restarts(), 0, "no restart while the video showed each size it was told");
  // The viewer has shown them, as a page says: the relay holds back frames from a viewer that has not.
  await session.receive("CLIENT_FRAME_ACK 3 0");
  // Frames of another size than the desktop's, as from a capture that missed a resize, have the video follow the desktop. With no
  // frame of its size in time, as when Selkies stopped its capture for a person in control, the capture restarts, and again when a
  // restart brings none, until one does.
  await selkies.frame(4, true, 800, 600);
  await until("the video following the desktop", async () => input.received.filter((message) => message === follow(1096, 700)).length === 2);
  await until("the capture restarted", async () => page.received.join(" ").includes("STOP_VIDEO START_VIDEO REQUEST_KEYFRAME"));
  assert.equal(page.stopped, false, "the viewer's video runs again");
  await until("a second restart, as the first brought no frame of the size", async () => restarts() === 2);
  await session.receive("CLIENT_FRAME_ACK 4 0");
  await selkies.frame(5, true, 1096, 700);
  await new Promise((resolve) => setTimeout(resolve, FOLLOW_FRAME_MS + 200));
  assert.equal(restarts(), 2, "no restart once a frame of the size came");
  await selkies.clipboard("copied again");
  await until("the clipboard", async () => session.sent.includes(`clipboard,${Buffer.from("copied again").toString("base64")}`));
  // An image, both ways, in Selkies' parts and in order (#609).
  await selkies.clipboardImage("image/png", Uint8Array.of(1, 2, 3, 4, 5), 2);
  const image = ["clipboard_start,image/png,5", "clipboard_data,AQI=", "clipboard_data,AwQ=", "clipboard_data,BQ==", "clipboard_finish"];
  await until("the image", async () => session.sent.includes("clipboard_finish"));
  assert.deepEqual(session.sent.filter((message) => typeof message === "string" && message.startsWith("clipboard_")), image);
  const paste = ["cbs,bb1,image/png,5", "cbd,bb1,AQIDBA==", "cbd,bb1,BQ==", "cbe,bb1"];
  for (const message of paste) await session.receive(message);
  await until("the pasted image", async () => input.received.includes("cbe,bb1"));
  assert.deepEqual(input.received.filter((message) => typeof message === "string" && /^cb[sde],/.test(message)), paste);

  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.name });
  await until("the key let go", async () => input.received.includes("ku,97"));
  await until("the size the agent had", async () => rfb.width === 1280 && rfb.height === 800);
  await until("the video following it back", async () => input.received.includes(follow(1280, 800)));
  await session.close();
  await until("the page closed", async () => page.closed);
});

test("a box with the test device shows its device by the display's ID beside its desktop: video, stills, input and the clipboard reach only the device, and a box without one says so (063)", async (t) => {
  const kind: BoxKind = { ...FAKE_SELKIES_KIND, id: "linux-desktop-cpu" };
  const { harness, app, world, tool } = await start(undefined, { kinds: [kind] });
  t.after(() => harness.lifecycle.dispose());
  const { kinds: _, ...rest } = app.configuration.exported();
  const applied = (await harness.behavior.callRpc("config.apply", { draft: { ...rest, general: { ...rest.general, testDevice: true } }, revision: rest.revision })) as { ok: boolean };
  assert.ok(applied.ok, JSON.stringify(applied));
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: kind.id });
  await app.boxes.idle();
  const box = await only(app);
  const shown = (await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { box: { desktop: boolean; device: { model: string | null } | null; display: { protocol: string } | null }; video: boolean };
  assert.equal(shown.box.desktop, true);
  assert.equal(shown.box.display?.protocol, "rfb");
  assert.deepEqual(shown.box.device, { model: "Pixel 8", simulatorHost: false });
  assert.equal(shown.video, true, "the desktop's own video, not the device's");
  const selkies = world.backend!.selkies;
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&display=device`);
  await until("the device server's hello", async () => session.sent.some((message) => typeof message === "string" && message.startsWith("BB_DEVICE_HELLO ")));
  assert.ok(session.sent.includes("MODE websockets"));
  await session.receive("START_VIDEO");
  const frame = await until("a frame of the device", async () => session.sent.find((message): message is Uint8Array => typeof message !== "string"));
  assert.equal(frame[0], 4);
  assert.equal(frame[1]! & 15, 1, "the first frame is a key frame");
  assert.deepEqual([(frame[6]! << 8) | frame[7]!, (frame[8]! << 8) | frame[9]!], [360, 800]);
  const clipboard = `cw,${Buffer.from("Hello device").toString("base64")}`;
  await session.receive("kd,97");
  await session.receive(clipboard);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const log = async () => /stdout:\n([\s\S]*?)\n\n/.exec(text(await tool("box_run", { box: box.name, command: "cat ~/.bb-box/device/server.log" })))?.[1] ?? "";
  assert.doesNotMatch(await log(), /clipboard: the person's/, "nothing of a viewer without control reaches the device");
  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: null };
  assert.equal(took.error, null);
  await session.receive(clipboard);
  await until("the clipboard on the device", async () => /clipboard: the person's, 12 characters, is the device's now/.test(await log()));
  await session.receive("kd,97");
  await session.receive("ku,97");
  await session.receive("m,10,10,1,0");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(selkies.pages.length, 0, "the desktop's Selkies never hears of the device's viewer, its input or its clipboard");
  const stills = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-two-0002&display=device`);
  await until("the second viewer's hello", async () => stills.sent.some((message) => typeof message === "string" && message.startsWith("BB_DEVICE_HELLO ")));
  await stills.receive(stillsRequestText(true));
  await stills.receive("START_VIDEO");
  const still = await until("a still", async () => stills.sent.find((message): message is string => typeof message === "string" && message.startsWith("BB_DEVICE_STILL ")));
  const png = Buffer.from((JSON.parse(still.slice("BB_DEVICE_STILL ".length)) as { png: string }).png, "base64");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [360, 800]);
  assert.ok(!stills.sent.some((message) => typeof message !== "string"), "no video to a viewer that asked for stills");
  await stills.close();
  await session.receive("STOP_VIDEO");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hidden = session.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(session.sent.filter((message) => typeof message !== "string").length, session.sent.slice(0, hidden).filter((message) => typeof message !== "string").length, "a hidden viewer gets no frames");
  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.id });
  await session.close();
  assert.equal(selkies.pages.length, 0);

  const plain = await harness.behavior.experimental_openWebSocket(`/desktop?box=nope&viewer=${viewer}&display=device`);
  const refusal = await until("the refusal", async () => plain.closeCalls[0]);
  assert.match(refusal.reason ?? "", /no such box/);
});

test("a video display the backend resizes, as the GPU desktop with xrandr, takes a controller's size and has the video follow it with no RFB connection, which starved its capture (#916)", async (t) => {
  const { harness, app, world } = await start(undefined, { resize: "backend", kinds: [FAKE_SELKIES_KIND] });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: FAKE_SELKIES_KIND.id });
  await app.boxes.idle();
  const box = await only(app);
  const backend = world.backend!;
  const selkies = backend.selkies;
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => session.sent.includes("MODE websockets"));
  await selkies.frame(1, true, 1280, 800);
  await until("the frame", async () => session.sent.some((message) => typeof message !== "string"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  const input = await until("the input connection", async () => selkies.pages[1]);
  const follow = (width: number, height: number) =>
    `SETTINGS,${JSON.stringify({ displayId: "primary", manual_resolution: true, manual_width: width, manual_height: height, force_aligned_resolution: false })}`;
  const rfbBefore = backend.rfb.connections.length;
  await session.receive("r,1024x768");
  await until("the video following the size", async () => input.received.includes(follow(1024, 768)));
  assert.deepEqual(backend.resizes.at(-1), { width: 1024, height: 768 });
  assert.equal(backend.rfb.connections.length, rfbBefore, "no RFB connection to set the size or read it back");
  await session.close();
});

test("a video display told a size first, as Selkies on Sway, hears it before the backend resizes the desktop, and the size the desktop kept after a resize that fails (the owner's note of 18 October 2026)", async (t) => {
  const kind: BoxKind = {
    ...FAKE_SELKIES_KIND,
    capabilities: { ...FAKE_SELKIES_KIND.capabilities, displays: FAKE_SELKIES_KIND.capabilities.displays.map((display) => (display.protocol === "selkies" && display.shows !== "device" ? { ...display, tellSize: "first" as const } : display)) },
  };
  const { harness, app, world } = await start(undefined, { resize: "backend", kinds: [kind] });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: kind.id });
  await app.boxes.idle();
  const box = await only(app);
  const backend = world.backend!;
  const selkies = backend.selkies;
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => session.sent.includes("MODE websockets"));
  await selkies.frame(1, true, 1280, 800);
  await until("the frame", async () => session.sent.some((message) => typeof message !== "string"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  const input = await until("the input connection", async () => selkies.pages[1]);
  const follow = (width: number, height: number) =>
    `SETTINGS,${JSON.stringify({ displayId: "primary", manual_resolution: true, manual_width: width, manual_height: height, force_aligned_resolution: false })}`;
  // The backend's resize waits: Selkies hears the size before it ends, so it never captures Sway at a size it was not told.
  let open!: () => void;
  backend.resizeGate = new Promise<void>((resolve) => (open = resolve));
  await session.receive("r,1840x800");
  await until("the video told the size", async () => input.received.includes(follow(1840, 800)));
  assert.deepEqual(backend.resizes.at(-1), { width: 1840, height: 800 }, "the resize under way");
  assert.deepEqual([backend.rfb.width, backend.rfb.height], [1280, 800], "the desktop not resized yet");
  open();
  backend.resizeGate = null;
  await until("the resize", async () => backend.rfb.width === 1840);
  await selkies.frame(2, true, 1840, 800);
  await new Promise((resolve) => setTimeout(resolve, FOLLOW_FRAME_MS + 200));
  assert.ok(!selkies.pages[0]!.received.includes("STOP_VIDEO"), "no restart once a frame of the size came");
  // A size the desktop cannot take: the video follows the size it kept.
  await session.receive("r,40000x800");
  await until("the video told the size", async () => input.received.includes(follow(40000, 800)));
  await until("the video following the size the desktop kept", async () => input.received.filter((message) => message === follow(1840, 800)).length === 2);
  // A hand-back with the tab hidden returns once the desktop is restored: no frame of its size comes, and none is waited for.
  await session.receive("STOP_VIDEO");
  const told = input.received.length;
  const handing = Date.now();
  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.name });
  assert.ok(Date.now() - handing < FOLLOW_FRAME_MS, `the hand-back took ${Date.now() - handing} ms`);
  await until("the video told the size restored", async () =>
    input.received.slice(told).some((message) => typeof message === "string" && message.startsWith("SETTINGS,") && message.includes('"manual_width":1280')),
  );
  await until("the size the agent had", async () => backend.rfb.width === 1280 && backend.rfb.height === 800);
  await session.close();
});

test("a box whose image has bb-box-cursor gives each video viewer its pointer's shape and where it is, and a later viewer the last of each; Selkies' own arrow goes no further (060)", async (t) => {
  // The helper as a test drives it: each run, the events it is given, until bb-box ends it.
  const runs: { emit: (event: BoxPointer) => void; ended: boolean }[] = [];
  const pointer = (onEvent: (event: BoxPointer) => void, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const run = { emit: onEvent, ended: false };
      runs.push(run);
      signal.addEventListener("abort", () => {
        run.ended = true;
        resolve();
      });
    });
  const { harness, app, world } = await start(undefined, { kinds: [FAKE_SELKIES_KIND], pointer });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: FAKE_SELKIES_KIND.id });
  await app.boxes.idle();
  const box = await only(app);
  const selkies = world.backend!.selkies;
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-one-0001&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await until("the helper running", async () => runs.length === 1);
  const said = (session: typeof one) => session.sent.filter((message): message is string => typeof message === "string");
  // Selkies on Sway sends one arrow, whatever the box's pointer looks like.
  await selkies.pages[0]!.send('cursor,{"curdata":"QVJST1c=","hotx":0,"hoty":0}');
  // A 2 by 1 image: an opaque red pixel, then a clear one, as the helper gives it.
  runs[0]!.emit({ type: "image", width: 2, height: 1, hotX: 1, hotY: 0, argb: Uint8Array.from([0, 0, 255, 255, 0, 0, 0, 0]) });
  runs[0]!.emit({ type: "position", x: 640, y: 360 });
  await until("the pointer", async () => said(one).includes("BB_POINTER,640,360"));
  const cursor = said(one).find((message) => message.startsWith("cursor,"))!;
  const { curdata, hotx, hoty } = JSON.parse(cursor.slice("cursor,".length)) as { curdata: string; hotx: number; hoty: number };
  const png = Buffer.from(curdata, "base64");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), hotx, hoty], [2, 1, 1, 0], "the image as a PNG, 2 by 1, with its hotspot");
  await selkies.frame(1, true);
  await until("a frame after the arrow", async () => one.sent.some((message) => typeof message !== "string"));
  assert.ok(!said(one).some((message) => message.includes("QVJST1c=")), "Selkies' arrow went no further");

  // A viewer that connects later has the pointer as it is, before its next change.
  const two = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-two-0002&stream=selkies`);
  await until("the second viewer's pointer", async () => said(two).includes("BB_POINTER,640,360"));
  assert.ok(said(two).includes(cursor));
  assert.equal(runs.length, 1, "one helper for the box, whatever its viewers");
  runs[0]!.emit({ type: "leave" });
  await until("the pointer gone, for both", async () => said(one).includes("BB_POINTER,") && said(two).includes("BB_POINTER,"));

  // With no viewer left, the helper ends.
  await one.close();
  await two.close();
  await until("the helper ended", async () => runs[0]!.ended);
});

test("a VNC viewer's pointer stream gets the box's pointer from the same helper as video viewers, and ends at once on a box without one (060)", async (t) => {
  const runs: { emit: (event: BoxPointer) => void; ended: boolean }[] = [];
  const pointer = (onEvent: (event: BoxPointer) => void, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const run = { emit: onEvent, ended: false };
      runs.push(run);
      signal.addEventListener("abort", () => {
        run.ended = true;
        resolve();
      });
    });
  const { harness, app } = await start(undefined, { kinds: [FAKE_SELKIES_KIND], pointer });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: FAKE_SELKIES_KIND.id });
  await app.boxes.idle();
  const box = await only(app);
  const said = (session: { sent: readonly (string | Uint8Array)[] }) => session.sent.filter((message): message is string => typeof message === "string");
  // A VNC viewer's own stream of the pointer: it alone starts the helper.
  const vnc = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-vnc-00001&stream=pointer`);
  await until("the helper running", async () => runs.length === 1);
  runs[0]!.emit({ type: "image", width: 1, height: 1, hotX: 0, hotY: 0, argb: Uint8Array.from([0, 0, 255, 255]) });
  runs[0]!.emit({ type: "position", x: 10, y: 20 });
  await until("the pointer", async () => said(vnc).includes("BB_POINTER,10,20"));
  assert.ok(said(vnc).some((message) => message.startsWith("cursor,")), "its shape too");
  // A video viewer shares the run, and gets the pointer as it is.
  const video = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-video-0001&stream=selkies`);
  await until("the video viewer's pointer", async () => said(video).includes("BB_POINTER,10,20"));
  assert.equal(runs.length, 1, "one helper for the box");
  runs[0]!.emit({ type: "position", x: 11, y: 20 });
  await until("both told", async () => said(vnc).includes("BB_POINTER,11,20") && said(video).includes("BB_POINTER,11,20"));
  // Input on the pointer stream goes nowhere, and it is not a viewer of the desktop: it neither takes nor holds control.
  await vnc.receive("kd,97");
  assert.equal(vnc.closeCalls.length, 0);
  await video.close();
  assert.equal(runs[0]!.ended, false, "the VNC viewer still listens");
  await vnc.close();
  await until("the helper ended", async () => runs[0]!.ended);

  // A box whose image has no helper: the stream ends at once, saying why, and the VNC picture is as before.
  const plain = await start(undefined, { kinds: [FAKE_SELKIES_KIND] });
  t.after(() => plain.harness.lifecycle.dispose());
  await plain.harness.behavior.callRpc("acquire", { threadId: THREAD, kind: FAKE_SELKIES_KIND.id });
  await plain.app.boxes.idle();
  const older = await only(plain.app);
  const none = await plain.harness.behavior.experimental_openWebSocket(`/desktop?box=${older.id}&viewer=viewer-vnc-00002&stream=pointer`);
  await until("the stream ended", async () => none.closeCalls.length > 0);
  assert.deepEqual(none.closeCalls[0], { code: 1000, reason: POINTER_NONE });
});

test("a box whose image has no bb-box-cursor, as every Wayland box of a 24.04 image, keeps Selkies' own cursor messages and gets no pointer of bb-box's (#707, 060)", async (t) => {
  const { harness, app, world } = await start(undefined, { kinds: [FAKE_SELKIES_KIND] });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: FAKE_SELKIES_KIND.id });
  await app.boxes.idle();
  const box = await only(app);
  const selkies = world.backend!.selkies;
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-one-0001&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await selkies.pages[0]!.send('cursor,{"curdata":"QVJST1c=","hotx":0,"hoty":0}');
  await until("Selkies' cursor", async () => one.sent.includes('cursor,{"curdata":"QVJST1c=","hotx":0,"hoty":0}'));
  await selkies.frame(1, true);
  await until("a frame", async () => one.sent.some((message) => typeof message !== "string"));
  assert.ok(!one.sent.some((message) => typeof message === "string" && message.startsWith("BB_POINTER")), "no pointer of bb-box's");
  await one.close();
});

test("the backend resizes a desktop whose stream server cannot, one resize at a time and the latest last, and not below the display's smallest size (021)", async (t) => {
  const { harness, app, world } = await start(undefined, { resize: "backend", minSize: { width: 800, height: 600 } });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" });
  await app.boxes.idle();
  const box = await only(app);
  const backend = world.backend!;
  const screen = { id: 7, flags: 0 };
  const update = Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 1, 0, 1);

  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  const [rfb] = backend.rfb.connections;
  await session.receive(setDesktopSize(1600, 900, screen));
  await session.receive(update);
  await until("the update request to reach the box", async () => rfb!.received.byteLength === update.byteLength);
  assert.deepEqual(backend.resizes, [], "a viewer without control resizes nothing");

  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  let open!: () => void;
  backend.resizeGate = new Promise((resolve) => (open = resolve));
  for (const [width, height] of [
    [1400, 900],
    [1500, 900],
    [1600, 1000],
  ] as const) {
    await session.receive(setDesktopSize(width, height, screen));
  }
  await until("the resizes to reach the box", async () => rfb!.received.byteLength === update.byteLength + 3 * 24);
  assert.deepEqual(backend.resizes, [{ width: 1400, height: 900 }], "one resize runs; the rest wait");
  backend.resizeGate = null;
  open();
  await until("the latest resize", async () => backend.resizes.length === 2 && backend.displayResizing === 0);
  assert.deepEqual(backend.resizes.at(-1), { width: 1600, height: 1000 }, "the latest waiting request replaced the one before");
  assert.equal(backend.mostDisplayResizing, 1);
  assert.deepEqual([backend.rfb.width, backend.rfb.height], [1600, 1000]);

  await session.receive(setDesktopSize(518, 722, screen));
  await until("the smallest size", async () => backend.resizes.length === 3 && backend.displayResizing === 0);
  assert.deepEqual(backend.resizes.at(-1), { width: 800, height: 722 }, "a narrow pane gets the smallest width");
  assert.deepEqual([backend.rfb.width, backend.rfb.height], [800, 722]);

  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.name });
  assert.deepEqual(backend.resizes.at(-1), { width: 1280, height: 800 }, "hand-back gives the agent its size back");
  assert.deepEqual([backend.rfb.width, backend.rfb.height], [1280, 800]);
  await session.close();
});

test("the box ending the connection of the viewer with control keeps control while the viewer connects again, and the log says why (020)", async (t) => {
  const { harness, app, world } = await start(undefined, { controlReconnectMs: 200 });
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" });
  await app.boxes.idle();
  const box = await only(app);
  const open = async (viewer: string) => {
    const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
    await session.receive(new TextEncoder().encode("RFB 003.008\n"));
    await session.receive(Uint8Array.of(1));
    await session.receive(Uint8Array.of(1));
    return session;
  };
  const connections = world.backend!.rfb.connections;
  await open("viewer-one-0001");
  await until("the holder's connection to the box", async () => connections.length === 1);
  await open("viewer-two-0002");
  await until("the watcher's connection to the box", async () => connections.length === 2);
  const [holding, watching] = connections;
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer: "viewer-one-0001" });
  const warnings = () => harness.inspection.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
  const owner = async () => ((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { box: { control: { owner: string } } }).box.control.owner;
  await holding!.end();
  await until("the relay to see the end", async () => warnings().length === 1);
  await open("viewer-one-0001");
  await until("the viewer's new connection to the box", async () => connections.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await owner(), "human", "the viewer connected again in time");

  await watching!.end();
  const ended = Date.now();
  await connections[2]!.end();
  await until("control to go back", async () => (await owner()) === "agent");
  assert.ok(Date.now() - ended < 3_000, "after the time the plugin was given, not the 5 s default");
  const line = `Box ${box.name}'s desktop ended the connection of the viewer with control. It closed the connection. Control goes back to the agent unless the viewer connects again within 0.2 s.`;
  await until("the log lines", async () => warnings().length === 2);
  assert.deepEqual(warnings(), [line, line], "a watching viewer's end says nothing");
});

test("a reload keeps a person's control and the desktop's size for their viewer, and gives both back if it does not connect again in time (045)", async (t) => {
  const { bb, harness, app, world, setupOptions } = await start(undefined, { controlStaleMs: 500, controlReconnectMs: 60_000 });
  let host = harness;
  let api = bb;
  const hosts = [host];
  t.after(() => host.lifecycle.dispose());
  await host.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" });
  await app.boxes.idle();
  const box = await only(app);
  // Enrolment ends before the reload, which would stop it.
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const viewer = "viewer-one-0001";
  const open = async () => {
    const session = await host.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
    await session.receive(new TextEncoder().encode("RFB 003.008\n"));
    await session.receive(Uint8Array.of(1));
    await session.receive(Uint8Array.of(1));
    return session;
  };
  const session = await open();
  await host.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  await session.receive(setDesktopSize(1600, 1000, { id: 7, flags: 0 }));
  const before = world.backend!.rfb;
  await until("the viewer's size", async () => before.width === 1600);
  const control = async () => ((await host.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { box: { control: unknown } }).box.control;
  // As BB does: the next instance starts, then the last one stops.
  const reload = async () => {
    const next = await host.lifecycle.reload(async (bb) => {
      await setup(bb, setupOptions);
    });
    host = next.harness;
    api = next.bb;
    hosts.push(host);
    // The new instance's fake desktop is the box's, as the person left it.
    Object.assign(world.backend!.rfb, { width: 1600, height: 1000 });
  };

  await reload();
  assert.deepEqual([before.width, before.height], [1600, 1000], "the desktop keeps the person's size through the restart");
  await until("the viewer's control to be back", async () => JSON.stringify(await control()) === JSON.stringify({ owner: "human", holder: viewer }));
  await open();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(await control(), { owner: "human", holder: viewer }, "the viewer connected again in time");

  // Its tab closed while bb-box restarted.
  await reload();
  await until("control to go back", async () => ((await control()) as { owner: string }).owner === "agent");
  assert.deepEqual([world.backend!.rfb.width, world.backend!.rfb.height], [1280, 800], "the agent's size");
  const logged = (level: string) => hosts.flatMap((each) => each.inspection.logEntries.filter((entry) => entry.level === level).map((entry) => entry.message));
  assert.deepEqual(logged("error"), []);
  const stopping = `bb-box is stopping, as for an update or a reload. The viewer with control of box ${box.name}'s desktop keeps it if it connects again within 0.5 s.`;
  assert.deepEqual(logged("warn"), [stopping, stopping], "the log says why the viewer's connection dropped, and how long it has");
  const started = `The viewer with control of box ${box.name}'s desktop as bb-box restarted keeps it if it connects again within 0.5 s.`;
  assert.deepEqual(
    logged("info").filter((message) => message.includes("as bb-box restarted")),
    [started, started],
  );

  // What storage holds for a box that went, or that this version cannot read, gives nobody control.
  await api.storage.kv.set("desktop-control", [
    { boxId: "bx-gone", holder: viewer, size: null, resized: null },
    { boxId: box.id, holder: "x", size: null, resized: null },
    { boxId: box.id, holder: viewer, size: "big", resized: null },
  ]);
  await reload();
  await until("storage to be cleared", async () => (await api.storage.kv.get("desktop-control")) === undefined);
  assert.deepEqual(await control(), { owner: "agent", holder: null });
  assert.deepEqual(logged("error"), []);
  assert.equal(logged("info").filter((message) => message.includes("as bb-box restarted")).length, 2);

  // Nor for a box that stopped while bb-box was away.
  assert.match(text(await host.behavior.callAgentTool("box_stop", { box: box.name }, { threadId: THREAD, projectId: PROJECT })), /is stopped/);
  await api.storage.kv.set("desktop-control", [{ boxId: box.id, holder: viewer, size: null, resized: null }]);
  await reload();
  await until("storage to be cleared again", async () => (await api.storage.kv.get("desktop-control")) === undefined);
  assert.deepEqual(logged("error"), []);
  assert.equal(logged("info").filter((message) => message.includes("as bb-box restarted")).length, 2);
});

test("a take in the last instance after the next one started holds when the viewer connects to the next one (#318)", async (t) => {
  const { harness, app, setupOptions } = await start();
  let host = harness;
  t.after(() => host.lifecycle.dispose());
  await host.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" });
  await app.boxes.idle();
  const box = await only(app);
  await until("enrolment", async () => (await app.boxes.find(box.id))?.enrol.state === "enrolled");
  const viewer = "viewer-one-0001";
  const open = async () => {
    const session = await host.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
    await session.receive(new TextEncoder().encode("RFB 003.008\n"));
    await session.receive(Uint8Array.of(1));
    await session.receive(Uint8Array.of(1));
    return session;
  };
  await open();
  const control = async () => ((await host.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { box: { control: unknown } }).box.control;

  // The next instance starts and finds nobody's control kept. Then the
  // person takes control in the last one, which then stops.
  const last = host;
  const next = await host.lifecycle.reload(async (bb) => {
    await setup(bb, setupOptions);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await last.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  });
  host = next.harness;
  assert.deepEqual(await control(), { owner: "agent", holder: null }, "until a viewer connects");
  await open();
  await until("the viewer's control", async () => JSON.stringify(await control()) === JSON.stringify({ owner: "human", holder: viewer }));
  assert.deepEqual(
    [last, host].flatMap((each) => each.inspection.logEntries.filter((entry) => entry.level === "error").map((entry) => entry.message)),
    [],
  );
});

test("a box without a desktop has no desktop to control", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());
  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux" });
  await app.boxes.idle();
  const box = await only(app);
  const result = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer: "viewer-one-0001" })) as { error: string };
  assert.equal(result.error, `Box ${box.name} has no desktop.`);
  assert.deepEqual(
    ((await harness.behavior.callRpc("allBoxes", null)) as { threadId: string; box: { id: string } }[]).map((entry) => [entry.threadId, entry.box.id]),
    [[THREAD, box.id]],
    "the Boxes page lists a server box too, not only desktops",
  );
});

test("bb box lists kinds and boxes, and acquires and releases for the thread it runs in", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());

  const kinds = await harness.behavior.runCli(["kinds"]);
  assert.match(
    kinds.stdout ?? "",
    /^linux: Linux, on Fake host\. .* Root: no, the box user cannot use sudo\. Docker: no\.\n  small \(default\): 2 cores, 4 GiB memory\n  medium: 4 cores, 8 GiB memory\n  large: 8 cores, 16 GiB memory\n  largest: 16 cores, 32 GiB memory, 256 GiB disk\n/,
  );
  const acquired = await harness.behavior.runCli(["acquire", "linux", "--thread", THREAD, "--size", "medium", "--disk-gib", "20"]);
  assert.equal(acquired.exitCode, 0, acquired.stderr);
  const box = await only(app);
  assert.match(acquired.stdout ?? "", new RegExp(`Box ${box.name}`));
  assert.deepEqual(box.size, { cores: 4, memoryMiB: 8192, diskGiB: 20 });
  const tooBig = await harness.behavior.runCli(["acquire", "linux", "--thread", THREAD, "--memory-gib", "64"]);
  assert.equal(tooBig.exitCode, 1);
  assert.match(tooBig.stderr ?? "", /at most 16 cores, 32 GiB memory, 256 GiB disk, not 2 cores, 64 GiB memory.*\(invalid_size\)/s);
  const all = await harness.behavior.runCli(["list", "--all"]);
  assert.match(all.stdout ?? "", new RegExp(`- ${box.name}: .*\\[thread ${THREAD}\\]`));
  const json = JSON.parse((await harness.behavior.runCli(["list", "--thread", THREAD, "--json"])).stdout ?? "") as { name: string }[];
  assert.deepEqual(json.map((view) => view.name), [box.name]);
  const noThread = await harness.behavior.runCli(["list"]);
  assert.notEqual(noThread.exitCode, 0);
  const missing = await harness.behavior.runCli(["release", "nope", "--thread", THREAD]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /no box "nope".*\(not_found\)/);
  assert.match((await harness.behavior.runCli(["release", box.name, "--thread", THREAD])).stdout ?? "", /Released box/);
});

for (const via of ["bb box acquire", "box_acquire"] as const) {
  test(`${via} says when bb-box restarts before the box is ready, and the next bb-box goes on with it (#533)`, async (t) => {
    const { harness, app, world, tool } = await start();
    let disposing: Promise<void> | null = null;
    t.after(() => disposing ?? harness.lifecycle.dispose());
    let open!: () => void;
    world.backend!.gate = new Promise<void>((resolve) => (open = resolve));
    const acquiring = via === "box_acquire" ? tool("box_acquire", { kind: "linux" }).then(text) : harness.behavior.runCli(["acquire", "linux", "--thread", THREAD]).then((ran) => ran.stdout ?? "");
    const box = await until("the box's guest", async () => (await app.boxes.list(THREAD)).find((box) => box.guest));
    disposing = harness.lifecycle.dispose();
    await until("bb-box to stop", async () => app.boxes.stopping);
    open();
    const said = await acquiring;
    const restarted = `bb-box restarted, as for an update, before box ${box.name} was ready. It goes on starting once bb-box is back, usually within seconds.`;
    if (via === "box_acquire") assert.equal(said, `${restarted}\n\nNext: Call box_status with box "${box.name}" to see when it is ready.`);
    else assert.ok(said.startsWith(`Box ${box.name} (`) && said.endsWith(`\n\n${restarted} Follow it with: bb box status ${box.name} --thread ${THREAD}\n`), said);
  });
}

test("bb box install-id shows the install's ID, and --set takes an old one back once no box holds a guest", async (t) => {
  const { bb, harness, app, world } = await start();
  t.after(() => harness.lifecycle.dispose());
  const id = app.backends.installId;
  assert.match(id, /^[a-z0-9]{10}$/, "a new install makes a random ID");
  assert.equal(await bb.storage.kv.get("install-id"), id, "and keeps it");
  assert.equal((await harness.behavior.runCli(["install-id"])).stdout, `This install's ID is ${id}.\n`);

  const bad = await harness.behavior.runCli(["install-id", "--set", "Not_An_ID"]);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr ?? "", /"Not_An_ID" is not an install ID/);

  await harness.behavior.runCli(["acquire", "linux", "--thread", THREAD]);
  const box = await only(app);
  const refused = await harness.behavior.runCli(["install-id", "--set", "old-install"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", new RegExp(`Release ${box.name} first\\. Its guest carries this install's ID ${id}`));
  assert.equal(app.backends.installId, id);

  const released = await harness.behavior.runCli(["release", box.name, "--thread", THREAD]);
  assert.equal(released.exitCode, 0, released.stderr);
  const before = world.backend;
  const set = await harness.behavior.runCli(["install-id", "--set", "old-install"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout ?? "", /^This install's ID is now old-install\. The next sweep restores the boxes of the guests that carry it/);
  assert.equal(await bb.storage.kv.get("install-id"), "old-install");
  assert.notEqual(world.backend, before, "the backend is made again with the ID");
  assert.deepEqual(JSON.parse((await harness.behavior.runCli(["install-id", "--json"])).stdout ?? ""), { installId: "old-install" });
});

/** The fake Cua Driver's desktop in a box. */
function desktopFile(world: { root: string; backend: FakeBackend | null }, box: BoxRecord): string {
  return join(world.root, world.backend!.id, box.guest!.ref, "cua-driver.json");
}

function readDesktop(file: string): FakeDesktop {
  return JSON.parse(readFileSync(file, "utf8")) as FakeDesktop;
}

function editDesktop(file: string, edit: (desktop: FakeDesktop) => void): void {
  const desktop = readDesktop(file);
  edit(desktop);
  writeFileSync(file, JSON.stringify(desktop));
}

function lastCall(file: string, tool: string): FakeDesktop["calls"][number] | undefined {
  return readDesktop(file)
    .calls.filter((call) => call.tool === tool)
    .at(-1);
}

/** The reference on the tree line that contains `line`. */
function refOf(tree: string, line: string): string {
  const found = tree.split("\n").find((candidate) => candidate.includes(line));
  const ref = found && /\[(e\d+)\]/.exec(found)?.[1];
  assert.ok(ref, `a reference for ${line} in:\n${tree}`);
  return ref;
}

function imageOf(result: PluginAgentToolResult): { data: string; mimeType: string } | undefined {
  if (typeof result === "string") return undefined;
  return result.content.find((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image");
}

/** A desktop box whose desktop has one Tasks window, window 100. */
async function desktopBox(options: { computer?: SetupOptions["computer"]; kind?: BoxKind; shell?: string } = {}) {
  const started = await start(undefined, { computer: { pauseWaitMs: 300, desktopWaitMs: 300, ...options.computer }, kinds: options.kind && [options.kind], ...(options.shell ? { shell: options.shell } : {}) });
  await started.harness.behavior.callRpc("acquire", { threadId: THREAD, kind: options.kind?.id ?? "linux-desktop" });
  await started.app.boxes.idle();
  const box = await only(started.app);
  const file = desktopFile(started.world, box);
  writeFileSync(file, JSON.stringify(tasksDesktop()));
  return { ...started, box, file };
}

test("High resolution doubles a Linux desktop's pixels with Xfce at 2x, keeps them through a resize in control, and goes back with Xfce's own theme", async (t) => {
  // Xfce's settings, as xfconf-query keeps them, in a file in the box's home; the panel's restarts counted.
  const bin = tempDir("xfce");
  const shims: Record<string, string> = {
    // Setting the scale takes a moment, as in a real box, so the desktop's state can be read mid-switch.
    "xfconf-query": `echo "$*" >> "$HOME/xfconf.log"; case "$*" in *"/general/theme") echo Arc ;; *"WindowScalingFactor -s 2") sleep 0.3 ;; esac`,
    "xfce4-panel": `echo "panel $*" >> "$HOME/panel.log"`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { harness, box, world, tool } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const rfb = world.backend!.rfb;
  const sharp = async () => ((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { sharp: boolean | null }).sharp;
  const set = async (on: boolean) => (await harness.behavior.callRpc("desktop.sharp", { threadId: THREAD, box: box.id, on })) as { error: string | null };
  const switching = async () => ((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { switching?: boolean }).switching;
  assert.equal(await sharp(), false);
  assert.equal(await switching(), false);
  assert.deepEqual([rfb.width, rfb.height], [1280, 800]);

  // While it switches, the desktop says so, for every viewer to hold its last picture; after, it does not.
  const on = set(true);
  await until("the desktop says it is switching", async () => (await switching()) === true);
  assert.deepEqual(await on, { error: null });
  assert.equal(await switching(), false);
  assert.deepEqual([rfb.width, rfb.height], [2560, 1600], "twice the pixels");
  assert.equal(await sharp(), true);
  const log = () => readFileSync(join(home, "xfconf.log"), "utf8").trim().split("\n");
  assert.deepEqual(log(), ["-c xfwm4 -p /general/theme", "-c xsettings -p /Gdk/WindowScalingFactor -s 2", "-c xfwm4 -p /general/theme -s Default-xhdpi"]);
  assert.deepEqual(await set(true), { error: null }, "on again changes nothing");
  assert.equal(log().length, 3);

  // A resize in control keeps the density: the viewer's CSS pixels, twice over.
  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => session.sent.includes("MODE websockets"));
  await world.backend!.selkies.frame(1, true, 2560, 1600);
  await until("the frame", async () => session.sent.some((message) => typeof message !== "string"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  assert.deepEqual([rfb.width, rfb.height], [2560, 1600], "taking control changes nothing");
  await session.receive("r,1000x700");
  await until("the resize at twice the size", async () => rfb.width === 2000 && rfb.height === 1400);
  // A wide tab: twice its size would pass what H.264 level 5.2 takes at 60 frames a second, past which Safari's decoder refuses the video, so the
  // desktop is as large as fits, in proportion (the owner's note of 19 October 2026).
  await session.receive("r,2600x1500");
  await until("the resize within level 5.2 at 60 frames a second", async () => rfb.width === 3904 && rfb.height === 2256);
  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.id });
  await until("the size the agent had, at Sharp's density", async () => rfb.width === 2560 && rfb.height === 1600);
  await session.close();

  assert.deepEqual(await set(false), { error: null });
  assert.deepEqual([rfb.width, rfb.height], [1280, 800]);
  assert.equal(await sharp(), false);
  assert.deepEqual(log().slice(3), ["-c xsettings -p /Gdk/WindowScalingFactor -s 1", "-c xfwm4 -p /general/theme -s Arc"]);
  // No panel runs here, so none is asked to restart, which would show "Failed to restart the panel": one starts each time instead.
  const panel = () => (existsSync(join(home, "panel.log")) ? readFileSync(join(home, "panel.log"), "utf8").trim().split("\n").map((line) => line.trim()) : []);
  await until("a panel each time", async () => panel().length === 2);
  assert.deepEqual(panel(), ["panel", "panel"]);
});

test("High resolution on Windows: twice the pixels, then 200%, and 100% before the size goes back; a scale Windows refuses leaves it off at its size", async (t) => {
  // A Windows box's PowerShell that takes High resolution's scale scripts, noting each, and refuses the rest.
  const dir = tempDir("pwsh");
  const shell = join(dir, "pwsh");
  const scales = join(dir, "scale.log");
  // bb-box's scripts reach PowerShell in base64, a desktop command's within its own, so the shell reads through each.
  writeFileSync(
    shell,
    String.raw`#!/usr/bin/env node
let text = process.argv[3] ?? "";
for (let i = 0; i < 4; i++) text += [...text.matchAll(/FromBase64String\('{1,2}([A-Za-z0-9+\/=]+)'{1,2}\)/g)].map((m) => Buffer.from(m[1], "base64").toString("utf8")).join("\n");
const scale = /\$bbScale::Set\((\d+)\)/.exec(text);
if (scale) {
  require("node:fs").appendFileSync(process.env.BB_TEST_SCALES, scale[1] + "\n");
  process.exit(0);
}
process.exit(1);
`.replace("process.env.BB_TEST_SCALES", JSON.stringify(scales)),
  );
  chmodSync(shell, 0o755);
  const kind: BoxKind = { ...FAKE_WINDOWS_KIND, capabilities: { ...FAKE_WINDOWS_KIND.capabilities, displays: FAKE_SELKIES_KIND.capabilities.displays } };
  const { harness, box, world } = await desktopBox({ kind, shell });
  t.after(() => harness.lifecycle.dispose());
  const rfb = world.backend!.rfb;
  const sharp = async () => ((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { sharp: boolean | null }).sharp;
  const set = async (on: boolean) => (await harness.behavior.callRpc("desktop.sharp", { threadId: THREAD, box: box.id, on })) as { error: string | null };
  assert.equal(await sharp(), false, "offered on a Windows desktop shown as video");

  assert.deepEqual(await set(true), { error: null });
  assert.deepEqual([rfb.width, rfb.height], [2560, 1600], "twice the pixels");
  assert.equal(await sharp(), true);
  // Windows that started again keeps its size but may be at 100%: a viewer's connection sets 200% again.
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-one-0001&stream=selkies`);
  await until("the scale set again", async () => existsSync(scales) && readFileSync(scales, "utf8").trim().split("\n").length === 2);
  await session.close();
  assert.deepEqual(await set(false), { error: null });
  assert.deepEqual([rfb.width, rfb.height], [1280, 800]);
  assert.equal(await sharp(), false);
  assert.deepEqual(readFileSync(scales, "utf8").trim().split("\n"), ["200", "200", "100"]);

  // A scale Windows refuses: off again, at the size it had.
  writeFileSync(shell, "#!/bin/sh\necho 'Windows is at 125%, not 200%' >&2\nexit 1\n");
  assert.match((await set(true)).error ?? "", /Windows in box \S+ did not change its scale/);
  assert.equal(await sharp(), false);
  assert.deepEqual([rfb.width, rfb.height], [1280, 800]);
});

test("High resolution is as large as every viewer's browser decodes: smaller while one that decodes only level 5.2 watches, larger again when it goes (#864)", async (t) => {
  const bin = tempDir("xfce");
  for (const [name, script] of Object.entries({ "xfconf-query": `case "$*" in *"/general/theme") echo Arc ;; esac`, "xfce4-panel": ":" })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { harness, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const rfb = world.backend!.rfb;
  const selkies = world.backend!.selkies;
  assert.deepEqual(await harness.behavior.callRpc("desktop.sharp", { threadId: THREAD, box: box.id, on: true }), { error: null });
  // A viewer whose browser decodes level 6.1, as Chrome's does, takes control and widens its tab: the desktop is twice its size.
  const viewer = "viewer-one-0001";
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await one.receive("BB_DECODES,139264");
  await selkies.frame(1, true, 2560, 1600);
  await until("the frame", async () => one.sent.some((message) => typeof message !== "string"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  await one.receive("r,2600x1500");
  await until("twice the tab's size, past level 5.2", async () => rfb.width === 5200 && rfb.height === 3000);
  // A viewer whose browser decodes no more than level 5.2, as Safari's, watches: the desktop is as large as it decodes.
  const two = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-two-0002&stream=selkies`);
  await until("the second viewer", async () => two.sent.includes("MODE websockets"));
  await two.receive("BB_DECODES,34560");
  await until("within level 5.2", async () => rfb.width === 3904 && rfb.height === 2256);
  // It goes: twice the tab's size again.
  await two.close();
  await until("twice the tab's size again", async () => rfb.width === 5200 && rfb.height === 3000);
  assert.ok(!selkies.pages.some((page) => page.received.some((message) => typeof message === "string" && message.startsWith("BB_DECODES"))), "Selkies never sees bb-box's own message");
  // A viewer that does not say, as a page from before this, counts as one that decodes level 5.2.
  const three = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-three-0003&stream=selkies`);
  await until("the third viewer", async () => three.sent.includes("MODE websockets"));
  await one.receive("r,2600x1501");
  await until("within level 5.2 for a viewer that has not said", async () => rfb.width === 3904 && rfb.height === 2256);
  await three.close();
  await one.close();
});

test("a desktop that cannot be at high resolution says so, and refuses it", async (t) => {
  const { harness, box } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  assert.equal(((await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { sharp: boolean | null }).sharp, null);
  assert.match(((await harness.behavior.callRpc("desktop.sharp", { threadId: THREAD, box: box.id, on: true })) as { error: string }).error, /cannot be at high resolution: only Linux desktops drawn by the CPU and Windows desktops shown as video can/);
});

test("a box streams in 4:4:4 while every viewer's browser decodes it, and in 4:2:0 once one cannot", async (t) => {
  const { harness, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const selkies = world.backend!.selkies;
  const colour = (on: boolean) => `SETTINGS,${JSON.stringify({ displayId: "primary", video_fullcolor: on })}`;
  const settings = () => selkies.pages.filter((page) => page.role === "controller").flatMap((page) => page.received.filter((message) => typeof message === "string" && message.includes("video_fullcolor")));
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-one-0001&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await one.receive("BB_FULLCOLOR,1");
  await until("4:4:4", async () => settings().length === 1);
  assert.deepEqual(settings(), [colour(true)]);
  const two = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=viewer-two-0002&stream=selkies`);
  await until("the second viewer", async () => two.sent.includes("MODE websockets"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(settings(), [colour(true)], "nothing changes before the new viewer says");
  await two.receive("BB_FULLCOLOR,0");
  await until("4:2:0", async () => settings().length === 2);
  await two.close();
  await until("4:4:4 again, with that viewer gone", async () => settings().length === 3);
  assert.deepEqual(settings(), [colour(true), colour(false), colour(true)]);
  assert.ok(!selkies.pages.some((page) => page.received.some((message) => typeof message === "string" && message.startsWith("BB_FULLCOLOR"))), "Selkies never sees bb-box's own message");
  await one.close();
});

for (const [how, message] of [["stream", "BB_CURSOR"], ["selkies", "SET_NATIVE_CURSOR_RENDERING"]] as const) {
  test(`a video desktop (cursor ${how}) leaves the box's cursor out while a person holds control, and draws it while the agent has control`, async (t) => {
    const kind: BoxKind = {
      ...FAKE_SELKIES_KIND,
      capabilities: { ...FAKE_SELKIES_KIND.capabilities, displays: FAKE_SELKIES_KIND.capabilities.displays.map((display) => (display.protocol === "selkies" && display.shows !== "device" ? { ...display, cursor: how } : display)) },
    };
    const { harness, box, world } = await desktopBox({ kind });
    t.after(() => harness.lifecycle.dispose());
    const selkies = world.backend!.selkies;
    const cursors = () => selkies.pages.filter((page) => page.role === "controller").flatMap((page) => page.received.filter((sent) => typeof sent === "string" && sent.startsWith(message)));
    const viewer = "viewer-one-0001";
    const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
    await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
    await until("the cursor in the video, as the agent has control", async () => cursors().length === 1);
    await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
    await until("the cursor out, with a person in control", async () => cursors().length === 2);
    // A page from before the choice went, asking for the box's pointer: it goes nowhere, and changes nothing.
    await one.receive("BB_SHOWPOINTER,1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cursors().length, 2);
    await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.id });
    await until("the cursor in, as the agent has control again", async () => cursors().length === 3);
    assert.deepEqual(cursors(), [`${message},1`, `${message},0`, `${message},1`]);
    assert.ok(!selkies.pages.some((page) => page.received.some((sent) => typeof sent === "string" && sent.startsWith("BB_SHOWPOINTER"))), "the stream never sees the old page's message");
    await one.close();
  });
}

test("a Wayland desktop's pointer leaves the picture while a person holds control and comes back for the agent, as Sway paints it into each frame (#707)", async (t) => {
  const { harness, box, world } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const pointers: boolean[] = [];
  world.backend!.pointers = pointers;
  const viewer = "viewer-one-0001";
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await until("the pointer shown as a viewer connects, as the agent has control", async () => pointers.length === 1);
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  await until("the pointer out of the picture, with a person in control", async () => pointers.at(-1) === false);
  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.id });
  await until("the pointer back, as the agent has control again", async () => pointers.at(-1) === true);
  assert.deepEqual([pointers[0], pointers.includes(false), pointers.at(-1)], [true, true, true]);
  await one.close();
});

test("a Windows desktop's pointer leaves the VNC picture only while the person in control watches it, not the video, and comes back as they leave it (the desktop sweep)", async (t) => {
  const { harness, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const pointers: boolean[] = [];
  world.backend!.pointers = pointers;
  world.backend!.pointerWhileRfb = true;
  // A person takes control by video: the video leaves the pointer out itself, so it stays.
  const video = "viewer-video-0001";
  const watching = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${video}&stream=selkies`);
  await until("Selkies' first message", async () => watching.sent.includes("MODE websockets"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer: video });
  await until("asked, with the person by video", async () => pointers.length >= 2);
  assert.ok(!pointers.includes(false), "never out for a person watching by video");
  // Over VNC: out while they hold control there.
  const vnc = "viewer-vnc-0001";
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${vnc}`);
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer: vnc });
  await until("the pointer out, with the person watching over VNC", async () => pointers.at(-1) === false);
  // Their VNC viewer goes while they still hold control: back, for the video's sake.
  await one.close();
  await until("the pointer back as the VNC viewer goes", async () => pointers.at(-1) === true);
  await watching.close();
});

test("High resolution is offered for an X11 desktop with video, not a Wayland one, which has video too: the owner has it on hold (060)", () => {
  const box = (kind: string) =>
    ({ kind, capabilities: { os: "linux", gpu: false, displays: [{ id: "desktop", protocol: "rfb", resizable: true }, { id: "selkies", protocol: "selkies", resizable: true }] } }) as unknown as BoxRecord;
  assert.equal(sharpOffered(box("linux-desktop-cpu")), true);
  assert.equal(sharpOffered(box("linux-desktop-wayland-cpu")), false);
});

test("High resolution is offered for Windows with video on x86_64, not on arm64 on a Mac, where it has not been tried (060)", () => {
  const windows = (arch: string) =>
    ({ kind: arch === "arm64" ? "windows-arm64-desktop" : "windows-desktop", capabilities: { os: "windows", arch, gpu: false, displays: [{ id: "desktop", protocol: "rfb", resizable: true }, { id: "video", protocol: "selkies", resizable: true }] } }) as unknown as BoxRecord;
  assert.equal(sharpOffered(windows("x86_64")), true);
  assert.equal(sharpOffered(windows("arm64")), false);
});

test("a Wayland desktop's pointer script switches Sway's and GTK's cursor theme to the hidden one, or back, with the session bus whatever the caller's environment, and keeps wayvnc's input devices on the seat (#707)", () => {
  const hide = waylandPointerScript(false);
  // Without attach, the seat command detaches wayvnc's virtual pointer and keyboard: a person's clicks then go nowhere.
  assert.match(hide, /swaymsg -s "\$SWAYSOCK" 'seat seat0 attach "\*"; seat seat0 xcursor_theme bb-box-hidden' >\/dev\/null \|\| exit 1/);
  assert.match(hide, /gsettings set org\.gnome\.desktop\.interface cursor-theme bb-box-hidden/);
  assert.match(hide, /DBUS_SESSION_BUS_ADDRESS="\$\{DBUS_SESSION_BUS_ADDRESS:-unix:path=\$XDG_RUNTIME_DIR\/bus\}"/);
  const show = waylandPointerScript(true);
  assert.match(show, /seat seat0 attach "\*"; seat seat0 xcursor_theme default' >/);
  assert.match(show, /cursor-theme Adwaita$/);
});

test("a video desktop whose box's image cannot leave the cursor out is never told, whatever its kind says (060)", async (t) => {
  const kind: BoxKind = {
    ...FAKE_SELKIES_KIND,
    capabilities: { ...FAKE_SELKIES_KIND.capabilities, displays: FAKE_SELKIES_KIND.capabilities.displays.map((display) => (display.protocol === "selkies" && display.shows !== "device" ? { ...display, cursor: "stream" as const } : display)) },
  };
  const { harness, box, world } = await desktopBox({ kind });
  t.after(() => harness.lifecycle.dispose());
  world.backend!.cursorless = true;
  const selkies = world.backend!.selkies;
  const viewer = "viewer-one-0001";
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  await one.receive("BB_SHOWPOINTER,1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!selkies.pages.some((page) => page.received.some((message) => typeof message === "string" && message.startsWith("BB_"))));
  await one.close();
});

test("a video desktop that says nothing of its cursor is never told", async (t) => {
  const { harness, box, world } = await desktopBox({ kind: FAKE_SELKIES_KIND });
  t.after(() => harness.lifecycle.dispose());
  const selkies = world.backend!.selkies;
  const viewer = "viewer-one-0001";
  const one = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}&stream=selkies`);
  await until("Selkies' first message", async () => one.sent.includes("MODE websockets"));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  await one.receive("BB_SHOWPOINTER,1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!selkies.pages.some((page) => page.received.some((message) => typeof message === "string" && message.startsWith("BB_"))));
  await one.close();
});

test("a macOS desktop whose server moves no clipboard has it through pbcopy and pbpaste in the box, as UTF-8, for the viewer with control only (#464)", async (t) => {
  // The pasteboard, as a Mac's pbcopy and pbpaste have it, kept in a file in the box's home.
  const bin = tempDir("pasteboard");
  const shims: Record<string, string> = {
    pbcopy: `printf %s "$LC_ALL" > "$HOME/pasteboard-locale"; cat > "$HOME/pasteboard"`,
    pbpaste: `cat "$HOME/pasteboard" 2>/dev/null`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { displays, command } = FAKE_KINDS[1]!.capabilities;
  // A fake box has no launchctl asuser, so its commands count as in the desktop session already; in-box's wrapper is 030's.
  const capabilities = { ...FAKE_KINDS[1]!.capabilities, os: "macos" as const, command: { ...command!, inDesktopSession: true }, displays: [{ id: displays[0]!.id, protocol: "rfb" as const, resizable: false, clipboard: "commands" as const }] };
  const kind: BoxKind = { ...FAKE_KINDS[1]!, id: "macos-desktop", label: "macOS desktop", capabilities };
  const { harness, app, box, tool } = await desktopBox({ kind });
  t.after(() => harness.lifecycle.dispose());
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const viewer = "viewer-one-0001";
  const clipboard = (viewer?: string) => harness.behavior.callRpc("desktopClipboard", { threadId: THREAD, box: box.id, ...(viewer ? { viewer } : {}) }) as Promise<{ text: string; serial: number } | null>;

  // Before control, nothing is pasted, and nothing is read.
  await assert.rejects(harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer, text: "early" }), /Only the tab with control of the desktop can paste into it/);
  assert.equal(await harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer, text: "early", automatic: true }), false, "an automatic send without control is declined, not an error");
  assert.ok(!existsSync(join(home, "pasteboard")), "and pastes nothing");
  writeFileSync(join(home, "pasteboard"), "copied before");
  assert.equal(await clipboard(viewer), null);

  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));
  assert.equal(((await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null }).error, null);

  const first = await clipboard(viewer);
  assert.equal(first?.text, "copied before");
  const pasted = "héllo, wörld ✓ 日本\nline two";
  assert.equal(await harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer, text: pasted, automatic: true }), null);
  assert.equal(readFileSync(join(home, "pasteboard"), "utf8"), pasted, "byte for byte, as UTF-8");
  assert.equal(readFileSync(join(home, "pasteboard-locale"), "utf8"), "en_US.UTF-8");
  assert.equal((await clipboard(viewer))?.serial, first!.serial, "the viewer's own paste does not come back as a copy");

  writeFileSync(join(home, "pasteboard"), "copied in the box ✓");
  const copied = await clipboard(viewer);
  assert.deepEqual(copied, { text: "copied in the box ✓", serial: copied!.serial });
  assert.ok(copied!.serial > first!.serial);
  // An empty pasteboard, as when the box copies an image, leaves the last text; a caller without control reads nothing new.
  writeFileSync(join(home, "pasteboard"), "");
  assert.deepEqual(await clipboard(viewer), copied);
  writeFileSync(join(home, "pasteboard"), "not for others");
  assert.deepEqual(await clipboard("viewer-two-0002"), copied);
  assert.deepEqual(await clipboard(), copied);
  await assert.rejects(harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer: "viewer-two-0002", text: "x" }), /Only the tab with control/);
  await session.close();
});

test("a desktop's clipboard is read once at a time, and a read that began before a paste does not bring the old text back (#461)", async (t) => {
  // A slow clipboard, as a Windows desktop's read takes seconds: it reads first, then waits, and counts its reads.
  const bin = tempDir("pasteboard-slow");
  const shims: Record<string, string> = {
    pbcopy: `cat > "$HOME/pasteboard"`,
    pbpaste: `echo read >> "$HOME/pasteboard-reads"; t=$(cat "$HOME/pasteboard" 2>/dev/null); sleep 0.6; printf %s "$t"`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { displays, command } = FAKE_KINDS[1]!.capabilities;
  const capabilities = { ...FAKE_KINDS[1]!.capabilities, os: "macos" as const, command: { ...command!, inDesktopSession: true }, displays: [{ id: displays[0]!.id, protocol: "rfb" as const, resizable: false, clipboard: "commands" as const }] };
  const kind: BoxKind = { ...FAKE_KINDS[1]!, id: "macos-desktop", label: "macOS desktop", capabilities };
  const { harness, app, box, tool } = await desktopBox({ kind });
  t.after(() => harness.lifecycle.dispose());
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const viewer = "viewer-one-0001";
  const clipboard = () => harness.behavior.callRpc("desktopClipboard", { threadId: THREAD, box: box.id, viewer }) as Promise<{ text: string; serial: number } | null>;
  const reads = () => (existsSync(join(home, "pasteboard-reads")) ? readFileSync(join(home, "pasteboard-reads"), "utf8").split("\n").filter(Boolean).length : 0);
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));
  assert.equal(((await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null }).error, null);

  // Three reads at once, as polls that overlap a slow read, run one command in the box and share its answer.
  writeFileSync(join(home, "pasteboard"), "first");
  const [a, b, c] = await Promise.all([clipboard(), clipboard(), clipboard()]);
  assert.equal(reads(), 1);
  assert.equal(a?.text, "first");
  assert.deepEqual([b, c], [a, a]);

  // A read that began before a paste found the old text: it is dropped, so the viewer's paste is not undone by a copy.
  writeFileSync(join(home, "pasteboard"), "old in the box");
  const reading = clipboard();
  await until("the second read to start", async () => reads() === 2);
  assert.equal(await harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer, text: "pasted while reading" }), null);
  const after = await reading;
  assert.deepEqual(after, { text: "pasted while reading", serial: a!.serial });
  assert.equal(readFileSync(join(home, "pasteboard"), "utf8"), "pasted while reading");
  await session.close();
});

test("a macOS desktop's clipboard comes from a watcher in the box once it runs, with no pbpaste per poll: a copy of the same text counts, and the viewer's own paste does not come back", async (t) => {
  const bin = tempDir("pasteboard-watch");
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
  });
  const { displays, command } = FAKE_KINDS[1]!.capabilities;
  const capabilities = { ...FAKE_KINDS[1]!.capabilities, os: "macos" as const, command: { ...command!, inDesktopSession: true }, displays: [{ id: displays[0]!.id, protocol: "rfb" as const, resizable: false, clipboard: "commands" as const }] };
  const kind: BoxKind = { ...FAKE_KINDS[1]!, id: "macos-desktop", label: "macOS desktop", capabilities };
  const { harness, app, box, tool } = await desktopBox({ kind });
  let disposed = false;
  t.after(() => (disposed ? undefined : harness.lifecycle.dispose()));
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const board = join(home, "pasteboard");
  const count = join(home, "pasteboard-count");
  const shims: Record<string, string> = {
    pbcopy: `cat > ${board}; echo x >> ${count}`,
    pbpaste: `echo read >> ${home}/pasteboard-reads; cat ${board} 2>/dev/null`,
    osascript: `echo $$ > ${home}/watcher-pid; echo ready; last=$(cat ${count} 2>/dev/null); while :; do now=$(cat ${count} 2>/dev/null); if [ "$now" != "$last" ]; then last=$now; printf 'C %s\\n' "$(base64 < ${board} | tr -d '\\n')"; fi; sleep 0.05; done`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${path}`;
  const copy = (value: string) => {
    writeFileSync(board, value);
    writeFileSync(count, `${readFileSync(count, "utf8")}x\n`);
  };
  writeFileSync(board, "before");
  writeFileSync(count, "x\n");
  const reads = () => (existsSync(join(home, "pasteboard-reads")) ? readFileSync(join(home, "pasteboard-reads"), "utf8").split("\n").filter(Boolean).length : 0);
  const viewer = "viewer-one-0001";
  const clipboard = () => harness.behavior.callRpc("desktopClipboard", { threadId: THREAD, box: box.id, viewer }) as Promise<{ text: string; serial: number } | null>;
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));
  assert.equal(((await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null }).error, null);

  const first = await clipboard();
  assert.equal(first?.text, "before", "the first poll reads the pasteboard, as the watcher starts");
  await until("the watcher to start", async () => existsSync(join(home, "watcher-pid")));
  copy("copied ✓");
  let latest: { text: string; serial: number } | null = first;
  await until("the copy", async () => (latest = await clipboard())?.text === "copied ✓");
  const settled = reads();
  for (let i = 0; i < 3; i++) await clipboard();
  assert.equal(reads(), settled, "polls while the watcher runs read nothing in the box");

  copy("copied ✓");
  await until("the same text copied again", async () => (await clipboard())!.serial > latest!.serial);
  latest = await clipboard();

  assert.equal(await harness.behavior.callRpc("desktopPaste", { threadId: THREAD, box: box.id, viewer, text: "pasted here" }), null);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await clipboard(), { text: "pasted here", serial: latest!.serial }, "the viewer's own paste does not come back as a copy");
  copy("after the paste");
  await until("a copy after the paste", async () => (await clipboard())?.text === "after the paste");

  const pid = Number(readFileSync(join(home, "watcher-pid"), "utf8"));
  await session.close();
  disposed = true;
  await harness.lifecycle.dispose();
  await until("the watcher to stop", async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("a click that opened another process's panel, which Cua on Windows calls a failed foreground check, is done, and names the panel (#484)", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const add = refOf(tree, '"Add"');
  editDesktop(file, (desktop) => {
    desktop.trayMenus = true;
  });
  const clicked = await tool("computer_act", { box: box.name, action: "click", ref: add });
  assert.equal(isError(clicked), false, text(clicked));
  assert.match(text(clicked), /^Clicked e\d+ \(push button 'Add'\)\.\n\nThe click landed, and window (\d+): explorer "Notification overflow", 200 by 120 came in front, such as a menu or panel of another app\. Observe it to act in it; clicking the same place again may close it\./);
  assert.match(text(clicked), /\n\nNext: Call computer_observe with window \d+ to act in what came in front\./);
  const calls = readDesktop(file).calls.filter((call) => call.tool === "click");
  assert.equal(calls.length, 1, "no second click, by position, that would close the panel again");

  // A click by position on the desktop, as on the taskbar's hidden-icons arrow, the same.
  await tool("computer_screenshot", { box: box.name });
  const onDesktop = await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 1500, y: 870 });
  assert.equal(isError(onDesktop), false, text(onDesktop));
  assert.match(text(onDesktop), /\n\nThe click landed, and window \d+: explorer "Notification overflow", 200 by 120 came in front/);
});

test("on Sway, text an element refuses in the background is pasted with Cua's paste key, and the clipboard's text put back (#707)", async (t) => {
  // wtype's own keys lose characters in Chrome: bb-box puts the text on the clipboard, Cua presses the paste key.
  const bin = tempDir("sway");
  const shims: Record<string, string> = {
    "wl-paste": `case "$*" in *-l*) echo text/plain ;; *) printf 'old\nclip' ;; esac`,
    "wl-copy": `if [ "$1" = --clear ]; then echo cleared >> "$HOME/copies"; else cat >> "$HOME/copies"; echo >> "$HOME/copies"; fi`,
    swaymsg: `cat "$HOME/tree.json"`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  const tree = (appId: string) => writeFileSync(join(home, "tree.json"), JSON.stringify({ id: 1, nodes: [{ id: 100, app_id: appId, nodes: [] }] }));
  tree("tasks");
  const field = refOf(text(await tool("computer_observe", { box: box.name, window: 100 })), '"New task"');
  const url = "en.wikipedia.org/wiki/Sway_(window_manager) :?&=#~ é";

  const typed = text(await tool("computer_type", { box: box.name, ref: field, text: url }));
  assert.match(typed, /^Typed 52 characters into e\d+ \(text 'New task'\), clicking it first, then pasting it with the real keyboard's Ctrl\+V, as typing on Wayland loses characters, the clipboard's text put back after/);
  const calls = readDesktop(file).calls;
  assert.deepEqual(calls.filter((call) => call.tool === "type_text").map((call) => call.args.delivery_mode), ["background"], "no keys typed");
  const paste = calls.filter((call) => call.tool === "press_key");
  assert.deepEqual(paste.map((call) => [call.args.key, call.args.modifiers, call.args.delivery_mode, call.args.window_id]), [["v", ["ctrl"], "foreground", 100]]);
  assert.equal(readFileSync(join(home, "copies"), "utf8"), `${url}\nold\nclip\n`, "the text, then the clipboard's own text again");

  tree("foot");
  const inTerminal = text(await tool("computer_type", { box: box.name, window: 100, text: "ls" }));
  assert.match(inTerminal, /pasting it with the real keyboard's Ctrl\+Shift\+V/);
  assert.deepEqual(readDesktop(file).calls.filter((call) => call.tool === "press_key").at(-1)!.args.modifiers, ["ctrl", "shift"]);
});

test("on Sway, text goes in with the image's US keyboard where it has one, and is pasted where the text has a character the layout lacks (#707)", async (t) => {
  // bb-box-type stands for /usr/local/libexec/bb-box/type: it records its text, and refuses é as the US layout lacks it.
  const bin = tempDir("sway-keyboard");
  const shims: Record<string, string> = {
    "bb-box-type": `text=$(cat; printf x); case "$text" in *é*) exit 3 ;; esac; printf %s "\${text%x}" >> "$HOME/typed"; echo >> "$HOME/typed"`,
    "wl-paste": `case "$*" in *-l*) echo text/plain ;; *) printf old ;; esac`,
    "wl-copy": `if [ "$1" = --clear ]; then echo cleared >> "$HOME/copies"; else cat >> "$HOME/copies"; echo >> "$HOME/copies"; fi`,
    swaymsg: `case "$*" in *get_tree*) cat "$HOME/tree.json" ;; *) echo "$*" >> "$HOME/swaymsg.log" ;; esac`,
  };
  for (const [name, script] of Object.entries(shims)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const home = /stdout:\n(.*)\n/.exec(text(await tool("box_run", { box: box.name, command: "pwd" })))![1]!;
  // Another window has Sway's focus, so the window is focused first.
  writeFileSync(join(home, "tree.json"), JSON.stringify({ id: 1, nodes: [{ id: 100, app_id: "tasks", nodes: [] }, { id: 7, focused: true, app_id: "foot", nodes: [] }] }));
  const field = refOf(text(await tool("computer_observe", { box: box.name, window: 100 })), '"New task"');
  const url = "en.wikipedia.org/wiki/Sway_(window_manager) :?&=#~";

  const typed = text(await tool("computer_type", { box: box.name, ref: field, text: url }));
  assert.match(typed, /^Typed 50 characters into e\d+ \(text 'New task'\), clicking it first, then with the real keyboard, in a US layout \(/);
  assert.equal(readFileSync(join(home, "typed"), "utf8"), `${url}\n`);
  assert.equal(readFileSync(join(home, "swaymsg.log"), "utf8"), "[con_id=100] focus\n");
  const calls = readDesktop(file).calls;
  assert.equal(calls.filter((call) => call.tool === "press_key").length, 0, "no paste key");
  assert.equal(existsSync(join(home, "copies")), false, "the clipboard is untouched");

  const accented = text(await tool("computer_type", { box: box.name, window: 100, text: "café" }));
  assert.match(accented, /pasting it with the real keyboard's Ctrl\+V/, "é is not on a US keyboard");
  assert.equal(readFileSync(join(home, "copies"), "utf8"), "café\nold\n");
});

test("an agent reads a desktop box's window, acts on references and is told what changed", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());

  const windows = text(await tool("computer_windows", { box: box.name }));
  assert.match(windows, /- window 100: tasks "Tasks", 800 by 600/);

  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  assert.match(tree, /^Window 100: tasks "Tasks", 800 by 600\. 11 elements, 12 lines\.\n/, "a whole tree is not called partial");
  assert.match(tree, /\n {2}- heading = "My tasks"\n/, "text that cannot be acted on has no reference");
  assert.doesNotMatch(tree, /actions=\[\]/);
  const deleteOne = refOf(tree, '"Delete Task 1"');
  const deleteThree = refOf(tree, '"Delete Task 3"');
  const field = refOf(tree, '"New task"');

  const clicked = await tool("computer_act", { box: box.name, action: "click", ref: deleteOne });
  assert.equal(isError(clicked), false, text(clicked));
  assert.match(text(clicked), new RegExp(`^Clicked ${deleteOne} \\(push button 'Delete Task 1'\\)\\.`));
  assert.match(text(clicked), /What changed in window 100 \(\+ appeared, - went, ~ changed\):\n- \[e\d+\] list item "Task 1"/);
  assert.match(text(clicked), new RegExp(`\\n- \\[${deleteOne}\\] push button "Delete Task 1"`));

  // Another element's reference outlives the change, and a gone one is refused.
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", ref: `[${deleteThree}]` })), /Clicked .*'Delete Task 3'/);
  const gone = await tool("computer_act", { box: box.name, action: "click", ref: deleteThree });
  assert.equal(isError(gone), true);
  assert.equal(text(gone), `${deleteThree} (push button 'Delete Task 3') is no longer on screen. Call computer_observe again.`);

  const typed = text(await tool("computer_type", { box: box.name, ref: field, text: "Buy milk" }));
  // The field refuses background typing: it is clicked with the real pointer, then its window gets the real keyboard, never the element (#707).
  assert.match(typed, /^Typed 8 characters into e\d+ \(text 'New task'\), clicking it first, then with the real keyboard \(the desktop's focus may have moved\)\./);
  assert.match(typed, new RegExp(`${field} now reads: \\[${field}\\] text "New task" value="Buy milk"`));
  const typing = readDesktop(file).calls.filter((call) => call.tool === "type_text");
  assert.deepEqual(typing.map((call) => call.args.delivery_mode), ["background", "foreground"]);
  assert.equal(typing[1]!.args.element_token, undefined, "the real keyboard goes to the window, not to the element");
  const calls = readDesktop(file).calls.map((call) => call.tool);
  assert.ok(calls.lastIndexOf("click") > calls.indexOf("type_text") && calls.lastIndexOf("click") < calls.lastIndexOf("type_text"), "clicked between the two");

  const pressed = text(await tool("computer_type", { box: box.name, window: 100, keys: "Return" }));
  assert.match(pressed, /^Pressed Return in window 100\./);
  assert.match(pressed, /\+ \[e\d+\] list item "Buy milk"/);
  const press = lastCall(file, "press_key");
  assert.deepEqual([press?.args.key, press?.args.modifiers], ["Return", []]);

  // computer_act presses keys too, as agents look for it there.
  assert.match(text(await tool("computer_act", { box: box.name, action: "key", keys: "ctrl+a", window: 100 })), /^Pressed ctrl\+a in window 100\./);
  assert.deepEqual(lastCall(file, "press_key")?.args, { pid: 5000, window_id: 100, key: "a", modifiers: ["ctrl"], delivery_mode: "background" });
  // Some harnesses send a window ID as a string where "desktop" may go.
  assert.match(text(await tool("computer_act", { box: box.name, action: "key", keys: "ctrl+a", window: "100" })), /^Pressed ctrl\+a in window 100\./);
  assert.match(text(await tool("computer_type", { box: box.name, keys: "ctrl+a", window: "100" })), /^Pressed ctrl\+a in window 100\./);
  assert.match(text(await tool("computer_screenshot", { box: box.name, window: "100" })), /^window 100: tasks "Tasks"/);
  assert.match(text(await tool("computer_act", { box: box.name, action: "key", window: 100 })), /^key needs keys: a key or chord, such as Escape or ctrl\+a\./);

  const queried = text(await tool("computer_observe", { box: box.name, window: 100, query: "task 2" }));
  assert.match(queried, /2 lines match "task 2", shown with their ancestors\./);
  assert.match(queried, /- \[e\d+\] frame "Tasks"\n {2}- \[e\d+\] list "Tasks"\n {4}- \[e\d+\] list item "Task 2"\n {6}- \[e\d+\] push button "Delete Task 2"/);
  assert.doesNotMatch(queried, /Buy milk/);

  const limited = text(await tool("computer_observe", { box: box.name, window: 100, limit: 2 }));
  assert.match(limited, /Partial: showing 2 of 10 lines \(1 of 9 elements\); 8 lines cut\. Pass query to see only the lines you need, or a larger limit \(at most 2000\)\./);

  const unknown = await tool("computer_act", { box: box.name, action: "click", ref: "e999" });
  assert.match(text(unknown), /^bb-box has no reference e999 for box .*\n\nNext: Call computer_observe to get references\./);
  const noTarget = await tool("computer_act", { box: box.name, action: "click" });
  assert.match(text(noTarget), /^Give ref, or window with x and y\./);
  assert.match(text(await tool("computer_type", { box: box.name, window: 100, keys: "ctrl+" })), /"ctrl\+" is not a key chord/);
  const closed = await tool("computer_observe", { box: box.name, window: 7 });
  assert.match(text(closed), /has no window 7\.\n\nNext: Call computer_windows/);
});

test("a dialog is named with its window, and an action that closes a window says so", async (t) => {
  const { harness, box, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const opened = text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(tree, '"Clear all"') }));
  assert.match(opened, /A modal dialog "Clear all tasks\?", window 101, is open over this window\./);
  assert.match(opened, /Next: .*Observe a dialog by its window ID to act in it\./);
  const dialog = text(await tool("computer_observe", { box: box.name, window: 101 }));
  assert.match(dialog, /^Window 101: tasks "Clear all tasks\?", 300 by 150\./);
  const cleared = text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(dialog, '"Clear"') }));
  assert.match(cleared, /Window 101 closed\./);
  const after = text(await tool("computer_observe", { box: box.name, window: 100 }));
  assert.doesNotMatch(after, /list item/);
});

test("on Wayland, a window that closes and gives way to another of its app's says it closed, and names the other (#402)", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.wayland = true;
  });
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(tree, '"Clear all"') }));
  const dialog = text(await tool("computer_observe", { box: box.name, window: 101 }));
  // Cua then reads window 101 as window 100, with no title or bounds of its own.
  const cleared = text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(dialog, '"Clear"') }));
  assert.match(cleared, /\n\nWindow 101 closed\. Its app's window 100: tasks "Tasks", \d+ by \d+, is open\.\n\nNext: Call computer_observe with window 100 to read it\.$/);
  assert.doesNotMatch(cleared, /What changed in window 101/);
  const again = await tool("computer_observe", { box: box.name, window: 101 });
  assert.match(text(again), /has no window 101|Window 101 has closed/);
  const typed = await tool("computer_type", { box: box.name, window: 101, text: "x" });
  assert.ok(isError(typed));
});

test("on Windows, a chord with a modifier goes through the real keyboard at once, to its window brought to the front, as Cua's background chord reaches the app as the bare key; a plain key stays in the background", async (t) => {
  const desktopKind = FAKE_KINDS.find((kind) => kind.capabilities.displays.length)!;
  const windowsDesktop: BoxKind = { ...desktopKind, id: "windows-desktop", label: "Windows desktop", capabilities: { ...desktopKind.capabilities, os: "windows", enrol: false } };
  const { harness, box, tool, file } = await desktopBox({ kind: windowsDesktop });
  t.after(() => harness.lifecycle.dispose());
  await tool("computer_observe", { box: box.name, window: 100 });

  const presses = () => readDesktop(file).calls.filter((call) => call.tool === "press_key").map((call) => [call.args.key, call.args.delivery_mode]);
  assert.match(text(await tool("computer_type", { box: box.name, window: 100, keys: "ctrl+a" })), /^Pressed ctrl\+a in window 100, with the real keyboard, its window brought to the front\./);
  assert.match(text(await tool("computer_act", { box: box.name, action: "key", window: 100, keys: "shift+Left" })), /^Pressed shift\+Left in window 100, with the real keyboard/);
  assert.match(text(await tool("computer_type", { box: box.name, window: 100, keys: "Return" })), /^Pressed Return in window 100\./);
  assert.deepEqual(presses(), [["a", "foreground"], ["Left", "foreground"], ["Return", "background"]], "no background try for a chord");
  // Each chord's window came to the front first, and stays there, so what is typed next reaches it.
  assert.deepEqual(readDesktop(file).calls.filter((call) => call.tool === "bring_to_front").map((call) => call.args), [{ pid: 5000, window_id: 100 }, { pid: 5000, window_id: 100 }]);
});

test("on Windows, computer_windows and computer_launch give a window with no title one, so Cua lists and reads it, and say so (#365)", async (t) => {
  // The backend's namer, as the box's helper is: a moment later, it titles each window on screen that has none.
  let file = "";
  let asked = 0;
  let running = 0;
  let most = 0;
  const nameWindows = async () => {
    asked++;
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, 150));
    running--;
    const named: { id: number; title: string }[] = [];
    editDesktop(file, (desktop) => {
      for (const window of desktop.windows) {
        if (window.title || window.menuOf !== undefined || !window.onScreen) continue;
        window.title = `${window.app} (untitled)`;
        named.push({ id: window.id, title: window.title });
      }
    });
    return named;
  };
  const desktopKind = FAKE_KINDS.find((kind) => kind.capabilities.displays.length)!;
  const windowsDesktop: BoxKind = { ...desktopKind, id: "windows-desktop", label: "Windows desktop", capabilities: { ...desktopKind.capabilities, os: "windows", enrol: false } };
  const started = await desktopBox({ kind: windowsDesktop, computer: { nameWindows, launchWaitMs: 2_000 } });
  const { harness, box, tool } = started;
  file = started.file;
  t.after(() => harness.lifecycle.dispose());
  let untitled = 0;
  editDesktop(file, (desktop) => {
    desktop.untitledUnlisted = true;
    untitled = desktop.nextWindow++;
    desktop.windows.push({ id: untitled, pid: desktop.nextPid++, app: "gpui-example", title: "", x: 50, y: 50, width: 640, height: 480, onScreen: true });
  });

  // computer_windows answers at once with Cua's list, and names in the background, one namer at a time.
  const first = await Promise.all([tool("computer_windows", { box: box.name }), tool("computer_windows", { box: box.name })]);
  for (const listed of first) assert.doesNotMatch(text(listed), new RegExp(`window ${untitled}|bb-box gave`));
  assert.equal(most, 1, "one namer at a time");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const listed = text(await tool("computer_windows", { box: box.name }));
  assert.match(listed, new RegExp(`\\n- window ${untitled}: gpui-example "gpui-example \\(untitled\\)", 640 by 480\\n`));
  assert.match(listed, new RegExp(`\\n\\nbb-box gave window ${untitled} the title "gpui-example \\(untitled\\)", as it had none, and Cua on Windows reaches only windows with a title\\.\\n\\nNext:`));
  assert.match(text(await tool("computer_observe", { box: box.name, window: untitled })), new RegExp(`^Window ${untitled}: gpui-example "gpui-example \\(untitled\\)"`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(text(await tool("computer_windows", { box: box.name })), /bb-box gave/, "said once, and a title the window has is left alone");
  // Within 15 s, the namer runs again only when Cua's window list changed. Each check waits for the namer before to end.
  await new Promise((resolve) => setTimeout(resolve, 300));
  let calls = asked;
  await tool("computer_windows", { box: box.name });
  assert.equal(asked, calls, "the same windows: not again");
  await new Promise((resolve) => setTimeout(resolve, 300));
  editDesktop(file, (desktop) => {
    desktop.windows.push({ id: desktop.nextWindow++, pid: desktop.nextPid++, app: "notes", title: "Notes", x: 0, y: 0, width: 300, height: 200, onScreen: true });
  });
  calls = asked;
  await tool("computer_windows", { box: box.name });
  assert.equal(asked, calls + 1, "a window more: again");

  // An app whose window has no title, launched: Cua lists it once it has one.
  const launched = text(await tool("computer_launch", { box: box.name, app: "untitled" }));
  assert.match(launched, /^Opened untitled\. Its window:\n- window \d+: untitled "untitled \(untitled\)", 640 by 480\n\nbb-box gave window \d+ the title "untitled \(untitled\)", as it had none, and Cua on Windows reaches only windows with a title\./);
  const before = asked;
  await tool("computer_observe", { box: box.name, window: untitled });
  assert.equal(asked, before, "only computer_windows and computer_launch name windows");
});

test("a dialog that closes a moment after its button is clicked says it closed, not that nothing changed or that it could not be read", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  // As a GTK dialog, whose read just after the click finds it unchanged; then as on Windows, whose read of it fails.
  for (const unreadable of [false, true]) {
    editDesktop(file, (desktop) => {
      desktop.closesLate = true;
      desktop.closingUnreadable = unreadable;
    });
    const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
    text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(tree, '"Clear all"') }));
    const dialog = text(await tool("computer_windows", { box: box.name })).match(/window (\d+): tasks "Clear all tasks\?"/)![1]!;
    const read = text(await tool("computer_observe", { box: box.name, window: Number(dialog) }));
    const cleared = text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(read, '"Clear"') }));
    assert.match(cleared, new RegExp(`\\n\\nWindow ${dialog} closed\\. Its app's window 100: tasks "Tasks", \\d+ by \\d+, is open\\.\\n\\nNext: Call computer_observe with window 100 to read it\\.$`), cleared);
    assert.doesNotMatch(cleared, /Nothing changed|could not read/);
  }
  // An action that changes nothing, in a window that stays, still says so.
  const after = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const started = Date.now();
  const unchanged = text(await tool("computer_act", { box: box.name, action: "scroll", ref: refOf(after, '"Clear all"'), direction: "down" }));
  assert.match(unchanged, /Nothing changed in window 100's tree\./);
  assert.ok(Date.now() - started >= 250, "after a look at the windows 250 ms later");
});

test("pixels count only against the agent's latest image of the window or the desktop", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());

  const blind = await tool("computer_act", { box: box.name, action: "click", window: 100, x: 745, y: 140 });
  assert.equal(isError(blind), true);
  assert.match(text(blind), /^You have no current image of window 100, so bb-box cannot tell what x and y mean\.\n\nNext: Call computer_screenshot with window 100/);

  const shot = await tool("computer_screenshot", { box: box.name, window: 100 });
  assert.match(text(shot), /^window 100: tasks "Tasks", 800 by 600\. Image 800x600 of window 800x600, scale 1; x and y are image pixels\./);
  assert.equal(imageOf(shot)?.mimeType, "image/png");
  const outside = await tool("computer_act", { box: box.name, action: "click", window: 100, x: 800, y: 10 });
  assert.match(text(outside), /x and y must be inside the image of window 100: x from 0 to 799, y from 0 to 599\./);
  // Task 3's Delete button.
  const clicked = text(await tool("computer_act", { box: box.name, action: "click", window: 100, x: 745, y: 140 }));
  assert.match(clicked, /^Clicked \(745, 140\) in window 100\. Image 800x600 of window 800x600, scale 1; x and y are image pixels\./);
  assert.match(clicked, /- \[e\d+\] list item "Task 3"/);

  // The window grows: the next read finds the image no longer fits.
  editDesktop(file, (desktop) => {
    desktop.windows[0]!.width = 900;
  });
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  assert.match(tree, /Window 100 changed size, so your last image of it no longer applies\./);
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", window: 100, x: 745, y: 100 })), /^You have no current image of window 100/);

  const desktop = await tool("computer_screenshot", { box: box.name });
  assert.match(text(desktop), /^The desktop\. Image 1568x882 of screen 1920x1080, scale 0\.817; x and y are image pixels\. Give window "desktop" with them\./);
  assert.match(
    text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 784, y: 441 })),
    /^Clicked \(784, 441\) on the desktop, \(960, 540\) on the screen\. Image 1568x882 of screen 1920x1080, scale 0\.817; x and y are image pixels\.\n\nNo window opened, closed or changed and nothing changed in the tree of window 100, which is under that point\./,
  );
  const click = lastCall(file, "click");
  assert.deepEqual(click?.args, { x: 784, y: 441, scope: "desktop", button: "left", count: 1, delivery_mode: "foreground" }, "Cua maps the desktop's pixels to the screen itself");
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 784, y: 441 })), /^Clicked \(784, 441\) on the desktop, \(960, 540\) on the screen\./, "an image serves for more than one click");

  const launched = text(await tool("computer_launch", { box: box.name, app: "wide" }));
  const wide = Number(/window (\d+): wide/.exec(launched)?.[1]);
  const big = await tool("computer_screenshot", { box: box.name, window: wide });
  assert.match(text(big), /Image 1568x78 of window 4000x200, scale 0\.392; x and y are image pixels\./, "no image is longer than 1568 pixels");
  const observed = text(await tool("computer_observe", { box: box.name, window: wide, screenshot: true }));
  assert.match(observed, /\n\nImage 1568x78 of window 4000x200, scale 0\.392; x and y are image pixels\./);
});

test("a click on an element the desktop cannot click as an element goes to the element's centre (048)", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.wayland = true;
    desktop.windows[0]!.noActions = true;
  });
  /** The clicks and reads sent since call `from`. */
  const sent = (from: number) =>
    readDesktop(file)
      .calls.slice(from)
      .filter(({ tool }) => tool === "click" || tool === "get_window_state")
      .map(({ tool, args }) => (tool === "click" ? `click ${args.x === undefined ? "element" : `(${String(args.x)}, ${String(args.y)})`} ${String(args.delivery_mode)}` : `read${args.include_screenshot ? " with image" : ""}`));

  // With no image of the window in this session, bb-box reads it with one first.
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const deleteThree = refOf(tree, 'push button "Delete Task 3"');
  const deleteTwo = refOf(tree, 'push button "Delete Task 2"');
  let from = readDesktop(file).calls.length;
  const clicked = text(await tool("computer_act", { box: box.name, action: "click", ref: deleteThree }));
  assert.match(
    clicked,
    new RegExp(`^Clicked ${deleteThree} \\(push button 'Delete Task 3'\\) at its centre, with the real pointer \\(the desktop's focus may have moved\\)\\. The desktop could not click it as an element, so bb-box clicked where it is drawn\\.`),
  );
  assert.match(clicked, /- \[e\d+\] list item "Task 3"/);
  assert.deepEqual(readDesktop(file).tasks["100"], ["Task 1", "Task 2"]);
  // Its frame, (800, 225) on the screen and 90 by 30, is (745, 140) in the window at (100, 100).
  assert.deepEqual(sent(from).slice(0, 4), ["click element background", "read with image", "click (745, 140) background", "click (745, 140) foreground"]);

  // With an image of the window in this session, it clicks at once.
  await tool("computer_screenshot", { box: box.name, window: 100 });
  from = readDesktop(file).calls.length;
  assert.match(text(await tool("computer_act", { box: box.name, action: "double_click", ref: deleteTwo })), new RegExp(`^Double-clicked ${deleteTwo} \\(push button 'Delete Task 2'\\) at its centre,`));
  assert.deepEqual(sent(from).slice(0, 3), ["click element background", "click (745, 100) background", "click (745, 100) foreground"]);
  assert.deepEqual(lastCall(file, "click")?.args, { pid: 5000, window_id: 100, x: 745, y: 100, button: "left", count: 2, delivery_mode: "foreground" });

  // The pixels are those of Cua's image of the window, which is smaller than a wide window.
  const launched = text(await tool("computer_launch", { box: box.name, app: "wide" }));
  const wide = Number(/window (\d+): wide/.exec(launched)?.[1]);
  const whole = refOf(text(await tool("computer_observe", { box: box.name, window: wide })), 'frame "wide"');
  assert.match(text(await tool("computer_act", { box: box.name, action: "right_click", ref: whole })), new RegExp(`^Right-clicked ${whole} \\(frame 'wide'\\) at its centre,`));
  assert.deepEqual(lastCall(file, "click")?.args, { pid: 5001, window_id: wide, x: 784, y: 39, button: "right", count: 1, delivery_mode: "foreground" });
});

test("an element's frame in its window's own pixels, as a GTK 3 app on Wayland gives it, is put on the screen (048)", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 }, kind: FAKE_WAYLAND_KIND });
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.wayland = true;
    desktop.windows[0]!.noActions = true;
    desktop.windows[0]!.ownFrames = true;
  });
  await tool("computer_screenshot", { box: box.name, window: 100 });
  const deleteThree = refOf(text(await tool("computer_observe", { box: box.name, window: 100 })), 'push button "Delete Task 3"');
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", ref: deleteThree })), new RegExp(`^Clicked ${deleteThree} \\(push button 'Delete Task 3'\\) at its centre,`));
  // Its frame, (700, 125) and 90 by 30 in the window, is where it is drawn.
  assert.deepEqual(lastCall(file, "click")?.args, { pid: 5000, window_id: 100, x: 745, y: 140, button: "left", count: 1, delivery_mode: "foreground" });
  assert.deepEqual(readDesktop(file).tasks["100"], ["Task 1", "Task 2"]);
});

test("an element partly above its window on an X11 desktop keeps its frame on the screen (048)", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.windows[0]!.olderTasks = true;
  });
  await tool("computer_screenshot", { box: box.name });
  // Its frame, (120, 90) and 200 by 40 on the screen, starts above the window
  // at (100, 100). Read as the window's own pixels, it would lie wholly inside
  // the window, over Task 2, at (300, 210) on the screen.
  const menu = text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 245, y: 172 }));
  assert.match(menu, /\n\nOpened a context menu on list item 'Task 2' \(window 101\):\n/);
});

test("computer_launch on Wayland gives the window the compositor lists, not an earlier entry Cua cannot act on (#737)", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 }, kind: FAKE_WAYLAND_KIND });
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.wayland = true;
  });
  const launched = text(await tool("computer_launch", { box: box.name, app: "early" }));
  assert.match(launched, /^Opened early\. Its window:\n- window (\d+): early "Untitled 1 - Early \[early\]", 640 by 480\n\nNext: Call computer_observe with window \1/);
  assert.doesNotMatch(launched, /142278656/);
});

test("computer_launch asks again while Windows' shell cannot look an app's name up yet, as just after a box starts, and gives up after a while", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 500, lookupWaitMs: 5_000 } });
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.lookupBusy = 2;
  });
  assert.match(text(await tool("computer_launch", { box: box.name, app: "tasks" })), /^Opened tasks\. Its window:\n- window 101: tasks "Tasks"/);
  // Busy for longer than the wait: Cua's answer, as before.
  editDesktop(file, (desktop) => {
    desktop.lookupBusy = 100;
  });
  const busy = await tool("computer_launch", { box: box.name, app: "tasks" });
  assert.equal(isError(busy), true);
  assert.match(text(busy), /temporarily unavailable: Windows did not respond to the shell:AppsFolder query within 4s/);
});

test("computer_launch opens apps and URLs and says which windows opened", async (t) => {
  const { harness, box, tool } = await desktopBox({ computer: { launchWaitMs: 500, pageWaitMs: 1_500 } });
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("computer_launch", { box: box.name, app: "tasks" })), /^Opened tasks\. Its window:\n- window 101: tasks "Tasks", 800 by 600\n\nNext: Call computer_observe with window 101/);
  assert.match(text(await tool("computer_launch", { box: box.name, app: "mousepad" })), /^Opened mousepad\. Its window:\n- window 102: mousepad "mousepad", 640 by 480/);

  // A browser's window is untitled until its page loads.
  const page = text(await tool("computer_launch", { box: box.name, url: "https://example.com/" }));
  assert.match(page, /^Opened https:\/\/example\.com\/\. Its window:\n- window 103: browser "Welcome to example\.com - Browser", 1280 by 800\n\nNext: Call computer_observe with window 103/);
  // In a browser already open, the title is the URL until the page loads, as Chrome's is.
  const reused = text(await tool("computer_launch", { box: box.name, url: "https://example.org/" }));
  assert.match(reused, /^Opened https:\/\/example\.org\/ in a window that was already open:\n- window 103: browser "Welcome to example\.org - Browser", 1280 by 800\n\nNext/);
  const slow = text(await tool("computer_launch", { box: box.name, url: "https://example.net/slow" }));
  assert.match(slow, /^Opened https:\/\/example\.net\/slow in a window that was already open:\n- window 103: browser "example\.net\/slow - Browser", 1280 by 800\n\nThe page may still be loading, or it has no title of its own: its window's title is still "example\.net\/slow - Browser"\./);

  // Cua's advice names its own tools, which the agent does not have.
  const missing = await tool("computer_launch", { box: box.name, app: "missing" });
  assert.equal(isError(missing), true);
  assert.equal(
    text(missing),
    "bb-box could not open missing: 'missing' is not an executable on PATH and matches no installed .desktop application. Apps installed in the box: Browser, Editor, Tasks, Wide.\n\n" +
      "Next: Give app as one of these names, or the path of a program in the box.",
  );
  assert.match(text(await tool("computer_launch", { box: box.name })), /^Give app or url, not both and not neither\./);
  // The hint names the app's window on screen, not a helper's off screen (#219).
  const textedit = text(await tool("computer_launch", { box: box.name, app: "textedit" }));
  const own = /window (\d+): TextEdit "Untitled"/.exec(textedit)?.[1];
  assert.match(textedit, /window \d+: CursorUIViewService, 40 by 40, not on screen/);
  assert.match(textedit, new RegExp(`Next: Call computer_observe with window ${own} to read it\\.`));
});

test("computer_launch of a single-instance app already open, which opens no new window, brings the app's window to the front", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  const opened = text(await tool("computer_launch", { box: box.name, app: "editor" }));
  const id = Number(/window (\d+): editor "Untitled 1 - Editor"/.exec(opened)?.[1]);
  const pid = readDesktop(file).windows.find((window) => window.id === id)!.pid;

  // Cua hands the launch to the editor over D-Bus, which shows a new document in its window.
  const again = await tool("computer_launch", { box: box.name, app: "Editor" });
  assert.equal(isError(again), false);
  assert.equal(
    text(again),
    `Editor was already open, and opening it again opened no new window. bb-box brought its window to the front:\n- window ${id}: editor "Untitled 2 - Editor", 640 by 480\n\n` +
      `Its title was "Untitled 1 - Editor" before, so it may show a new document.\n\nNext: Call computer_observe with window ${id} to read it.`,
  );
  assert.deepEqual(lastCall(file, "bring_to_front")?.args, { pid, window_id: id });
  assert.equal(readDesktop(file).windows.filter((window) => window.app === "editor").length, 1);
});

test("computer_launch on macOS opens Finder, which always runs, in a new window, apps outside the folders Cua looks in by their bundle IDs, and an app open already by bringing its window forward (#712)", async (t) => {
  const kind: BoxKind = { ...FAKE_KINDS[1]!, id: "macos-desktop", label: "macOS desktop", capabilities: { ...FAKE_KINDS[1]!.capabilities, os: "macos" } };
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 5_000 }, kind });
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.mac = true;
  });
  const launched = () => lastCall(file, "launch_app")?.args;

  // Finder opens a window only for a folder: a launch opens one at home, and not another process's window that came with it.
  const opened = text(await tool("computer_launch", { box: box.name, app: "Finder" }));
  const home = Number(/window (\d+)/.exec(opened)?.[1]);
  assert.match(opened, /^Opened Finder\. Its window:\n- window (\d+): Finder "box", 640 by 480\n\nNext: Call computer_observe with window \1 to read it\.$/);
  assert.deepEqual(launched(), { bundle_id: "com.apple.finder", urls: ["~"] });
  // Launched again, by path, it opens none, as its window shows home already: that window, brought forward, within 3 s, not 5.
  const finderBegan = Date.now();
  const finderAgain = text(await tool("computer_launch", { box: box.name, app: "/System/Library/CoreServices/Finder.app" }));
  assert.ok(Date.now() - finderBegan < 4_000);
  assert.equal(
    finderAgain,
    `/System/Library/CoreServices/Finder.app was already open, and opening it again opened no new window. bb-box brought its window to the front:\n- window ${home}: Finder "box", 640 by 480\n\nNext: Call computer_observe with window ${home} to read it.`,
  );
  assert.deepEqual(launched(), { bundle_id: "com.apple.finder", urls: ["~"] });
  assert.equal(lastCall(file, "bring_to_front")?.args.window_id, home);
  assert.equal(readDesktop(file).windows.filter((window) => window.app === "Finder").length, 1);
  // With its window gone to another folder, a launch opens a new one at home, which shows a little after the launch.
  editDesktop(file, (desktop) => {
    desktop.windows.find((window) => window.id === home)!.title = "Documents";
  });
  assert.match(text(await tool("computer_launch", { box: box.name, app: "Finder" })), /^Opened Finder\. Its window:\n- window \d+: Finder "box", 640 by 480\n/);

  // Cua finds no Archive Utility by name, in /System/Library/CoreServices; list_apps gives its bundle ID.
  assert.match(text(await tool("computer_launch", { box: box.name, app: "archive utility" })), /^Opened archive utility\. Its window:\n- window \d+: Archive Utility "Archive Utility"/);
  assert.deepEqual(launched(), { bundle_id: "com.apple.archiveutility" });
  // Cua takes no path on macOS: the bundle ID of the app at that path.
  const calculator = text(await tool("computer_launch", { box: box.name, app: "/System/Applications/Calculator.app/" }));
  const id = Number(/window (\d+): Calculator "Calculator"/.exec(calculator)?.[1]);
  assert.deepEqual(launched(), { bundle_id: "com.apple.calculator" });

  // Launched again, Calculator opens no window: its own, brought forward, without waiting for a new one.
  const began = Date.now();
  const again = text(await tool("computer_launch", { box: box.name, app: "calculator" }));
  assert.ok(Date.now() - began < 2_000);
  assert.equal(
    again,
    `calculator was already open, and opening it again opened no new window. bb-box brought its window to the front:\n- window ${id}: Calculator "Calculator", 640 by 480\n\nNext: Call computer_observe with window ${id} to read it.`,
  );
  assert.equal(lastCall(file, "bring_to_front")?.args.window_id, id);

  const missing = await tool("computer_launch", { box: box.name, app: "Nope" });
  assert.equal(isError(missing), true);
  assert.match(text(missing), /^bb-box could not open Nope: No installed macOS app found for name 'Nope'\. Apps installed in the box: Archive Utility, Calculator, Finder, TextEdit\./);
});

test("a web page's runs of text are one line each, and the limit counts every line shown", async (t) => {
  const { harness, box, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  const opened = text(await tool("computer_launch", { box: box.name, url: "https://example.com/" }));
  const id = Number(/window (\d+): browser/.exec(opened)?.[1]);

  const page = text(await tool("computer_observe", { box: box.name, window: id }));
  assert.match(page, new RegExp(`^Window ${id}: browser "Welcome to example\\.com - Browser", 1280 by 800\\. 65 elements, 128 lines\\.\n`));
  assert.match(page, /\n {4}- heading = "Welcome"\n {4}- static = "The quick brown fox jumps over the lazy dog\."\n {4}- \[e\d+\] link "Read more" \[actions=\[click\]\]\n {4}- static = "Hello world"\n {4}- \[e\d+\] link "" \[actions=\[click\]\]\n {4}- \[e\d+\] list "Results"\n/);
  assert.match(page, /- \[e\d+\] list item ""\n {8}- static = "Result 60"\n/);
  assert.doesNotMatch(page, /\uFFFC/, "names made only of object replacement characters are noise");
  assert.doesNotMatch(page, /Partial/);
  assert.match(page, /Next: .*This tree is large: pass query to see only the lines you need\./);

  const limited = text(await tool("computer_observe", { box: box.name, window: id, limit: 50 }));
  assert.match(limited, /Partial: showing 50 of 128 lines \(26 of 65 elements\); 78 lines cut\. Pass query to see only the lines you need, or a larger limit \(at most 2000\)\./);
  assert.equal(limited.split("\n\n")[1]!.split("\n").length, 50);
  assert.doesNotMatch(limited, /This tree is large/);

  const queried = text(await tool("computer_observe", { box: box.name, window: id, query: "result 7" }));
  assert.match(queried, /1 line matches "result 7", shown with their ancestors\./);
  assert.match(queried, /\n {6}- \[e\d+\] list item ""\n {8}- static = "Result 7"\n\nNext/);
});

test("a text area keeps its reference when typing into it renames its document", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  const opened = text(await tool("computer_launch", { box: box.name, app: "editor" }));
  const id = Number(/window (\d+): editor "Untitled 1 - Editor"/.exec(opened)?.[1]);
  const tree = text(await tool("computer_observe", { box: box.name, window: id }));
  const area = refOf(tree, 'text "" value=""');

  const typed = text(await tool("computer_type", { box: box.name, ref: area, text: "Hello" }));
  assert.match(typed, new RegExp(`^Typed 5 characters into ${area} \\(text\\)\\.`));
  assert.match(typed, /The window's title is now "\*Untitled 1 - Editor"\./);
  assert.match(typed, new RegExp(`${area} now reads: \\[${area}\\] text "Hello" value="Hello"`));
  assert.equal(lastCall(file, "type_text")?.args.delivery_mode, "background");

  // The text area is named after its text, as Mousepad's is: the reference follows it through its own rename.
  const again = text(await tool("computer_type", { box: box.name, ref: area, text: " world" }));
  assert.match(again, new RegExp(`^Typed 6 characters into ${area} \\(text 'Hello'\\)\\.`));
  assert.match(again, new RegExp(`${area} now reads: \\[${area}\\] text "Hello world" value="Hello world"`));
  assert.match(text(await tool("computer_observe", { box: box.name, window: id })), new RegExp(`- \\[${area}\\] text "Hello world" value="Hello world"`));
  assert.deepEqual(readDesktop(file).fields[id], "Hello world");
});

test("on Linux, text typed after a key chord or a double-click in the window goes through the real keyboard, as Cua's background typing leaves a selection in place", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  const opened = text(await tool("computer_launch", { box: box.name, app: "editor" }));
  const id = Number(/window (\d+): editor "Untitled 1 - Editor"/.exec(opened)?.[1]);
  const area = refOf(text(await tool("computer_observe", { box: box.name, window: id })), 'text "" value=""');
  const modes = () => readDesktop(file).calls.filter((call) => call.tool === "type_text").map((call) => call.args.delivery_mode);

  await tool("computer_type", { box: box.name, ref: area, text: "one" });
  await tool("computer_type", { box: box.name, window: id, keys: "ctrl+a" });
  assert.match(text(await tool("computer_type", { box: box.name, ref: area, text: "two" })), /^Typed 3 characters into .*, with the real keyboard/);
  await tool("computer_type", { box: box.name, window: id, text: "three" });
  await tool("computer_act", { box: box.name, action: "double_click", ref: area });
  await tool("computer_type", { box: box.name, window: id, text: "four" });
  // A click ends a selection.
  await tool("computer_act", { box: box.name, action: "double_click", ref: area });
  await tool("computer_act", { box: box.name, action: "click", ref: area });
  await tool("computer_type", { box: box.name, ref: area, text: "five" });
  assert.deepEqual(modes(), ["background", "foreground", "background", "foreground", "background"]);
});

test("an action on a reference is refused once when its element was renamed where the agent did not see it", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { launchWaitMs: 2_000 } });
  t.after(() => harness.lifecycle.dispose());
  const opened = text(await tool("computer_launch", { box: box.name, app: "editor" }));
  const id = Number(/window (\d+): editor "Untitled 1 - Editor"/.exec(opened)?.[1]);
  const tree = text(await tool("computer_observe", { box: box.name, window: id }));
  const tab = refOf(tree, 'page tab "Untitled 1"');
  const area = refOf(tree, 'text "" value=""');

  // The document changes. An action's list of changes shows the new names, so the agent has seen them.
  editDesktop(file, (desktop) => {
    desktop.fields[id] = "Draft";
    desktop.windows.find((window) => window.id === id)!.title = "*Untitled 1 - Editor";
  });
  const clicked = text(await tool("computer_act", { box: box.name, action: "click", ref: tab }));
  assert.match(clicked, new RegExp(`^Clicked ${tab} \\(page tab 'Untitled 1'\\)\\.`));
  assert.match(clicked, new RegExp(`\\n~ \\[${area}\\] text "Draft" value="Draft"`));
  assert.match(text(await tool("computer_type", { box: box.name, ref: area, text: "!" })), new RegExp(`^Typed 1 character into ${area} \\(text 'Draft'\\)\\.`));

  // It changes again, and only an image shows it: the reads behind it carry the reference to the renamed element.
  editDesktop(file, (desktop) => {
    desktop.fields[id] = "Notes";
  });
  await tool("computer_screenshot", { box: box.name, window: id });
  const refused = await tool("computer_type", { box: box.name, ref: area, text: "?" });
  assert.equal(isError(refused), true);
  assert.equal(
    text(refused),
    `${area} is now text 'Notes', but bb-box last showed it as text 'Draft!', so nothing was done.\n\nNext: Act on ${area} again if it is the one you want; otherwise call computer_observe.`,
  );
  assert.equal(readDesktop(file).fields[id], "Notes");
  assert.match(text(await tool("computer_type", { box: box.name, ref: area, text: "?" })), new RegExp(`^Typed 1 character into ${area} \\(text 'Notes'\\)\\.`));
  assert.equal(readDesktop(file).fields[id], "Notes?");
});

test("a button in a list whose rows all changed does not keep the old row's reference", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  editDesktop(file, (desktop) => {
    desktop.windows[0]!.plainButtons = true;
  });
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const first = /list item "Task 1"\n\s+- \[(e\d+)\] push button "Delete"/.exec(tree)?.[1];
  assert.ok(first, tree);
  const field = refOf(tree, '"New task"');

  // Another folder, say: the list's rows change, and another action reads the window again.
  editDesktop(file, (desktop) => {
    desktop.tasks["100"] = ["Invoice 7", "Invoice 8", "Invoice 9"];
  });
  await tool("computer_type", { box: box.name, ref: field, text: "x" });
  const clicked = await tool("computer_act", { box: box.name, action: "click", ref: first });
  assert.equal(isError(clicked), true);
  assert.equal(text(clicked), `${first} (push button 'Delete') is no longer on screen. Call computer_observe again.`);
  assert.deepEqual(readDesktop(file).tasks["100"], ["Invoice 7", "Invoice 8", "Invoice 9"]);
});

test("an action on the desktop says which windows opened, closed or changed, or suggests a screenshot", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const shot = text(await tool("computer_screenshot", { box: box.name }));
  assert.match(shot, /^The desktop\. Image 1568x882 of screen 1920x1080, scale 0\.817;/);

  // The Clear all button of window 100, at (850, 640) on the screen.
  const opened = text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 694, y: 523 }));
  assert.match(opened, /^Clicked \(694, 523\) on the desktop, \(850, 640\) on the screen\. Image 1568x882 of screen 1920x1080, scale 0\.817; x and y are image pixels\./);
  assert.match(opened, /\n\nA modal dialog "Clear all tasks\?", window 101, is open over this window\./);
  assert.match(opened, /\n\nWindows that changed \(\+ opened, - closed, ~ changed\):\n\+ window 101: tasks "Clear all tasks\?", 300 by 150\n\nNext: /);
  assert.match(opened, /Call computer_observe with window 101 to read it\./);

  // The dialog's Cancel button.
  const closed = text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 302, y: 339 }));
  assert.match(closed, /Windows that changed \(\+ opened, - closed, ~ changed\):\n- window 101: tasks "Clear all tasks\?", 300 by 150/);

  // A context menu is missing from the window list, but not from the tree of the window it opened over.
  // Task 3, at (400, 240) on the screen.
  const menu = text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 327, y: 196 }));
  assert.match(menu, /\n\nOpened a context menu on list item 'Task 3' \(window 102\):\n- \[e\d+\] menu ""\n {2}- \[e\d+\] menu item "Rename"/);
  assert.match(menu, /Next: Act on its items by reference\. To close it, press Escape with computer_type and window 102\.$/);
  assert.doesNotMatch(menu, /Nothing changed|Windows that changed|No window opened/);
  assert.match(text(await tool("computer_observe", { box: box.name, window: 100 })), /\n\nThe context menu on list item 'Task 3', window 102, is open over this window\.\n\nNext/);

  // A menu never becomes the active window: its keys go to the desktop, where it has the focus.
  const escaped = text(await tool("computer_type", { box: box.name, window: 102, keys: "Escape" }));
  assert.equal(
    escaped,
    "Pressed Escape with the real keyboard, for the context menu on list item 'Task 3' (window 102).\n\n" +
      "Closed the context menu on list item 'Task 3' (window 102).\n\nNext: Call computer_observe with window 100 to read the window it was open over.",
  );
  assert.deepEqual(lastCall(file, "press_key")?.args, { scope: "desktop", key: "Escape", modifiers: [], delivery_mode: "foreground" });
  const gone = await tool("computer_type", { box: box.name, window: 102, keys: "Escape" });
  assert.equal(isError(gone), true);
  assert.match(text(gone), /^Box .* has no window 102\./);

  // By reference, after reads that made the window's earlier tokens stale.
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const byRef = text(await tool("computer_act", { box: box.name, action: "right_click", ref: refOf(tree, 'list item "Task 2"') }));
  assert.match(byRef, /\n\nOpened a context menu on list item 'Task 2' \(window 103\):\n- \[e\d+\] menu ""/);
  assert.doesNotMatch(byRef, /Nothing changed/);
  const desktopKey = text(await tool("computer_act", { box: box.name, action: "key", keys: "Escape", window: "desktop" }));
  assert.match(desktopKey, /^Pressed Escape with the real keyboard, into whatever has the focus\.\n\nClosed the context menu on list item 'Task 2' \(window 103\)\./);

  // A menu's items are references.
  const again = text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 327, y: 196 }));
  const rename = refOf(again, 'menu item "Rename"');
  const picked = text(await tool("computer_act", { box: box.name, action: "click", ref: rename }));
  assert.match(picked, new RegExp(`^Clicked ${rename} \\(menu item 'Rename'\\)\\.\\n\\nClosed the context menu on list item 'Task 3' \\(window 104\\)\\.`));

  // When the desktop gives another window's elements for a menu, bb-box says it cannot read the menu's.
  editDesktop(file, (desktop) => {
    desktop.misreadPopups = true;
  });
  const misread = text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 327, y: 196 }));
  assert.match(misread, /\n\nOpened a context menu on list item 'Task 3' \(window 105\), whose items bb-box cannot read\.\n\nNext: Call computer_screenshot with window "desktop" to see it, then click its items by pixels\.$/);
  const unread = await tool("computer_observe", { box: box.name, window: 105 });
  assert.equal(isError(unread), true);
  assert.match(text(unread), /^bb-box cannot read the items of the context menu on list item 'Task 3' \(window 105\): the desktop gives another window's instead\./);
  assert.match(text(await tool("computer_type", { box: box.name, window: 105, keys: "Escape" })), /\n\nClosed the context menu on list item 'Task 3' \(window 105\)\./);

  // When its items show in its window's tree instead, as a GTK app's do, bb-box says so, and they are references.
  editDesktop(file, (desktop) => {
    desktop.menusInWindow = true;
  });
  const inWindow = text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 327, y: 196 }));
  assert.match(inWindow, /\n\nOpened a context menu on list item 'Task 3' \(window 106\)\. Its items show in window 100's tree below\.\n\nWhat changed in window 100 \(\+ appeared, - went, ~ changed\):\n/);
  assert.match(inWindow, /Next: Act on its items by reference\. To close it, press Escape with computer_type and window 106\. /);
  const item = refOf(inWindow, 'menu item "Delete"');
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", ref: item })), /\n\nClosed the context menu on list item 'Task 3' \(window 106\)\./);

  // Nothing is under (960, 540), and nothing changes.
  const nothing = text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 784, y: 441 }));
  assert.match(nothing, /\n\nNo window opened, closed or changed\. Anything else that changed shows only in pixels\.\n\nNext: Call computer_screenshot with window "desktop" to see the desktop now\.$/);
});

test("a closed popup is forgotten, so later actions on the desktop do not read its window", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  await tool("computer_screenshot", { box: box.name });
  // Task 3, at (400, 240) on the screen.
  assert.match(text(await tool("computer_act", { box: box.name, action: "right_click", window: "desktop", x: 327, y: 196 })), /Opened a context menu on list item 'Task 3' \(window 101\)/);
  // It closes where bb-box does not see it, as when a person clicks elsewhere.
  editDesktop(file, (desktop) => {
    desktop.windows = desktop.windows.filter((window) => window.menuOf === undefined);
  });
  // Nothing is under (1714, 980) on the screen.
  const away = { box: box.name, action: "click", window: "desktop", x: 1400, y: 800 };
  assert.match(text(await tool("computer_act", away)), /No window opened, closed or changed\./);
  const before = readDesktop(file).calls.length;
  assert.match(text(await tool("computer_act", away)), /No window opened, closed or changed\./);
  const reads = readDesktop(file).calls.slice(before).filter((call) => call.tool === "get_window_state");
  assert.deepEqual(reads, [], "window 100 holds no popup now");
});

test("Cua's cursor overlay on Windows is not listed, and an action on the desktop does not read it", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  // It covers the screen, above the desktop and below the apps' windows.
  editDesktop(file, (desktop) => {
    desktop.windows.unshift({ id: 1, pid: 4000, app: "cua-driver.exe", title: "Cua.AgentCursorOverlay.default", x: 0, y: 0, width: 1920, height: 1080, onScreen: true });
  });
  const windows = text(await tool("computer_windows", { box: box.name }));
  assert.match(windows, /- window 100: tasks "Tasks"/);
  assert.doesNotMatch(windows, /Cua|cua-driver|window 1:/);
  await tool("computer_screenshot", { box: box.name });
  const before = readDesktop(file).calls.length;
  // Only the overlay is under (1714, 980) on the screen.
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 1400, y: 800 })), /No window opened, closed or changed\./);
  const reads = readDesktop(file).calls.slice(before).filter((call) => call.tool === "get_window_state");
  assert.deepEqual(reads, []);
  const observed = await tool("computer_observe", { box: box.name, window: 1 });
  assert.equal(isError(observed), true);
  assert.match(text(observed), /^Box .* has no window 1\./);
});

test("pixels of the desktop keep their meaning in a new session, and are refused when the screen changed size", async (t) => {
  const { harness, app, box, file, tool } = await desktopBox({ computer: { idleMs: 100 } });
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("computer_screenshot", { box: box.name })), /^The desktop\. Image 1568x882 of screen 1920x1080, scale 0\.817;/);
  await until("the idle session to close", async () => !app.computer.connected(box.id));

  // A new session has no image of the desktop to map pixels by, so bb-box takes one first.
  // The Clear all button of window 100, at (850, 640) on the screen.
  const opened = text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 694, y: 523 }));
  assert.match(opened, /^Clicked \(694, 523\) on the desktop, \(850, 640\) on the screen\./);
  assert.match(opened, /A modal dialog "Clear all tasks\?", window 101, is open over this window\./);
  const desktop = readDesktop(file);
  assert.equal(desktop.sessions, 2);
  assert.equal(desktop.calls.filter((call) => call.tool === "get_desktop_state").length, 2);

  await until("the idle session to close", async () => !app.computer.connected(box.id));
  editDesktop(file, (changed) => {
    changed.screen = { width: 2560, height: 1440 };
  });
  const refused = await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 694, y: 523 });
  assert.equal(isError(refused), true);
  assert.equal(
    text(refused),
    'The screen changed size since your image of the desktop, so its pixels no longer match.\n\nNext: Take a new image with computer_screenshot, window "desktop".',
  );
  assert.equal(lastCall(file, "click")?.args.x, 694, "no second click");
  assert.equal(readDesktop(file).calls.filter((call) => call.tool === "click").length, 1);
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 694, y: 523 })), /^You have no current image of the desktop/);
});

test("a click on the desktop reads only a small tree under the point, and says when it did not", async (t) => {
  const { harness, box, file, tool } = await desktopBox({ computer: { smallTree: 5 } });
  t.after(() => harness.lifecycle.dispose());
  await tool("computer_screenshot", { box: box.name });

  // The heading of window 100, at (500, 115) on the screen.
  const clicked = text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 408, y: 94 }));
  assert.match(
    clicked,
    /\n\nNo window opened, closed or changed\. bb-box did not read the tree of window 100, which is under that point, as it is too large to read quickly\.\n\nNext: Call computer_observe with window 100 to see what changed in it, or computer_screenshot with window "desktop"\.$/,
  );
  const reads = readDesktop(file).calls.filter((call) => call.tool === "get_window_state").map((call) => call.args.max_elements);
  assert.equal(reads[0], 5);
  assert.ok(reads.length > 1 && reads.slice(1).every((budget) => budget === 1), `reads: ${reads.join()}`);

  // Once known to be large, its tree is not read at all.
  const calls = readDesktop(file).calls.length;
  await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 408, y: 94 });
  const later = readDesktop(file).calls.slice(calls).filter((call) => call.tool === "get_window_state");
  assert.ok(later.length > 0 && later.every((call) => call.args.max_elements === 1));
});

test("a window a few pixels from another of its app's is moved apart, so that its own tree is read", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  // A second window of the Tasks app, 10 pixels from the first, as a browser places a new window.
  editDesktop(file, (desktop) => {
    const window = { id: desktop.nextWindow++, pid: 5000, app: "tasks", title: "Errands", x: 110, y: 110, width: 800, height: 600, onScreen: true };
    desktop.windows.push(window);
    desktop.tasks[window.id] = ["Post a letter"];
    desktop.fields[window.id] = "";
  });

  const first = text(await tool("computer_observe", { box: box.name, window: 100 }));
  assert.match(first, /list item "Task 1"/);
  assert.doesNotMatch(first, /moved/);

  const second = text(await tool("computer_observe", { box: box.name, window: 101 }));
  assert.match(second, /frame "Errands"/);
  assert.match(second, /list item "Post a letter"/);
  assert.doesNotMatch(second, /Task 1/);
  assert.match(
    second,
    /\n\nbb-box moved window 101 to \(140, 140\) on the screen: it lay within a few pixels of window 100, another window of its app, and the desktop gave that window's tree for both\.\n\nNext:/,
  );
  const moves = () => readDesktop(file).calls.filter((call) => call.tool === "set_window_frame");
  assert.deepEqual(
    moves().map((call) => call.args),
    [{ pid: 5000, window_id: 101, x: 140, y: 140, width: 800, height: 600 }],
  );

  // Its references act in it, and once apart, neither window moves again.
  const added = text(await tool("computer_type", { box: box.name, ref: refOf(second, '"New task"'), text: "Buy stamps" }));
  assert.match(added, /value="Buy stamps"/);
  assert.equal(readDesktop(file).fields[101], "Buy stamps");
  assert.equal(readDesktop(file).fields[100], "");
  await tool("computer_observe", { box: box.name, window: 100 });
  assert.equal(moves().length, 1);

  // A maximised window stays where it is, and the agent is told what to do.
  editDesktop(file, (desktop) => {
    const window = { id: desktop.nextWindow++, pid: 5000, app: "tasks", title: "Shopping", x: 100, y: 100, width: 800, height: 600, onScreen: true, maximised: true };
    desktop.windows.push(window);
    desktop.tasks[window.id] = ["Bread"];
    desktop.fields[window.id] = "";
  });
  const stuck = await tool("computer_observe", { box: box.name, window: 102 });
  assert.ok(isError(stuck));
  assert.equal(
    text(stuck),
    'bb-box cannot read window 102: the desktop gives the tree of window 100, "Tasks", which lies within a few pixels of it, and window 102 would not move, as when it is maximised.\n\nNext: Un-maximise or close one of the two windows, for example by double-clicking its title bar, then observe it again. Or act on window 102 by pixels: call computer_screenshot with window 102.',
  );
});

test("while a person holds a desktop the computer tools wait, and afterwards the agent is told to observe", async (t) => {
  const { harness, app, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  const add = refOf(tree, '"Add"');

  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));

  // A click that takes longer than taking control waits for.
  editDesktop(file, (desktop) => {
    desktop.delays.click = 2_000;
  });
  const slow = tool("computer_act", { box: box.name, action: "click", ref: add });
  await until("the click to reach the driver", async () => readDesktop(file).calls.some((call) => call.tool === "click"));
  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null };
  assert.equal(took.error, null);
  const interrupted = await slow;
  assert.equal(isError(interrupted), true);
  assert.match(text(interrupted), /^A person took control of the box's desktop while this ran, so bb-box closed its session with the driver\. bb-box cannot tell whether it was done\.\n\nNext: Wait until they hand control back/);
  assert.equal(app.computer.connected(box.id), false);

  const paused = await tool("computer_windows", { box: box.name });
  assert.equal(isError(paused), true);
  assert.equal(text(paused), PAUSED);
  const calls = readDesktop(file).calls.length;

  await harness.behavior.callRpc("handBack", { threadId: THREAD, box: box.name });
  const back = text(await tool("computer_windows", { box: box.name }));
  assert.match(back, new RegExp(`^${RETURNED.replace(/[.;]/g, "\\$&")}\\n\\nWindows on box`));
  assert.equal(readDesktop(file).calls.length, calls + 1, "nothing reached the driver while the person held control");
  assert.doesNotMatch(text(await tool("computer_windows", { box: box.name })), /Control returned/, "the notice comes once");
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", ref: add })), /^bb-box has no reference e\d+/, "references go when a person takes control");
  await session.close();
});

test("computer_take_control takes a desktop back from a person as a hand-back does, and the computer tools work again (038)", async (t) => {
  const { harness, app, world, box, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  const already = await tool("computer_take_control", { box: box.name });
  assert.equal(isError(already), false);
  assert.equal(text(already), `You already have control of box ${box.name}'s desktop.`);
  await tool("computer_windows", { box: box.name });

  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));
  await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer });
  const rfb = world.backend!.rfb;
  const [relayed] = rfb.connections;
  await session.receive(setDesktopSize(1600, 1000, { id: 7, flags: 0 }));
  await session.receive(Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0x61));
  await until("the viewer's size and key", async () => rfb.width === 1600 && relayed!.received.at(-1) === 0x61);
  assert.equal(text(await tool("computer_windows", { box: box.name })), PAUSED);

  const took = await tool("computer_take_control", { box: box.name });
  assert.equal(isError(took), false);
  assert.equal(
    text(took),
    `You took control of box ${box.name}'s desktop back. Keys the person held down were let go, and the desktop has the size it had before they took control. It may have changed, and earlier references and images are gone.\n\nNext: Call computer_windows or computer_observe before acting.`,
  );
  assert.deepEqual([rfb.width, rfb.height], [1280, 800], "the agent's size");
  assert.deepEqual([...relayed!.received.subarray(-8)], [4, 0, 0, 0, 0, 0, 0, 0x61], "the person's key is let go");
  const state = (await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id })) as { box: { control: unknown } };
  assert.deepEqual(state.box.control, { owner: "agent", holder: null, takenFrom: viewer });
  assert.match(text(await tool("computer_windows", { box: box.name })), /^Windows on box/, "the take's answer says the desktop may have changed, so no notice follows");

  // The person can take it straight back.
  const again = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { box: { control: unknown }; error: null };
  assert.equal(again.error, null);
  assert.deepEqual(again.box.control, { owner: "human", holder: viewer });
  await session.close();
});

test("a click on the desktop says it was done when a person takes control while bb-box looks for changes", async (t) => {
  const { harness, app, box, file, tool } = await desktopBox({ computer: { desktopWaitMs: 5_000 } });
  t.after(() => harness.lifecycle.dispose());
  await tool("computer_screenshot", { box: box.name });

  const viewer = "viewer-one-0001";
  const session = await harness.behavior.experimental_openWebSocket(`/desktop?box=${box.id}&viewer=${viewer}`);
  await session.receive(new TextEncoder().encode("RFB 003.008\n"));
  await session.receive(Uint8Array.of(1));
  await session.receive(Uint8Array.of(1));
  await until("the viewer to join", async () => app.desktops.control.connected(box.id, viewer));

  // Nothing is under (960, 540), and nothing changes, so bb-box keeps looking.
  const click = tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 784, y: 441 });
  await until("the click to reach the driver", async () => readDesktop(file).calls.some((call) => call.tool === "click"));
  const took = (await harness.behavior.callRpc("takeControl", { threadId: THREAD, box: box.id, viewer })) as { error: string | null };
  assert.equal(took.error, null);
  const clicked = await click;
  assert.equal(isError(clicked), false, text(clicked));
  assert.match(text(clicked), /^Clicked \(784, 441\) on the desktop, \(960, 540\) on the screen\. .*\n\nA person took control of the desktop before bb-box could read what changed\.\n\nNext: Wait until they hand control back, or take it back with computer_take_control once they ask you to continue; then call computer_observe\.$/);
  await session.close();
});

test("a session the driver ended by itself, keeping its connection, gives way to a new one, for reads and actions alike (#662)", async (t) => {
  const { harness, box, file, tool } = await desktopBox();
  t.after(() => harness.lifecycle.dispose());
  assert.match(text(await tool("computer_windows", { box: box.name })), /Tasks/);
  editDesktop(file, (desktop) => void (desktop.endedSession = desktop.sessions));
  assert.match(text(await tool("computer_windows", { box: box.name })), /Tasks/, "a read goes on in a new session");
  assert.equal(readDesktop(file).sessions, 2);
  await tool("computer_screenshot", { box: box.name, window: "desktop" });
  editDesktop(file, (desktop) => void (desktop.endedSession = desktop.sessions));
  // The action's first read finds the session ended, so the action itself goes to the new one.
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", window: "desktop", x: 10, y: 10 })), /^Clicked \(10, 10\) on the desktop/);
  assert.equal(readDesktop(file).sessions, 3);
});

test("a computer-use session closes when idle, opens again when needed, and goes with its box", async (t) => {
  const { harness, app, box, file, tool } = await desktopBox({ computer: { idleMs: 100 } });
  t.after(() => harness.lifecycle.dispose());
  const tree = text(await tool("computer_observe", { box: box.name, window: 100 }));
  assert.equal(app.computer.connected(box.id), true);
  await until("the idle session to close", async () => !app.computer.connected(box.id));
  // The driver's tokens died with the session, so the reference is read again first.
  assert.match(text(await tool("computer_act", { box: box.name, action: "click", ref: refOf(tree, '"Delete Task 2"') })), /Clicked .*'Delete Task 2'/);
  assert.equal(readDesktop(file).sessions, 2);

  await tool("box_release", { box: box.name });
  assert.equal(app.computer.connected(box.id), false);

  await harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux" });
  await app.boxes.idle();
  const headless = await only(app);
  const refused = await tool("computer_windows", { box: headless.name });
  assert.equal(isError(refused), true);
  assert.match(text(refused), /has no computer use: its kind, linux, has no desktop the computer tools can drive\./);
  const notTaken = await tool("computer_take_control", { box: headless.name });
  assert.equal(isError(notTaken), true);
  assert.equal(text(notTaken), text(refused));
});

test("a provider's profile for the form's (i): its technology, hosts, kinds, room, usual start and status, with one capacity call", async (t) => {
  const { harness, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());
  const state = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { kinds: { id: string; gpu: boolean; offers: { backend: string; name: string }[] }[] };
  const offer = state.kinds.find((kind) => kind.id === "linux")!.offers[0]!;
  const profile = (await harness.behavior.callRpc("provider", { backend: offer.backend })) as {
    backend: string;
    name: string;
    technology: string;
    nature: string;
    hosts: string[];
    hostOs: string | null;
    makes: { id: string; label: string; form: string | null; typicalReadyMs: number | null; ready: number }[];
    boxes: number;
    room: { ok: boolean; hosts: { host: string; ok: boolean }[] } | null;
    status: { state: string; problem: string | null; ok: boolean | null; summary: string | null; checkedAt: number | null };
  };
  assert.equal(profile.backend, offer.backend);
  assert.equal(profile.name, offer.name, "named as the row names it");
  assert.ok(profile.technology.length > 0, "the driver's description");
  assert.ok(["virtual", "real"].includes(profile.nature));
  assert.ok(profile.makes.some((kind) => kind.id === "linux"), "makes linux");
  // A GPU desktop is named as box_list names it, so two Linux desktops read apart.
  for (const kind of profile.makes) assert.equal(kind.label.endsWith(" (GPU)"), state.kinds.find((candidate) => candidate.id === kind.id)!.gpu, kind.id);
  assert.equal(profile.boxes, 0);
  assert.ok(profile.room && profile.room.ok, "room for one more, as the fake backend says");
  assert.equal(profile.status.state, "active");
  assert.equal(profile.status.problem, null);
  // A box on it counts; a name that is no provider is refused.
  await tool("box_acquire", {});
  const again = (await harness.behavior.callRpc("provider", { backend: offer.backend })) as { boxes: number };
  assert.equal(again.boxes, 1);
  await assert.rejects(harness.behavior.callRpc("provider", { backend: "elsewhere" }), /No provider has the ID elsewhere/);
});

test("before BB's installer, a box sets aside BB's data for a machine that is not its own, and stops that machine's daemon, as after a restore", () => {
  const root = tempDir("aside");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  // systemctl records what it is asked, and uname says Linux.
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "$HOME/systemctl.log"\n`);
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Linux\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "uname"), 0o755);
  const data = (dir: string, host: string) => {
    mkdirSync(join(root, ".bb-machines", dir, "thread-storage"), { recursive: true });
    writeFileSync(join(root, ".bb-machines", dir, "host-id"), host);
    writeFileSync(join(root, ".bb-machines", dir, "thread-storage", "notes.txt"), "kept\n");
  };
  data("bb.example.com", "host_old");
  data("other.example.com", "host_mine");
  const units = join(root, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "bb-host-daemon-bb-example-com-host_old.service"), "[Service]\n");
  writeFileSync(join(units, "bb-host-daemon-other-example-com-host_mine.service"), "[Service]\n");
  const run = (keep: string | null) => execFileSync("/bin/sh", ["-c", setAsideOtherMachines(keep)], { encoding: "utf8", env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` } });

  assert.equal(run("host_mine"), `${root}/.bb-machines/bb.example.com host_old\n`);
  assert.equal(readFileSync(join(root, ".bb-machines/.set-aside/bb.example.com-host_old/thread-storage/notes.txt"), "utf8"), "kept\n", "its threads' files are kept");
  assert.ok(!existsSync(join(root, ".bb-machines/bb.example.com")), "BB's installer finds no folder of another machine");
  assert.ok(existsSync(join(root, ".bb-machines/other.example.com/host-id")), "the box's own machine's data stays");
  assert.ok(!existsSync(join(units, "bb-host-daemon-bb-example-com-host_old.service")));
  assert.ok(existsSync(join(units, "bb-host-daemon-other-example-com-host_mine.service")));
  assert.match(readFileSync(join(root, "systemctl.log"), "utf8"), /^--user disable --now bb-host-daemon-bb-example-com-host_old\.service\n--user daemon-reload\n$/);
  // Again: nothing more to do.
  assert.equal(run("host_mine"), "");
  // With no machine known yet, any machine's data is another's.
  assert.equal(run(null), `${root}/.bb-machines/other.example.com host_mine\n`);
});

test("before BB's installer, a box on an overlay root drops a pre-installed BB app of another build than the server's, and keeps the server's (#701)", () => {
  const root = tempDir("stale");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const server = "a".repeat(64);
  // stat says the root is an overlay, and curl gives the package's headers, as BB's server does.
  writeFileSync(join(bin, "stat"), `#!/bin/sh\necho "\${FAKE_FS:-overlayfs}"\n`);
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf 'HTTP/1.1 200 OK\\r\\nx-bb-artifact-sha256: ${server}\\r\\n\\r\\n'\n`);
  chmodSync(join(bin, "stat"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const app = (dir: string, digest: string) => {
    mkdirSync(join(root, ".bb-machines", dir, "npm/lib/node_modules/bb-app"), { recursive: true });
    writeFileSync(join(root, ".bb-machines", dir, "host-artifact.sha256"), `${digest}\n`);
  };
  const run = (fs?: string) => execFileSync("/bin/sh", ["-c", removeStaleApp("https://bb.example.com/")], { env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, ...(fs ? { FAKE_FS: fs } : {}) } });
  const has = (dir: string) => existsSync(join(root, ".bb-machines", dir, "npm/lib/node_modules/bb-app"));
  app("old", "b".repeat(64));
  app("current", server);
  run("ext2/ext3");
  assert.ok(has("old"), "a box whose root is not an overlay replaces its app in place, quickly");
  run();
  assert.deepEqual([has("old"), has("current")], [false, true]);
});

test("an enrolment that cannot reach BB's server says so, and how to fix it, before curl's words", () => {
  const curl = "Enrolling box quiet-oak failed: curl: (28) Failed to connect to bb.example port 443 after 10002 ms: Timeout was reached";
  assert.equal(
    withReachHint(curl, "Namespace"),
    `BB's server is not reachable from Namespace: turn the tailnet on in BB Box's settings, or give BB a URL its boxes can reach (docs/guide/tailnet.md). ${curl}`,
  );
  assert.equal(withReachHint("Enrolling box quiet-oak failed: exit 1", "Namespace"), "Enrolling box quiet-oak failed: exit 1");
});

test("box_acquire and box_start answer once an ios box's device has booted or come back, with its Device lines (063, 4.2)", async (t) => {
  const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" };
  const offer = { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "phone-18", runtime }, { model: "iPhone 17", native: "phone-17", runtime }] };
  const kind: BoxKind = { ...FAKE_KINDS[0]!, id: "ios", label: "iOS Simulator", capabilities: { ...FAKE_KINDS[0]!.capabilities, displays: [DEVICE_DISPLAY], device: offer as never } };
  const { harness, app, tool } = await start(undefined, { kinds: [kind] });
  t.after(() => harness.lifecycle.dispose());
  const state = {
    platform: "ios",
    model: "iPhone 17",
    power: { is: "booted", awake: true },
    geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1206, height: 2622 } },
    settings: { appearance: { known: false, why: "" }, textSize: { known: false, why: "" }, location: { set: null, at: null }, statusBar: { set: null, at: null } },
    at: 0,
  };
  Object.assign(app.devices, { recorded: () => undefined, view: () => ({ is: "connected", version: 5, protocol: 1, state }) });
  const acquired = text(await tool("box_acquire", { kind: "ios", device: "iPhone 17" }));
  assert.match(acquired, /\nDevice: iPhone 17, iOS 27\.0 \(24A434\), Xcode 27\.0, idb_companion 1\.7\.7\nDevice state: booted, upright, 1206x2622\n/);
  assert.match(acquired, /\nThe iPhone 17 booted \d+\.\d s after the box was ready\./);
  const box = await only(app);
  assert.ok(!isError(await tool("box_stop", { box: box.name })));
  const started = text(await tool("box_start", { box: box.name }));
  assert.match(started, /\nDevice: iPhone 17, iOS 27\.0 \(24A434\), Xcode 27\.0, idb_companion 1\.7\.7\nDevice state: booted, upright, 1206x2622\n/);
  assert.match(started, /\nThe iPhone 17 came back \d+\.\d s after the box was ready\./);
});

test("box_acquire of an android box says when its device's first boot in the box gave it its own Android ID, and not on a later boot (063, 5.1 and 6.2)", async (t) => {
  const runtime = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: null };
  const offer = { platform: "android", devices: [{ model: "Pixel 8", native: "pixel_8", runtime }, { model: "Pixel Fold", native: "pixel_fold", runtime }] };
  const kind: BoxKind = { ...FAKE_KINDS[0]!, id: "android", label: "Android emulator", capabilities: { ...FAKE_KINDS[0]!.capabilities, displays: [DEVICE_DISPLAY], device: offer as never } };
  const { harness, app, tool } = await start(undefined, { kinds: [kind] });
  t.after(() => harness.lifecycle.dispose());
  const unknown = { known: false, why: "" };
  const state = (power: unknown) => ({
    platform: "android",
    form: "phone",
    model: "Pixel 8",
    power,
    geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1080, height: 2400 } },
    settings: { appearance: unknown, fontScale: unknown, location: unknown, battery: unknown, network: unknown, statusBar: { set: null, at: null } },
    at: 0,
  });
  let views: unknown[] = [
    { is: "connected", version: 15, protocol: 1, state: state({ is: "booting", since: 0 }), bootedHere: [] },
    { is: "connected", version: 15, protocol: 1, state: state({ is: "booted", awake: true }), bootedHere: [] },
  ];
  Object.assign(app.devices, { recorded: () => undefined, view: () => (views.length > 1 ? views.shift() : views[0]) });
  const first = text(await tool("box_acquire", { kind: "android" }));
  assert.match(first, /\nThe Pixel 8 booted \d+\.\d s after the box was ready, about 8 s of it giving the device its own Android ID, as each device's first boot in a box does\./);
  views = [{ is: "connected", version: 15, protocol: 1, state: state({ is: "booted", awake: true }), bootedHere: ["Pixel 8"] }];
  const again = text(await tool("box_acquire", { kind: "android" }));
  assert.match(again, /\nThe Pixel 8 booted \d+\.\d s after the box was ready\./);
});

test("box_device sends a control with its own parameters only, answers in words with the state after it, and passes refusals on with what to do (063, 6.3)", async (t) => {
  const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" };
  const offer = { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "phone-18", runtime }, { model: "iPhone 17", native: "phone-17", runtime }] };
  const kind: BoxKind = { ...FAKE_KINDS[0]!, id: "ios", label: "iOS Simulator", capabilities: { ...FAKE_KINDS[0]!.capabilities, displays: [DEVICE_DISPLAY], device: offer as never } };
  const { harness, app, tool } = await start(undefined, { kinds: [kind, FAKE_KINDS[0]!] });
  t.after(() => harness.lifecycle.dispose());
  const state = {
    platform: "ios",
    model: "iPhone 18 Pro",
    power: { is: "booted", awake: true },
    geometry: { generation: 2, physical: "turned-left", content: "turned-left", video: { width: 2622, height: 1206 } },
    settings: { appearance: { known: true, value: "dark", at: 1, by: "bb-box" }, textSize: { known: true, value: "large", at: 1, by: "bb-box" }, location: { set: null, at: null }, statusBar: { set: null, at: 1 } },
    at: 0,
  };
  const sent: unknown[] = [];
  let answer: unknown = { id: "a", ok: true, ms: 312, state, result: { type: "done" } };
  Object.assign(app.devices, { recorded: () => undefined, view: () => ({ is: "connected", version: 7, protocol: 1, state }), control: async (_box: unknown, control: unknown) => (sent.push(control), answer) });
  assert.ok(!isError(await tool("box_acquire", { kind: "ios" })));
  const phone = (await app.boxes.list(THREAD)).find((box) => box.kind === "ios")!;
  const turned = await tool("box_device", { box: phone.name, action: "rotate", turn: "left" });
  assert.equal(text(turned), "Turned the iPhone 18 Pro left in 0.3 s. Now: booted, turned left, 2622x1206, dark, text size large.\n\nNext: Call box_status for the device's details.");
  const live = text(await tool("box_device", { box: phone.name, action: "status_bar", to: "live" }));
  assert.match(live, /^Made the iPhone 18 Pro's status bar live in 0\.3 s\. The status bar is live again, so the battery shows the Mac's\. Now: /);
  assert.deepEqual(sent, [{ action: "rotate", turn: "left" }, { action: "status_bar", to: "live" }]);
  const back = await tool("box_device", { box: phone.name, action: "back" });
  assert.ok(isError(back));
  assert.match(text(back), /: iOS has no back button\. The iPhone 18 Pro's actions are: home, lock, wake, rotate, .*\n\nNext: Call box_device with one of the actions it names\.$/);
  const extra = await tool("box_device", { box: phone.name, action: "appearance", to: "dark", latitude: 1 });
  assert.match(text(extra), /appearance does not take latitude\. appearance takes to: light or dark\./);
  assert.equal(sent.length, 2, "refusals of the parameters never reach the device");
  answer = { id: "b", ok: false, error: { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS }, state };
  const held = text(await tool("box_device", { box: phone.name, action: "home" }));
  assert.match(held, /A person has control of this box's device\. .* The iPhone 18 Pro is booted, turned left, .*\n\nNext: Leave the device alone until the person hands control back/);
  assert.ok(!isError(await tool("box_acquire", { kind: FAKE_KINDS[0]!.id })));
  const plain = (await app.boxes.list(THREAD)).find((box) => box.kind !== "ios")!;
  assert.match(text(await tool("box_device", { box: plain.name, action: "home" })), /has no device: box_device works on ios and android boxes\./);
});

test("box_acquire and bb box acquire take a device, refuse it on other kinds, and refuse a device kind no backend offers (063)", async (t) => {
  const { harness, app, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  const ios = await tool("box_acquire", { kind: "ios" });
  assert.ok(isError(ios));
  assert.match(text(ios), /^No backend offers ios boxes \(iOS Simulator\) now\. The kinds you can acquire are: linux, linux-desktop\.\n\nNext: Call box_list to see the kinds you can acquire\.$/);
  const linux = await tool("box_acquire", { kind: "linux", device: "iPhone 18 Pro" });
  assert.ok(isError(linux));
  assert.match(text(linux), /A linux box has no device\. device is only for ios and android boxes, such as iPhone 18 Pro or Pixel 8\./);
  const wrong = await tool("box_acquire", { kind: "android", device: "iPhone 17" });
  assert.match(text(wrong), /The iPhone 17 is an iOS device, not an Android one\. The Android devices are: Pixel 8, Pixel Fold, Pixel Tablet\.\n\nNext: Pick one of the devices this names, or leave device out for the kind's first\.$/);
  const cli = await harness.behavior.runCli(["acquire", "linux", "--thread", THREAD, "--device", "Pixel 8"]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stderr ?? "", /A linux box has no device\..*\(unsupported\)/s);
  const cliIos = await harness.behavior.runCli(["acquire", "ios", "--thread", THREAD, "--device", "iPhone 17"]);
  assert.equal(cliIos.exitCode, 1);
  assert.match(cliIos.stderr ?? "", /No backend offers ios boxes \(iOS Simulator\) now\..*\(unknown_kind\)/s);
  const asked: string[] = [];
  Object.assign(app.backends.active()[0]!, {
    withheldKinds: async (kind: string) => (asked.push(kind), kind === "ios" ? [{ kind: "ios", why: "the Mac did not answer.", passing: true }] : []),
  });
  const withheld = await tool("box_acquire", { kind: "ios" });
  assert.match(text(withheld), /^No ios box \(iOS Simulator\) can come now\. .+ offers them, but not now: the Mac did not answer\.\n\nNext: Try again later/);
  const cliWithheld = await harness.behavior.runCli(["acquire", "ios", "--thread", THREAD]);
  assert.match(cliWithheld.stderr ?? "", /No ios box \(iOS Simulator\) can come now\..*the Mac did not answer\..*\(no_capacity\)/s);
  assert.deepEqual(await app.boxes.list(THREAD), [], "nothing was acquired");
  const list = text(await tool("box_list", {}));
  assert.match(list, /\n\nKinds you cannot acquire now:\n- ios: iOS Simulator\. Not now: .+ offers them, but not now: the Mac did not answer\.\n\nNext:/, "box_list names a kind a backend withholds, with why");
  assert.doesNotMatch(list, /\bandroid\b|Devices:/, "and no kind no backend offers");
  const offered = new Set(app.boxes.kinds().map((kind) => kind.id));
  assert.ok(!isError(await tool("box_acquire", { kind: "linux" })), "a box with no device is as before");
  assert.ok(asked.every((kind) => !offered.has(kind)), "a backend is asked only for a kind no backend offers");
  assert.deepEqual(asked.filter((kind) => kind === "ios"), ["ios", "ios", "ios"], "by acquire twice, then by box_list");
});
