// The plugin in SDK's fake plugin host, with the fake backend: the agent
// tools, enrolment as a BB machine, thread events, the panel's RPC, the CLI
// and settings.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import type { PluginAgentToolResult, PluginSettingValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BackendDriver } from "../src/backends/types.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { setup } from "../src/plugin/setup.ts";
import { boxPath, workspacePath } from "../src/plugin/tools.ts";
import { FakeBackend } from "./fake-backend.ts";
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

/** A backend driver for the fake backend, switched on by "fake-enabled". "fake-broken" makes its settings wrong. */
function fakeDriver(root: string, world: { backend: FakeBackend | null }): BackendDriver<Record<string, never>> {
  return {
    type: "fake",
    label: "Fake host",
    nature: "virtual",
    settings: {
      "fake-enabled": { type: "boolean", label: "Fake host", description: "Use the fake host.", default: false },
      "fake-broken": { type: "boolean", label: "Broken", description: "Make the settings wrong.", default: false },
    },
    setup: { guide: "setup/fake/README.md", scripts: ["setup/fake/host.sh"] },
    parse(values) {
      if (values["fake-enabled"] !== true) return { enabled: false };
      if (values["fake-broken"] === true) return { enabled: true, ok: false, problems: ["Fill in the fake host's address."] };
      return { enabled: true, ok: true, config: {} };
    },
    create: (_config, context) => (world.backend = new FakeBackend({ root, storage: context.storage, installId: context.installId })),
  };
}

function variables(names: readonly string[]) {
  return names.map((name) => ({ name, note: null, secret: true as const, value: null }));
}

/**
 * `daemonParent` stands in for BB's daemon in the boxes. The fake boxes run
 * on this machine as its user, so it must never match BB's real daemon here.
 */
