// The plugin in SDK's fake plugin host, with the fake backend: the agent
// tools, enrolment as a BB machine, thread events, the panel's RPC, the CLI
// and settings.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import type { PluginAgentToolResult, PluginSettingValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { DRIVERS } from "../src/backends/index.ts";
import type { BackendDriver } from "../src/backends/types.ts";
import { OPERATOR, SPARES, type BoxRecord } from "../src/core/boxes.ts";
import { setDesktopSize } from "../src/core/rfb.ts";
import { Phases } from "../src/plugin/enrol.ts";
import { RETIRED_TITLE } from "../src/plugin/holder.ts";
import { setup, type SetupOptions } from "../src/plugin/setup.ts";
import { boxPath, workspacePath } from "../src/plugin/tools.ts";
import { PAUSED, RETURNED } from "../src/core/computer.ts";
import { FAKE_PWSH, FAKE_WINDOWS_KIND, FakeBackend, fakeDriver, type FakeBackendOptions } from "./fake-backend.ts";
import { tasksDesktop, type FakeDesktop } from "./fake-cua.ts";
import { fakeDaemon, tempDir } from "./helpers.ts";

const THREAD = "thr_one";
const PROJECT = "prj_one";

type Host = ReturnType<typeof makeHostResponse>;
type Thread = ReturnType<typeof makeThreadResponse>;

