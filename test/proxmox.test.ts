import assert from "node:assert/strict";
import { test } from "node:test";
import { Proxmox, ProxmoxError, parseSizeGiB, parseTags } from "../src/backends/proxmox/api.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";

function setup() {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  const sleeps: number[] = [];
  const proxmox = new Proxmox({
    apiUrl: "https://pve.example.com:8006/",
    ...FAKE_TOKEN,
    node: api.node,
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, proxmox, sleeps };
}

test("a linked clone joins the pool without a storage parameter and waits for its task", async () => {
  const { api, proxmox, sleeps } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7001, hostname: "quiet-heron", pool: "bbbox" });
  const clone = api.calls.find((call) => call.path.endsWith("/clone"))!;
  assert.equal(clone.method, "POST");
  assert.equal(clone.path, "/nodes/pve/lxc/9000/clone");
  assert.deepEqual(clone.params, { newid: "7001", hostname: "quiet-heron", full: "0", pool: "bbbox" });
  assert.equal(clone.auth, `PVEAPIToken=${FAKE_TOKEN.tokenId}=${FAKE_TOKEN.tokenSecret}`);
  assert.ok(api.calls.some((call) => call.path.includes("/tasks/")));
  assert.deepEqual(sleeps, [50], "tasks are polled every 50 ms");
  const guest = api.guests.get(7001)!;
  assert.equal(guest.pool, "bbbox");
  assert.equal(guest.config.features, "nesting=1", "features come from the template");
});

test("a used VMID reports already exists", async () => {
  const { api, proxmox } = setup();
  api.hidden.add(7002);
  const error = await proxmox.cloneLinked({ template: 9000, vmid: 7002, hostname: "a-b" }).catch((e) => e);
  assert.ok(error instanceof ProxmoxError);
  assert.equal(error.alreadyExists, true);
  assert.doesNotMatch(error.message, new RegExp(FAKE_TOKEN.tokenSecret));
});

test("configure sets cores, memory, a static address and tags after the clone is in the pool", async () => {
  const { api, proxmox } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7003, hostname: "calm-otter", pool: "bbbox" });
  await proxmox.configure(7003, {
    cores: 4,
    memory: 8192,
    swap: 512,
    net0: "name=eth0,bridge=vmbr1,ip=192.0.2.3/24,gw=192.0.2.1,type=veth",
    tags: ["bb-box", "thread.thr_abc"],
    onboot: false,
  });
  const put = api.calls.find((call) => call.method === "PUT" && call.path.endsWith("/config"))!;
  assert.deepEqual(put.params, {
    cores: "4",
    memory: "8192",
    swap: "512",
    net0: "name=eth0,bridge=vmbr1,ip=192.0.2.3/24,gw=192.0.2.1,type=veth",
    tags: "bb-box;thread.thr_abc",
    onboot: "0",
  });
  assert.equal(api.guests.get(7003)!.config.memory, "8192");
});

test("the root disk only grows", async () => {
  const { api, proxmox } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7004, hostname: "bold-wren" });
  assert.equal(await proxmox.growRootDisk(7004, 8), false);
  assert.equal(await proxmox.growRootDisk(7004, 16), true);
  assert.match(api.guests.get(7004)!.config.rootfs!, /size=16G/);
  assert.equal(await proxmox.growRootDisk(7004, 12), false);
});

test("start, status, stop and destroy with purge; a missing CT counts as deleted", async () => {
  const { api, proxmox } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7005, hostname: "kind-lark", pool: "bbbox" });
  await proxmox.start(7005);
  assert.equal((await proxmox.status(7005))?.status, "running");
  await proxmox.destroy(7005);
  assert.equal(api.guests.has(7005), false);
  const del = api.calls.find((call) => call.method === "DELETE")!;
  assert.equal(del.params.purge, "1");
  assert.ok(
    api.calls.findIndex((call) => call.path.endsWith("/status/stop")) < api.calls.indexOf(del),
    "stops before deleting",
  );
  assert.equal(await proxmox.status(7005), null);
  await proxmox.destroy(7005);
});