async function start(settings: Record<string, PluginSettingValue> = { "fake-enabled": true }, options: { daemonParent?: string } = {}) {
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
    /** Host calls, in order, to check a machine is removed before its box. */
    events: [] as string[],
    /** Makes threads.get fail with this error, such as a network error. */
    threadsError: null as Error | null,
    /** Makes threads.get fail for one thread. */
    threadErrors: new Map<string, Error>(),
  };
  const { bb, harness } = createFakePluginHost({
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
      },
      environments: {
        get: async () => ({ id: "env_one", hostId: "host-workspace", path: workspace }) as never,
      },
      system: {
        machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, variables: variables(["MACHINE_VAR"]) }),
      },
      projects: {
        machineEnvironment: async ({ projectId }: { projectId: string }) => ({
          builtInGit: { status: "logged in", statusMessage: "" },
          inheritedVariables: variables(["MACHINE_VAR"]),
          variables: variables(projectId === PROJECT ? ["PROJECT_VAR"] : []),
        }),
      },
      hosts: {
        // Like BB: records the machine, then calls the provider's create in the background.
        experimental_create: async ({ key, inputs }: { key: string; inputs: { boxId: string } }) => {
          const id = `host-${key}`;
          const host = makeHostResponse({ id, status: "disconnected", machineProviderId: "bb-box" });
          hosts.set(id, { ...host, lifecycle: { ...host.lifecycle, phase: "creating" } });
          world.events.push(`create ${id}`);
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
                ? { ...current, name: result.name, status: "connected", lifecycle: { ...current.lifecycle, phase: "active" } }
                : { ...current, lifecycle: { ...current.lifecycle, phase: "destroyed", message: result.message } },
            );
          })();
          return hosts.get(id)!;
        },
        get: async ({ hostId }: { hostId: string }) => {
          const host = hosts.get(hostId);
          if (!host) throw notFound("Host");
          return host;
        },
        delete: async ({ hostId }: { hostId: string }) => {
          world.events.push(`delete ${hostId}`);
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
    // BB's installer, in brief: it runs a command in the box through the executor.
    machineBootstrap: {
      async bootstrap({ key, executor, signal }) {
        world.bootstraps.push(key);
        const { exitCode } = await executor.exec({ command: ["sh", "-c", "echo installed > bb-installed"], timeoutMs: 10_000, signal, stdin: "", onOutput: () => {} });
        if (exitCode !== 0) throw new Error(`The installer exited with ${exitCode}.`);
        return { hostId: `host-${key}` };
      },
    },
  });
  const app = await setup(bb, { drivers: [fakeDriver(root, world)], daemonParent: options.daemonParent ?? join(root, "no-daemon") });
  const tool = (name: string, input: unknown, threadId = THREAD) => harness.behavior.callAgentTool(name, input, { threadId, projectId: PROJECT });
  return { bb, harness, app, world, tool };
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
  assert.equal(box.kind, "linux-headless");
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
  assert.match(text(listed), new RegExp(`- ${box.name}: Linux headless \\(linux-headless\\), ready`));
  assert.match(text(listed), /Kinds:\n- linux-headless/);

  const released = await tool("box_release", { box: box.name });
  assert.match(text(released), new RegExp(`Released box ${box.name}`));
  assert.deepEqual(await app.boxes.list(THREAD), []);
  assert.match(text(await tool("box_list", {})), /This thread has no boxes/);
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

  // box_acquire waits for enrolment, as box_run would, and says how long it took.
  const acquired = text(await tool("box_acquire", { kind: "linux-headless" }));
  assert.match(acquired, /BB machine: enrolled/);
  assert.match(acquired, /Timings: .*total \d+\.\d s, BB enrolment \d+\.\d s/);
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

  // BB's installer ran in the box, and commands see the box's identity.
  const installed = await tool("box_run", { box: box.name, command: 'cat bb-installed; echo "$BB_BOX_NAME $BB_THREAD_ID $BB_HOST_ID"' });
  assert.match(text(installed), new RegExp(`installed\n${box.name} ${THREAD} host-${box.id}`));
  assert.match(text(await tool("box_status", { box: box.name })), /BB machine: enrolled\n.*BB enrolment \d+\.\d s/);
  assert.match(text(await tool("box_list", {})), /enrolled as a BB machine in \d+\.\d s/);

  // Commands take the listed variables from BB's daemon, and nothing else.
  const access = await tool("box_run", { box: box.name, command: 'printf "%s|" "${GH_TOKEN:+token}" "$MACHINE_VAR" "$PROJECT_VAR" "${UNLISTED-unset}"' });
  assert.match(text(access), /stdout:\ntoken\|value-machine\|value-project\|unset\|/);
  // So do SSH commands, through ~/.bashrc, and git asks gh for GitHub credentials.
  const shells = await tool("box_run", {
    box: box.name,
    command: 'head -n 1 .bashrc; bash -c \'unset MACHINE_VAR; . ~/.bashrc; printf "%s\\n" "$MACHINE_VAR"\'; git config --global --get-all credential.https://github.com.helper',
  });
  assert.match(text(shells), /stdout:\n# Added by bb-box: .*\nvalue-machine\n(.*\n)*.*gh auth git-credential/);

  await tool("box_release", { box: box.name });
  assert.deepEqual(world.events, [`create host-${box.id}`, `delete host-${box.id}`]);
  assert.equal(world.hosts.size, 0);
  assert.deepEqual(world.backend!.calls.filter((call) => call.startsWith("release")).length, 1);
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

test("enrolment can be switched off", async (t) => {
  const { harness, app, world, tool } = await start({ "fake-enabled": true, "enrol-boxes": false });
  t.after(() => harness.lifecycle.dispose());

  await tool("box_acquire", {});
  assert.equal((await only(app)).enrol.state, "off");
  assert.equal(world.hosts.size, 0);
});

test("archiving or deleting a thread releases its boxes", async (t) => {
  const { harness, app, world, tool } = await start();
  t.after(() => harness.lifecycle.dispose());
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT }));

  await tool("box_acquire", {});
  await tool("box_acquire", {}, "thr_two");
  await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: THREAD, archivedAt: Date.now() }) });
  await until("the archived thread's box to go", async () => (await app.boxes.list(THREAD)).length === 0);
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_two" }) });
  await until("the deleted thread's box to go", async () => (await app.boxes.list("thr_two")).length === 0);
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
  world.threads.set("thr_two", makeThreadResponse({ id: "thr_two", projectId: PROJECT, archivedAt: Date.now() }));
  world.threads.set("thr_three", { ...makeThreadResponse({ id: "thr_three", projectId: PROJECT }), deletedAt: undefined } as unknown as Thread);
  world.threadErrors.set("thr_three", Object.assign(new Error("HTTP 404: Not Found"), { status: 404 }));

  const swept = (await harness.behavior.runCli(["sweep"])).stdout ?? "";
  assert.match(swept, /Boxes restored from their guests: 1/);
  assert.match(swept, /Leftover guests removed: 1/);
  assert.match(swept, /Guests kept until BB says whether their thread ended: 1/);

  const restored = (await app.boxes.list(THREAD))[0]!;
  assert.equal(restored.id, live!.id);
  assert.equal(restored.name, live!.name);
  assert.equal(restored.kind, live!.kind);
  assert.equal(restored.projectId, PROJECT);
  assert.equal(restored.state, "ready");
  assert.equal(restored.error, null);
  assert.deepEqual(restored.guest, live!.guest);
  const result = await tool("box_run", { box: live!.name, command: "cat work.txt" });
  assert.match(text(result), /kept/);
  assert.deepEqual(await app.boxes.list("thr_two"), [], "the archived thread's guest went");
  assert.deepEqual(await app.boxes.list("thr_three"), [], "no record until BB answers");
  const held = (await world.backend!.held()).map((guest) => guest.owner?.boxId).sort();
  assert.deepEqual(held, [live!.id, unsure!.id].sort());
  assert.ok(!held.includes(ended!.id));
  const logs = harness.inspection.logEntries.map((entry) => entry.message);
  assert.ok(logs.some((line) => line.startsWith(`Restored box ${live!.name} of thread ${THREAD}`)), "the restore is logged");
  assert.ok(logs.some((line) => line.includes(`${ended!.id}, which no box records: its box's thread thr_two was archived or deleted`)));
  assert.ok(logs.some((line) => line.startsWith(`Kept guest`) && line.includes(unsure!.id)));

  world.threadErrors.clear();
  assert.match((await harness.behavior.runCli(["sweep"])).stdout ?? "", /Boxes restored from their guests: 1/);
  assert.equal((await app.boxes.list("thr_three"))[0]?.id, unsure!.id, "restored once BB answers");
});