/** BB's file API refuses a relative path. */
function absolute(path: string): string {
  if (!isAbsolute(path)) throw Object.assign(new Error("HTTP 400: Path must be absolute"), { status: 400 });
  return path;
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
  options: { daemonParent?: string; computer?: SetupOptions["computer"]; drivers?: readonly BackendDriver<any>[]; variablesWaitMs?: number; providerRetryMs?: number; controlReconnectMs?: number; controlStaleMs?: number } & Pick<FakeBackendOptions, "resize" | "minSize" | "kinds" | "shell"> = {},
) {
  const root = tempDir("plugin");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const threads = new Map<string, Thread>([[THREAD, makeThreadResponse({ id: THREAD, projectId: PROJECT, environmentId: "env_one" })]]);
  const hosts = new Map<string, Host>();
  const world = {
    root,
    workspace,
    threads,
    hosts,
    backend: null as FakeBackend | null,
    /** Keys BB's bootstrap ran with, in order. */
    bootstraps: [] as string[],
    /** The script BB's installer runs in the box. */
    installer: "echo installed > bb-installed",
    /** BB's machine calls never answer, as for a plugin that is stopping. */
    silent: false,
    /** How many more machine creates BB refuses, not knowing bb-box's provider, as while the plugin restarts. */
    unknownProvider: 0,
    /** BB's built-in Git: "logged in" when it gives machines GH_TOKEN. */
    git: "logged in" as "logged in" | "not logged in" | "disabled" | "overridden",
    /** Host calls, in order, to check a machine is removed before its box. */
    events: [] as string[],
    /** Makes threads.get fail with this error, such as a network error. */
    threadsError: null as Error | null,
    /** Makes threads.get fail for one thread. */
    threadErrors: new Map<string, Error>(),
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
    /** How many threads run on each machine, by host ID. */
    hostThreads: new Map<string, number>(),
    /** BB's terminal sessions, by ID. */
    terminals: new Map<string, { id: string; hostId: string; title: string; command: string; status: "starting" | "running" | "exited"; createdAt: number }>(),
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
        spawn: async (args: unknown) => {
          world.spawned.push(args);
          return makeThreadResponse({ id: `thr_child${world.spawned.length}`, projectId: PROJECT });
        },
      },
      environments: {
        get: async () => ({ id: "env_one", hostId: world.workspaceHost, path: workspace }) as never,
      },
      terminals: {
        list: async ({ scope }: { scope: { hostId: string } }) => ({
          sessions: [...world.terminals.values()].filter((session) => session.hostId === scope.hostId).map((session) => terminal(session.id)),
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
          return { builtInGit: { status: world.git, statusMessage: "" }, variables: variables(["MACHINE_VAR"]) };
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
            inheritedVariables: variables(["MACHINE_VAR"]),
            variables: variables(projectId === PROJECT ? ["PROJECT_VAR"] : []),
          };
        },
      },
      hosts: {
        // Like BB: records the machine, then calls the provider's create in
        // the background. A key whose machine BB still has gets it back.
        experimental_create: async ({ key, inputs }: { key: string; inputs: { boxId: string } }) => {
          const id = `host-${key}`;
          world.events.push(`create ${id}`);
          if (world.unknownProvider > 0) {
            world.unknownProvider--;
            throw Object.assign(new Error('HTTP 400: Unknown machine provider "bb-box"'), { status: 400 });
          }
          const existing = hosts.get(id);
          if (existing && existing.lifecycle.phase !== "destroyed") return existing;
          const host = makeHostResponse({ id, status: "disconnected", machineProviderId: "bb-box" });
          hosts.set(id, { ...host, lifecycle: { ...host.lifecycle, phase: "creating" } });
          void (async () => {
            const provider = harness.inspection.registrations.machineProviders.get("bb-box")!;
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
        read: async ({ path }: { path: string }) => {
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
        const { exitCode } = await executor.exec({ command: ["sh", "-c", world.installer], timeoutMs: 10_000, signal, stdin: "", onOutput: () => {} });
        if (exitCode !== 0) throw new Error(`The installer exited with ${exitCode}.`);
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
    drivers: [fakeDriver(root, world, { resize: options.resize, minSize: options.minSize, kinds: options.kinds, shell: options.shell }), ...(options.drivers ?? [])],
    daemonParent: options.daemonParent ?? join(root, "no-daemon"),
    computer: options.computer,
    variablesWaitMs: options.variablesWaitMs,
    providerRetryMs: options.providerRetryMs,
    controlReconnectMs: options.controlReconnectMs,
    controlStaleMs: options.controlStaleMs,
  };
  const app = await setup(bb, setupOptions);
  const tool = (name: string, input: unknown, threadId = THREAD) => harness.behavior.callAgentTool(name, input, { threadId, projectId: PROJECT });
  return { bb, harness, app, world, tool, setupOptions };
}

function text(result: PluginAgentToolResult): string {
  return typeof result === "string" ? result : result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

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
  assert.match(text(copiedIn), new RegExp(`Copied ${join(world.workspace, "input.txt")} \\(19 bytes\\) to input.txt in box`));
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

test("without GitHub in BB, a new box does not wait for GH_TOKEN: its git identity ends the enrolment's wait", async (t) => {
  const connected = join(tempDir("connected"), "connected");
  const identity = { GIT_AUTHOR_NAME: "A Person", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A Person", GIT_COMMITTER_EMAIL: "a@example.com" };
  const daemon = await fakeDaemon([identity], { startOn: { file: connected, seconds: 0.5 } });
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
  const run = await tool("box_run", { box: box.name, command: 'printf "%s|" "${GH_TOKEN:-none}"; git var GIT_AUTHOR_IDENT' });
  assert.match(text(run), /stdout:\nnone\|A Person <a@example\.com> /);
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
  await harness.lifecycle.reload(async (bb) => {
    restarted = await setup(bb, setupOptions);
  });
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
    ((await harness.behavior.callRpc("desktops", null)) as { threadId: string; box: { id: string } }[]).map((entry) => [entry.threadId, entry.box.id]),
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
  assert.deepEqual(await harness.behavior.callRpc("desktop", { threadId: THREAD, box: box.id }), { box: null, desktopPath: state.desktopPath, terminalPath: "/api/v1/plugins/bb-box/http/terminal" });
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
  await until("the latest resize", async () => backend.resizes.length === 2 && backend.resizing === 0);
  assert.deepEqual(backend.resizes.at(-1), { width: 1600, height: 1000 }, "the latest waiting request replaced the one before");
  assert.equal(backend.mostResizing, 1);
  assert.deepEqual([backend.rfb.width, backend.rfb.height], [1600, 1000]);

  await session.receive(setDesktopSize(518, 722, screen));
  await until("the smallest size", async () => backend.resizes.length === 3 && backend.resizing === 0);
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
  assert.deepEqual(await harness.behavior.callRpc("desktops", null), []);
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
async function desktopBox(options: { computer?: SetupOptions["computer"] } = {}) {
  const started = await start(undefined, { computer: { pauseWaitMs: 300, desktopWaitMs: 300, ...options.computer } });
  await started.harness.behavior.callRpc("acquire", { threadId: THREAD, kind: "linux-desktop" });
  await started.app.boxes.idle();
  const box = await only(started.app);
  const file = desktopFile(started.world, box);
  writeFileSync(file, JSON.stringify(tasksDesktop()));
  return { ...started, box, file };
}

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
  assert.match(typed, /^Typed 8 characters into e\d+ \(text 'New task'\), with the real keyboard \(the desktop's focus may have moved\)\./);
  assert.match(typed, new RegExp(`${field} now reads: \\[${field}\\] text "New task" value="Buy milk"`));
  const types = readDesktop(file).calls.filter((call) => call.tool === "type_text").map((call) => call.args.delivery_mode);
  assert.deepEqual(types, ["background", "foreground"]);

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