test("task warnings are success, task errors are not", async () => {
  const { api, proxmox } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7006, hostname: "neat-fern" });
  api.nextTaskExit.set("vzstart", "WARNINGS: 2");
  await proxmox.start(7006);
  api.nextTaskExit.set("vzstop", "command 'lxc-stop' failed: exit code 1");
  const error = await proxmox.stop(7006).catch((e) => e);
  assert.ok(error instanceof ProxmoxError);
  assert.match(error.message, /lxc-stop/);
});

test("listPool returns only the pool's guests with their tags", async () => {
  const { proxmox } = setup();
  await proxmox.cloneLinked({ template: 9000, vmid: 7007, hostname: "wise-moss", pool: "bbbox" });
  await proxmox.configure(7007, { tags: ["bb-box", "thread.thr_1", "box.bx1"] });
  await proxmox.cloneLinked({ template: 9000, vmid: 7008, hostname: "other-pool" });
  const guests = await proxmox.listPool("bbbox");
  assert.deepEqual(
    guests.map((guest) => [guest.vmid, guest.name, guest.tags]),
    [[7007, "wise-moss", ["bb-box", "thread.thr_1", "box.bx1"]]],
  );
});

test("a VM client clones, names, configures, runs and deletes VMs, and leaves containers alone", async () => {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.addVmTemplate(9001);
  const proxmox = new Proxmox({ apiUrl: "https://pve.example.com:8006", ...FAKE_TOKEN, node: api.node, type: "qemu", fetch: api.fetch, sleep: async () => {} });
  await proxmox.cloneLinked({ template: 9001, vmid: 7101, hostname: "calm-heron", pool: "bbbox", description: "bb-box calm-heron" });
  const clone = api.calls.find((call) => call.path.endsWith("/clone"))!;
  assert.equal(clone.path, "/nodes/pve/qemu/9001/clone");
  assert.deepEqual(clone.params, { newid: "7101", name: "calm-heron", full: "0", pool: "bbbox", description: "bb-box calm-heron" });
  await proxmox.configure(7101, { name: "bold-heron", cores: 8, memory: 16384, smbios1: "serial=MTkyLjAuMi41LzI0IDE5Mi4wLjIuMQ==,base64=1", delete: ["protection"] });
  const put = api.calls.find((call) => call.method === "PUT")!;
  assert.equal(put.path, "/nodes/pve/qemu/7101/config");
  assert.deepEqual(put.params, { name: "bold-heron", cores: "8", memory: "16384", smbios1: "serial=MTkyLjAuMi41LzI0IDE5Mi4wLjIuMQ==,base64=1", delete: "protection" });
  assert.equal((await proxmox.config(7101)).name, "bold-heron");
  await proxmox.start(7101);
  assert.equal((await proxmox.status(7101))?.status, "running");
  const [guest] = await proxmox.listPool("bbbox");
  assert.deepEqual([guest?.vmid, guest?.type, guest?.name], [7101, "qemu", "bold-heron"]);
  await proxmox.destroy(7101);
  assert.equal(api.guests.has(7101), false);
  assert.ok(
    api.calls.filter((call) => /^\/nodes\/pve\/(lxc|qemu)\/\d+/.test(call.path)).every((call) => call.path.startsWith("/nodes/pve/qemu/")),
    "every guest call is a VM's",
  );
  assert.equal(await proxmox.status(9000), null, "a container is not a VM");
});

test("a wrong token and an unreachable API give clear errors without the secret", async () => {
  const api = new FakeProxmox();
  const wrong = new Proxmox({ apiUrl: "https://x", tokenId: "a@pve!b", tokenSecret: "nope-secret", node: "n", fetch: api.fetch });
  const denied = await wrong.version().catch((e) => e);
  assert.ok(denied instanceof ProxmoxError);
  assert.equal(denied.status, 401);
  assert.doesNotMatch(denied.message, /nope-secret/);
  const down = new Proxmox({
    apiUrl: "https://x",
    ...FAKE_TOKEN,
    node: "n",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const unreachable = await down.version().catch((e) => e);
  assert.match(unreachable.message, /cannot reach the Proxmox API/);
});

test("parsers", () => {
  assert.deepEqual(parseTags("a;b,c d"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseTags(undefined), []);
  assert.equal(parseSizeGiB("8G"), 8);
  assert.equal(parseSizeGiB("512M"), 0.5);
  assert.equal(parseSizeGiB("1T"), 1024);
  assert.equal(parseSizeGiB("nope"), null);
});