test("refusals say what to do next", async (t) => {
  const { harness, tool } = await start();
  t.after(() => harness.lifecycle.dispose());

  const missing = await tool("box_run", { box: "nope", command: "true" });
  assert.ok(isError(missing));
  assert.match(text(missing), /This thread has no box "nope". It has no boxes.\n\nNext: Call box_list/);
  const kind = await tool("box_acquire", { kind: "linux-mainframe" });
  assert.ok(isError(kind));
  assert.match(text(kind), /There is no "linux-mainframe" kind. The kinds are: linux-headless, linux-desktop.\n\nNext: Call box_list/);
  const desktop = await tool("box_acquire", { kind: "linux-headless" });
  const name = /Box (\S+) \(/.exec(text(desktop))![1]!;
  const noDesktop = await tool("box_run", { box: name, command: "true", desktop: true });
  assert.match(text(noDesktop), /has no desktop/);
});

test("with no backend on, the plugin asks for its settings, and a change takes effect at once", async (t) => {
  const { harness, app, tool } = await start({});
  t.after(() => harness.lifecycle.dispose());

  assert.deepEqual(harness.inspection.needsConfigurationMessages, ["Turn on a backend in bb-box's settings, then fill in its settings."]);
  assert.match(text(await tool("box_list", {})), /No backend is set up/);
  const refused = await tool("box_acquire", {});
  assert.match(text(refused), /No backend is set up, so there are no boxes to acquire/);

  await harness.behavior.setSettings({ "fake-enabled": true });
  await until("the backend", async () => app.kinds().length > 0);
  assert.ok(harness.inspection.realtimeSignals.some((signal) => signal.channel === "changed"));
  assert.ok(!isError(await tool("box_acquire", {})));
});

test("wrong settings are named in the status and the doctor", async (t) => {
  const { harness } = await start({ "fake-enabled": true, "fake-broken": true });
  t.after(() => harness.lifecycle.dispose());

  assert.deepEqual(harness.inspection.needsConfigurationMessages, ["Fake host: Fill in the fake host's address."]);
  const doctor = await harness.behavior.runCli(["doctor"]);
  assert.equal(doctor.exitCode, 1);
  assert.match(doctor.stdout ?? "", /Fake host: Its settings need fixing.\n {2}\[fail\] Settings: Fill in the fake host's address./);
});

test("the panel lists, acquires, stops, starts and releases boxes over RPC", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());

  const empty = (await harness.behavior.callRpc("state", { threadId: THREAD })) as { boxes: unknown[]; kinds: { id: string }[]; backends: { type: string; state: string; setup: { guide: string } }[] };
  assert.deepEqual(empty.boxes, []);
  assert.deepEqual(empty.kinds.map((kind) => kind.id), ["linux-headless", "linux-desktop"]);
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

test("bb box lists kinds and boxes, and acquires and releases for the thread it runs in", async (t) => {
  const { harness, app } = await start();
  t.after(() => harness.lifecycle.dispose());

  const kinds = await harness.behavior.runCli(["kinds"]);
  assert.match(kinds.stdout ?? "", /^linux-headless: Linux headless, 1 core, from Fake host/);
  const acquired = await harness.behavior.runCli(["acquire", "linux-headless", "--thread", THREAD]);
  assert.equal(acquired.exitCode, 0, acquired.stderr);
  const box = await only(app);
  assert.match(acquired.stdout ?? "", new RegExp(`Box ${box.name}`));
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

  await harness.behavior.runCli(["acquire", "linux-headless", "--thread", THREAD]);
  const box = await only(app);
  const refused = await harness.behavior.runCli(["install-id", "--set", "old-install"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", new RegExp(`Release ${box.name} first\\. Its guest carries this install's ID ${id}`));
  assert.equal(app.backends.installId, id);

  await harness.behavior.runCli(["release", box.name, "--thread", THREAD]);
  const before = world.backend;
  const set = await harness.behavior.runCli(["install-id", "--set", "old-install"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout ?? "", /^This install's ID is now old-install\. The next sweep restores the boxes of the guests that carry it/);
  assert.equal(await bb.storage.kv.get("install-id"), "old-install");
  assert.notEqual(world.backend, before, "the backend is made again with the ID");
  assert.deepEqual(JSON.parse((await harness.behavior.runCli(["install-id", "--json"])).stdout ?? ""), { installId: "old-install" });
});
