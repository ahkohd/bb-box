import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NamespaceBackend } from "../src/backends/namespace/backend.ts";
import { WORKSPACE_FROM_METADATA, linuxImageBuildScript, linuxImageFingerprint, linuxImageKey } from "../src/backends/namespace/linux-images.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace } from "./fake-namespace.ts";
import { Tailnet } from "../src/core/tailnet.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG = { token: FAKE_NAMESPACE_TOKEN, region: "us" as const, macosVersion: "26.x", machines: 2, longestLifeHours: 4, largestMachine: null };

function setup(options: { failBuild?: boolean; slowBuild?: boolean; app?: () => string | null } = {}) {
  fakeSsh();
  let now = Date.parse("2030-01-01T00:00:00Z");
  const fake = new FakeNamespace({ now: () => now, lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const dir = mkdtempSync(join(tmpdir(), "ns-images-"));
  const received = join(dir, "received");
  const finishBuild = join(dir, "finish");
  const app = options.app ?? (() => "a".repeat(64));
  const context = { ...testContext(new MemoryStorage(), "inst1"), bbUrl: () => "https://bb.example", images: { bbApp: async () => app() } } as never;
  const backend = new NamespaceBackend(CONFIG, context, {
    fetch: fake.fetch,
    sshBinary: FAKE_SSH_BINARY,
    sleep: async () => {},
    readyTimeoutMs: 20_000,
    now: () => now,
    setupArchive: async () => Buffer.from("the setup scripts"),
    linuxImageScript: (target, key, bbUrl) =>
      options.failBuild
        ? `cat > ${received}; echo "step 1" >&2; echo "build.sh: no space left" >&2; exit 1`
        : `cat > ${received}; printf '%s %s\\n' ${target} '${bbUrl}' >> ${received}.calls; ${options.slowBuild ? `while [ ! -e ${finishBuild} ]; do sleep 0.02; done; ` : ""}echo "nscr.io/ws1/bbbox/${target}:${key}"`,
  });
  const building = async () => {
    for (let wait = 0; !existsSync(`${received}.calls`) && wait < 500; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(`${received}.calls`), "the build started");
  };
  return { fake, backend: disposed(backend), received, advance: (ms: number) => (now += ms), building, finish: () => writeFileSync(finishBuild, "") };
}

test("a Linux image is built once in a Linux instance of its own, from bb-box's setup scripts, pushed to the workspace's registry and recorded, and the instance destroyed", async () => {
  const { fake, backend, received } = setup();
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([backend.linuxImages.forBox("linux", signal), backend.linuxImages.forBox("linux", signal)]);
  assert.equal(first.ref, second.ref, "two boxes asking at once share one build");
  assert.match(first.ref, /^nscr\.io\/ws1\/bbbox\/linux:[0-9a-f]{12}-aaaaaaaaaaaa$/);
  assert.equal(readFileSync(received, "utf8"), "the setup scripts", "the setup scripts go to the instance on its input");
  assert.equal(readFileSync(`${received}.calls`, "utf8"), "linux https://bb.example\n");
  const created = fake.calls.filter((call) => call.method === "CreateInstance");
  assert.equal(created.length, 1);
  const instance = [...fake.instances.values()][0]!;
  assert.equal(instance.shape.os, "linux");
  assert.deepEqual([instance.shape.virtualCpu, instance.shape.memoryMegabytes], [8, 16384]);
  assert.deepEqual(instance.labels, { "bbbox-install": "inst1", "bbbox-role": "image-build", "bbbox-target": "linux" });
  assert.equal(instance.status, "DESTROYED");
  assert.equal(await backend.linuxImages.whyBuild("linux"), null);
  await backend.linuxImages.forBox("linux", signal);
  assert.equal(fake.calls.filter((call) => call.method === "CreateInstance").length, 1, "a current image is used as it is");
});

test("an image is due again when the setup scripts or BB's app change, or after a week, but only if a box used it in the last week; a box waits only for a new setup", async () => {
  let app = "a".repeat(64);
  const { fake, backend, advance } = setup({ app: () => app });
  const signal = new AbortController().signal;
  await backend.linuxImages.forBox("linux", signal);
  app = "b".repeat(64);
  assert.equal(await backend.linuxImages.whyBuild("linux"), "BB's app changed");
  await backend.linuxImages.forBox("linux", signal);
  assert.equal(fake.calls.filter((call) => call.method === "CreateInstance").length, 1, "a box does not wait for a new app: the old image updates BB's app as it enrols");
  assert.deepEqual(await backend.linuxImages.due(), [{ target: "linux", why: "BB's app changed" }]);
  assert.deepEqual(await backend.linuxImages.due().then((due) => due.map((each) => each.target)), ["linux"], "desktops no box used are not built");
  advance(8 * 24 * 3_600_000);
  assert.deepEqual(await backend.linuxImages.due(), [], "an image no box used for a week is left as it is");
  assert.equal(linuxImageKey("abc", null), "abc-noapp");
  assert.match(linuxImageFingerprint(), /^[0-9a-f]{12}$/);
});

test("a build that fails destroys its instance and says the build's last lines; build instances are not boxes", async () => {
  const { fake, backend } = setup({ failBuild: true });
  await assert.rejects(backend.linuxImages.forBox("desktop", new AbortController().signal), /The desktop image did not build in Namespace's instance \S+: step 1 \/ build\.sh: no space left/);
  assert.equal([...fake.instances.values()][0]!.status, "DESTROYED");
  fake.instances.set("building", { ...[...fake.instances.values()][0]!, id: "building", status: "RUNNING" });
  assert.deepEqual(await backend.held(), [], "a build instance is not a box's guest, so the sweep leaves it to its build");
  assert.match((await backend.doctor()).checks.find((check) => check.id === "namespace.images")!.detail, /Building now: building \(desktop, 0 min old\)\.$/, "the doctor shows a build machine that is running");
  assert.equal((await backend.capacity("macos", { cores: 4, memoryMiB: 8192, diskGiB: null }, [])).hosts[0]?.limits[0]?.used, 0, "nor does it count as a machine");
});

test("a box released while its image builds, the only one waiting, stops the build: its instance is destroyed, nothing is recorded, and the next box builds it again", async () => {
  const { fake, backend, building, finish } = setup({ slowBuild: true });
  const released = new AbortController();
  const first = backend.linuxImages.forBox("desktop", released.signal);
  await building();
  released.abort(new Error("released"));
  await assert.rejects(first, /released/);
  for (let wait = 0; backend.linuxImages.building("desktop") && wait < 500; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(backend.linuxImages.building("desktop"), false);
  assert.deepEqual([...fake.instances.values()].map((instance) => instance.status), ["DESTROYED"]);
  assert.equal(await backend.linuxImages.record("desktop"), undefined);
  finish();
  const next = await backend.linuxImages.forBox("desktop", new AbortController().signal);
  assert.match(next.ref, /^nscr\.io\/ws1\/bbbox\/desktop:/);
  assert.equal(fake.calls.filter((call) => call.method === "CreateInstance").length, 2);
});

test("two boxes share one build, and one released while it builds leaves the build to the other", async () => {
  const { fake, backend, building, finish } = setup({ slowBuild: true });
  const released = new AbortController();
  const first = backend.linuxImages.forBox("desktop", released.signal);
  const second = backend.linuxImages.forBox("desktop", new AbortController().signal);
  await building();
  released.abort(new Error("released"));
  await assert.rejects(first, /released/);
  assert.equal(backend.linuxImages.building("desktop"), true, "the other box still waits for it");
  finish();
  assert.match((await second).ref, /^nscr\.io\/ws1\/bbbox\/desktop:/);
  assert.equal(fake.calls.filter((call) => call.method === "CreateInstance").length, 1);
});

test("the build script reads the workspace from Namespace's metadata, builds with build.sh and pushes, and prints only the image's name on its output", () => {
  const script = linuxImageBuildScript("desktop-wayland", "abc-def", "https://bb.example");
  assert.match(script, /tar -xzf - -C "\$work"/);
  assert.match(script, /bash "\$work\/setup\/docker\/build\.sh" --bb-url 'https:\/\/bb\.example' --tag "\$ref" desktop-wayland >&2/);
  assert.match(script, /docker push -q "\$ref" >&2\necho "\$ref"$/);
});

test("the workspace's ID is the value of tenant_id in Namespace's metadata, without its prefix, not the key's own name", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-meta-"));
  writeFileSync(join(dir, "metadata.json"), '{\n  "instance_id": "abc12",\n  "tenant_id": "tenant_oeigur8bob9pm",\n  "other": "tenant_id"\n}\n');
  const workspace = execFileSync("sh", ["-c", `${WORKSPACE_FROM_METADATA}\nprintf %s "$workspace"`], { encoding: "utf8", env: { ...process.env, NSC_METADATA_FILE: join(dir, "metadata.json") } });
  assert.equal(workspace, "oeigur8bob9pm");
});

test("with the tailnet on, a build machine joins it with a one-off key of its own before the build, as BB's app comes from BB's server, then leaves it, its device removed, before it is destroyed", async () => {
  fakeSsh();
  const dir = mkdtempSync(join(tmpdir(), "ns-build-tailnet-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  tool("tailscale", `printf '%s\\n' "tailscale $*" >> ${log}\ncase "$1" in up) f=$(printf '%s' "$2" | sed 's/^--auth-key=file://'); printf 'key %s\\n' "$(cat "$f")" >> ${log};; ip) echo 100.64.0.9;; esac`);
  tool("sudo", `[ "$1" = -n ] && shift\nexec "$@"`);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const minted: string[] = [];
  const removed: string[] = [];
  const tailnet = new Tailnet({
    credentials: { clientId: "id", clientSecret: "secret" },
    fetch: async (url, init) => {
      const at = new URL(url).pathname;
      const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (at === "/api/v2/oauth/token") return reply({ access_token: "tok", expires_in: 3600 });
      if (at === "/api/v2/tailnet/-/keys") return minted.push(JSON.parse(init.body!).description), reply({ id: "k1", key: "tskey-auth-one-off-build", expires: "2030-01-01T00:10:00Z" });
      if (at === "/api/v2/tailnet/-/devices") return reply({ devices: [{ nodeId: "n-build", hostname: "bb-box-ns-inst1-build-linux", tags: ["tag:bb-box"] }, { nodeId: "n-other", hostname: "bb-box-ns-inst1-box-b1", tags: ["tag:bb-box"] }] });
      if (at.startsWith("/api/v2/device/")) return removed.push(at.split("/").at(-1)!), reply({});
      return { ok: false, status: 404, text: async () => "{}" };
    },
  });
  try {
    const fake = new FakeNamespace({ maxCores: 64 });
    const context = { ...testContext(new MemoryStorage(), "inst1"), bbUrl: () => "https://bb.example", images: { bbApp: async () => "a".repeat(64) }, tailnet: () => tailnet } as never;
    const order: string[] = [];
    const backend = new NamespaceBackend(CONFIG, context, {
      fetch: fake.fetch,
      sshBinary: FAKE_SSH_BINARY,
      sleep: async () => {},
      readyTimeoutMs: 20_000,
      setupArchive: async () => Buffer.from("setup"),
      linuxTailscaleScript: ":",
      linuxImageScript: (target, key) => (order.push(readFileSync(log, "utf8").includes("tailscale up") ? "built after joining" : "built before joining"), `cat >/dev/null; echo nscr.io/ws/bbbox/${target}:${key}`),
    });
    disposed(backend);
    const image = await backend.linuxImages.forBox("linux", new AbortController().signal);
    assert.match(image.ref, /^nscr\.io\/ws\/bbbox\/linux:/);
    assert.deepEqual(order, ["built after joining"]);
    assert.deepEqual(minted, ["bb-box Namespace build-linux"]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.some((call) => /^tailscale up --auth-key=file:\S+ --hostname=bb-box-ns-inst1-build-linux /.test(call)), calls.join("; "));
    assert.ok(calls.includes("key tskey-auth-one-off-build"), "the key reached the machine on its input");
    assert.equal(calls.at(-1), "tailscale logout");
    assert.deepEqual(removed, ["n-build"], "only the build machine's device");
    assert.equal([...fake.instances.values()][0]!.status, "DESTROYED");
  } finally {
    process.env.PATH = path;
  }
});
