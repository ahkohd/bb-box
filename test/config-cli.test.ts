import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { sshPoolDriver } from "../src/backends/ssh-pool/index.ts";
import { tartDriver } from "../src/backends/tart/index.ts";
import { boatDriver } from "../src/backends/boat/index.ts";
import type { BackendDriver } from "../src/backends/types.ts";
import { withoutSecretVersions } from "../src/core/document.ts";
import { INSTALL_ID_KEY } from "../src/core/install.ts";
import { OPERATOR } from "../src/core/boxes.ts";
import { GENERAL_SECRETS } from "../src/core/box-files.ts";
import { TAILNET_CLIENT_SECRET } from "../src/core/tailnet-settings.ts";
import { parseDotenv } from "../src/plugin/config-edits.ts";
import type { ApplyResult } from "../src/plugin/configuration.ts";
import { setup, type BbBox } from "../src/plugin/setup.ts";
import { FakeBackend, fakeDriver } from "./fake-backend.ts";
import { tempDir } from "./helpers.ts";

const THREAD = "thr_config_cli";
const TOKEN = "made-up-cli-token-7f3a";
const OTHER_TOKEN = "made-up-cli-token-second-91c2";
const CLIENT_SECRET = "tskey-client-made-up-55aa";

type Ran = { exitCode?: number; stdout?: string; stderr?: string };

const disposals: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose().catch(() => {});
});

async function start(options: { failDoctor?: () => string | undefined; boat?: boolean } = {}) {
  const root = tempDir("config-cli");
  const threads = new Map([[THREAD, makeThreadResponse({ id: THREAD, projectId: "prj_cli", environmentId: "env_cli" })]]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-box",
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => threads.get(threadId)! },
      system: { machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, variables: [] }) },
      projects: {
        list: async () => [{ id: "prj_cli", name: "Client work" }, { id: "prj_home", name: "Home" }, { id: "prj_twin_a", name: "Twin" }, { id: "prj_twin_b", name: "Twin" }],
        machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, inheritedVariables: [], variables: [] }),
      },
    } as never,
  });
  await bb.storage.kv.set(INSTALL_ID_KEY, "earlier01");
  const fake = fakeDriver(root);
  const failing: BackendDriver<any> = {
    ...fake,
    create: (config, context) => {
      const backend = fake.create(config, context) as FakeBackend;
      const fault = options.failDoctor?.();
      if (fault) backend.faults.doctor = fault;
      return backend;
    },
  };
  const app: BbBox = await setup(bb, { drivers: [failing, sshPoolDriver, tartDriver, ...(options.boat ? [boatDriver] : [])], daemonParent: join(root, "no-daemon") });
  disposals.push(() => harness.lifecycle.dispose());
  const seen: string[] = [];
  const cli = async (args: string[], cwd?: string): Promise<Ran> => {
    const ran = await harness.behavior.runCli(args, cwd ? { cwd } : undefined);
    seen.push(`${ran.stdout ?? ""}${ran.stderr ?? ""}`);
    return ran;
  };
  const dir = tempDir("config-cli-files");
  writeFileSync(join(dir, "secrets.env"), `# made up\nexport FAKE_TOKEN="${TOKEN}"\nOTHER=${OTHER_TOKEN} # second\nTS_SECRET='${CLIENT_SECRET}'\n`);
  return {
    app,
    cli,
    dir,
    seen,
    document: () => withoutSecretVersions(app.configuration.exported()),
    revision: () => app.configuration.document.revision,
    rpc: <T,>(method: string, input: unknown) => harness.behavior.callRpc(method as never, input as never) as Promise<T>,
  };
}

function assertNoSecret(texts: readonly string[]) {
  for (const text of texts) for (const secret of [TOKEN, OTHER_TOKEN, CLIENT_SECRET]) assert.ok(!text.includes(secret), `a secret was printed: ${text}`);
}

test("backend add saves through config.apply with an operation and receipt, takes its secret from a dotenv file, and prints the backend's checks", async () => {
  const { cli, dir, seen, app, document, revision } = await start();
  const before = revision();
  const added = await cli(["backend", "add", "fake", "--field", "address=192.0.2.10", "--secret", "token=FAKE_TOKEN", "--secrets-file", "secrets.env", "--operation", "op-add-1"], dir);
  assert.equal(added.exitCode, 0, added.stderr);
  assert.equal(revision(), before + 1);
  assert.match(added.stdout ?? "", new RegExp(`^Saved revision ${before + 1}, operation op-add-1\\.\\n`));
  assert.match(added.stdout ?? "", /  backends\.fake: added, on\n  backends\.fake\.address: "here", the default → "192\.0\.2\.10"\n  backends\.fake\.token: set\n/);
  assert.match(added.stdout ?? "", /\nFake host \(fake\): /);
  assert.match(added.stdout ?? "", /\[ok\] Fake host: Guests live under /);
  assert.match(added.stdout ?? "", /Next: bb box kinds lists what is on offer\. .*bb box acquire <kind> --on fake/);
  assert.deepEqual(document().backends[0], { id: "fake", type: "fake", enabled: true, fields: { address: "192.0.2.10", token: { set: true } } });
  assert.equal(app.configuration.secrets.fake?.token, TOKEN);
  const state = await app.configuration.state();
  assert.deepEqual(state.receipts.map((receipt) => [receipt.operation, receipt.revision]), [["op-add-1", before + 1]]);
  assert.equal(state.backends[0]!.doctor?.revision, before + 1, "the check after the save is recorded against the revision it checked");

  const again = await cli(["backend", "add", "fake", "--field", "address=192.0.2.10", "--secret", "token=FAKE_TOKEN", "--secrets-file", "secrets.env", "--operation", "op-add-1"], dir);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(revision(), before + 1, "the same operation is saved once");

  const twice = await cli(["backend", "add", "fake", "--field", "address=192.0.2.10"], dir);
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr ?? "", /There is a backend fake already\./);
  assertNoSecret(seen);
});

test("backend add takes a second boat.dev backend with its own API key, Most boxes and auto-stop, and either may be kept for a project (#1455)", async () => {
  const { cli, dir, app, document } = await start({ boat: true });
  writeFileSync(join(dir, "boat.env"), "BOAT_ONE=boat_madeUpFirstAccount01\nBOAT_TWO=boat_madeUpSecondAccount02\n");

  const first = await cli(["backend", "add", "boat", "--off", "--secret", "api-key=BOAT_ONE", "--secrets-file", "boat.env", "--no-doctor"], dir);
  const second = await cli(["backend", "add", "boat", "--id", "team-b", "--off", "--field", "most-boxes=4", "--field", "lease-minutes=45", "--secret", "api-key=BOAT_TWO", "--secrets-file", "boat.env", "--projects", "client work", "--no-doctor"], dir);

  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  const boats = document().backends.filter((backend) => backend.type === "boat");
  assert.deepEqual(boats.map((backend) => [backend.id, backend.fields["most-boxes"] ?? null, backend.fields["lease-minutes"] ?? null, backend.projects ?? null]), [
    ["boat", null, null, null],
    ["boat:team-b", 4, 45, ["prj_cli"]],
  ]);
  assert.equal(app.configuration.secrets.boat?.["api-key"], "boat_madeUpFirstAccount01");
  assert.equal(app.configuration.secrets["boat:team-b"]?.["api-key"], "boat_madeUpSecondAccount02");
  for (const ran of [first, second]) assert.ok(!`${ran.stdout}${ran.stderr}`.includes("boat_madeUp"), "no key is printed");
});

test("the same operation ID again answers with its receipt; with another change it is refused, as config.apply refuses it", async () => {
  const { cli, revision } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--operation", "op-1"])).exitCode, 0);
  const saved = revision();
  const json = JSON.parse((await cli(["backend", "add", "fake", "--operation", "op-1", "--json"])).stdout ?? "");
  assert.equal(json.saved, true);
  assert.equal(json.replayed, true);
  assert.deepEqual([json.receipt.operation, json.receipt.revision], ["op-1", saved]);
  const reused = await cli(["option", "set", "boxesPerThread=3", "--operation", "op-1"]);
  assert.equal(reused.exitCode, 1);
  assert.match(reused.stderr ?? "", new RegExp(`^Operation op-1 was saved at revision ${saved} with other changes, so these were not saved\\. A new save needs a new operation ID\\.`));
  assert.equal(revision(), saved);
});

test("a secret on the command line is refused without echoing it, and nothing is saved", async () => {
  const { cli, seen, revision } = await start();
  const before = revision();
  const refused = await cli(["backend", "add", "fake", `--field`, `token=${TOKEN}`]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", /Token \(token\) is a secret, so it is never given on the command line/);
  assert.match(refused.stderr ?? "", /--secrets-file <dotenv file> or --secrets-stdin/);
  const option = await cli(["option", "set", `general.tailnet.clientSecret=${CLIENT_SECRET}`]);
  assert.equal(option.exitCode, 1);
  assert.match(option.stderr ?? "", /general\.tailnet\.clientSecret is a secret/);
  const plain = await cli(["backend", "add", "fake", "--secret", "address=FAKE_TOKEN", "--secrets", `FAKE_TOKEN=${TOKEN}`]);
  assert.match(plain.stderr ?? "", /Address \(address\) is not a secret: give it with --field address=<value>\./);
  const missing = await cli(["backend", "add", "fake", "--secret", "token=NOPE", "--secrets", `FAKE_TOKEN=${TOKEN}`]);
  assert.match(missing.stderr ?? "", /NOPE is not in the line on stdin\./);
  assert.match(missing.stderr ?? "", /The variable names in it are FAKE_TOKEN\./);
  const noSource = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN"]);
  assert.match(noSource.stderr ?? "", /give the dotenv file that holds it with --secrets-file, or pipe its line in with --secrets-stdin/);
  assert.equal(revision(), before);
  assertNoSecret(seen);
});

test("a secret piped in as one line, as bb's --secrets-stdin gives it, replaces the stored one, and --clear-secret clears it", async () => {
  const { cli, seen, app } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", `FAKE_TOKEN=${TOKEN}`])).exitCode, 0);
  assert.equal(app.configuration.secrets.fake?.token, TOKEN);
  const replaced = await cli(["backend", "set", "fake", "--secret", "token=OTHER", "--secrets", `OTHER="${OTHER_TOKEN}"`, "--json"]);
  const json = JSON.parse(replaced.stdout ?? "");
  assert.deepEqual(json.changes, [{ path: "backends.fake.token", words: "replaced" }]);
  assert.equal(app.configuration.secrets.fake?.token, OTHER_TOKEN);
  const cleared = await cli(["backend", "set", "fake", "--clear-secret", "token"]);
  assert.match(cleared.stdout ?? "", /backends\.fake\.token: cleared/);
  assert.equal(app.configuration.secrets.fake?.token, undefined);
  assertNoSecret(seen);
  assertNoSecret([JSON.stringify(await app.configuration.state())]);
});

test("several secrets come through one stdin line as a dotenv file in base64, and a line that is neither is refused", async () => {
  const { cli, seen, app } = await start();
  const file = `FAKE_TOKEN=${TOKEN}\nTS_ID=made-up-client-id\nTS_SECRET="${CLIENT_SECRET}"\n`;
  const line = Buffer.from(file).toString("base64");
  const set = await cli(["option", "set", "general.tailnet.mode=oauth", "--secret", "general.tailnet.clientId=TS_ID", "--secret", "general.tailnet.clientSecret=TS_SECRET", "--secrets", line]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(app.configuration.secrets[GENERAL_SECRETS]?.[TAILNET_CLIENT_SECRET], CLIENT_SECRET);
  const neither = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", "not a dotenv line"]);
  assert.equal(neither.exitCode, 1);
  assert.match(neither.stderr ?? "", /The line on stdin is neither a VARIABLE=value line nor a dotenv file in base64\./);
  assertNoSecret(seen);
});

test("a stale --revision is refused with the revision it is at, and the right one saves", async () => {
  const { cli, revision } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  const now = revision();
  const stale = await cli(["backend", "set", "fake", "--field", "address=192.0.2.11", "--revision", String(now - 1)]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr ?? "", new RegExp(`^Nothing was saved: the configuration changed since revision ${now - 1}, and is at revision ${now}\\.`));
  assert.equal(revision(), now);
  const fresh = await cli(["backend", "set", "fake", "--field", "address=192.0.2.11", "--revision", String(now)]);
  assert.equal(fresh.exitCode, 0, fresh.stderr);
  assert.equal(revision(), now + 1);
});

test("without --revision a change made by someone else in between is kept, as the change is made on the latest revision", async () => {
  const { cli, app, document, rpc } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  const configuration = app.configuration;
  const apply = configuration.apply.bind(configuration);
  let raced = false;
  configuration.apply = async (draft, revision, operation) => {
    if (!raced) {
      raced = true;
      const base = withoutSecretVersions(configuration.exported());
      await rpc<ApplyResult>("config.apply", { draft: { ...base, general: { boxesPerThread: 7 } }, revision: base.revision });
    }
    return apply(draft, revision, operation);
  };
  const set = await cli(["kind", "set", "linux", "--spares", "1"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.equal(document().general.boxesPerThread, 7);
  assert.equal(document().kinds.linux?.spares, 1);
});

test("--check saves nothing, says what would change, and runs the backend's checks with the change", async () => {
  const { cli, revision } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--off"])).exitCode, 0);
  const before = revision();
  const checked = await cli(["backend", "set", "fake", "--on", "--field", "address=192.0.2.12", "--check"]);
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.match(checked.stdout ?? "", new RegExp(`^Checked against revision ${before}; nothing was saved\\.\\nIt would change:\\n  backends\\.fake\\.enabled: off → on\\n  backends\\.fake\\.address: "here", the default → "192\\.0\\.2\\.12"\\nNo problems\\.\\nFake host \\(fake\\): `));
  const broken = await cli(["backend", "set", "fake", "--field", "address=broken", "--check"]);
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stdout ?? "", /Problems:\n  backends\.fake\.address: Fill in the fake host's address\./);
  assert.equal(revision(), before);
});

test("a backend that cannot run is refused on, and saved off to finish later, as on the settings page", async () => {
  const { cli, document, revision } = await start();
  const before = revision();
  const on = await cli(["backend", "add", "fake", "--field", "address=broken"]);
  assert.equal(on.exitCode, 1);
  assert.match(on.stderr ?? "", /^Nothing was saved\. Fix these first:\n  backends\.fake\.address: Fill in the fake host's address\./);
  assert.equal(revision(), before);
  const off = await cli(["backend", "add", "fake", "--field", "address=broken", "--off"]);
  assert.equal(off.exitCode, 0, off.stderr);
  assert.match(off.stdout ?? "", /Saved with these problems, in backends that are off:\n  backends\.fake\.address: Fill in the fake host's address\.\nfake is off, so it was not checked\./);
  assert.equal(document().backends[0]!.enabled, false);
});

test("a backend whose checks fail after the save exits 2 and says how to check again", async () => {
  let fault: string | undefined;
  const { cli, revision } = await start({ failDoctor: () => fault });
  fault = "no route to 192.0.2.13";
  const before = revision();
  const added = await cli(["backend", "add", "fake"]);
  assert.equal(added.exitCode, 2);
  assert.equal(revision(), before + 1);
  assert.match(added.stdout ?? "", /\[fail\] Fake host: no route to 192\.0\.2\.13\n {8}Fix: Clear the fault\.\nIts checks failed: fix what they say, then bb box backend set fake --check checks again without saving\./);
  const quiet = await cli(["backend", "set", "fake", "--label", "Fake on 192.0.2.13", "--no-doctor"]);
  assert.equal(quiet.exitCode, 0);
  assert.doesNotMatch(quiet.stdout ?? "", /Fake host:/);
});

test("--field, --unset, --add-line and --remove-line edit fields, and an unknown field names the ones there are", async () => {
  const { cli, dir, document } = await start();
  assert.equal((await cli(["backend", "add", "ssh-pool", "--off"])).exitCode, 0);
  const added = await cli(["backend", "set", "ssh-pool", "--add-line", "machines=build-1 192.0.2.21 linux", "--add-line", "machines=build-2 192.0.2.22 linux", "--field", "ios-hosts-ahead=2"]);
  assert.equal(added.exitCode, 0, added.stderr);
  assert.match(added.stdout ?? "", /backends\.ssh-pool\.machines: added the line "build-1 192\.0\.2\.21 linux"\n  backends\.ssh-pool\.machines: added the line "build-2 192\.0\.2\.22 linux"/);
  assert.equal(document().backends[0]!.fields.machines, "build-1 192.0.2.21 linux\nbuild-2 192.0.2.22 linux");
  const same = await cli(["backend", "set", "ssh-pool", "--add-line", "machines=build-1 192.0.2.21 linux"]);
  assert.match(same.stdout ?? "", /^Nothing to change: the configuration already has that/);
  const removed = await cli(["backend", "set", "ssh-pool", "--remove-line", "machines=build-1", "--unset", "ios-hosts-ahead"]);
  assert.match(removed.stdout ?? "", /backends\.ssh-pool\.ios-hosts-ahead: 2 → 1, the default\n  backends\.ssh-pool\.machines: removed the line "build-1 192\.0\.2\.21 linux"/);
  assert.deepEqual(document().backends[0]!.fields, { machines: "build-2 192.0.2.22 linux", "ssh-private-key": { set: false } });
  writeFileSync(join(dir, "known_hosts"), "192.0.2.22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUp\n");
  assert.equal((await cli(["backend", "set", "ssh-pool", "--field-file", "known-hosts=known_hosts"], dir)).exitCode, 0);
  assert.equal(document().backends[0]!.fields["known-hosts"], "192.0.2.22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUp");
  const unknown = await cli(["backend", "set", "ssh-pool", "--field", "hosts=1"]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr ?? "", /Backend ssh-pool has no field "hosts"\. Its fields are machines, known-hosts, ssh-private-key, /);
  const none = await cli(["backend", "set", "ssh-pool", "--remove-line", "machines=build-9"]);
  assert.match(none.stderr ?? "", /No line of Machines \(machines\) is "build-9" or starts with it\./);
  const notNumber = await cli(["backend", "set", "ssh-pool", "--field", "ios-hosts-ahead=two"]);
  assert.match(notNumber.stderr ?? "", /Ready slots kept on a shared iOS host \(ios-hosts-ahead\) is a number, not "two"\./);
});

test("remove asks for --yes, is refused while the backend has boxes, and then removes it with its secret", async () => {
  const { cli, app, document, revision } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", `FAKE_TOKEN=${TOKEN}`])).exitCode, 0);
  await app.configuration.state();
  const box = await app.boxes.settled(await app.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const before = revision();
  const asked = await cli(["backend", "remove", "fake"]);
  assert.equal(asked.exitCode, 1);
  assert.match(asked.stderr ?? "", /^Nothing was removed\. Removing fake deletes its settings and its secrets, which cannot be got back, and its warm boxes go; there is no undo\. It has 1 box, so it is refused until they are released/);
  const refused = await cli(["backend", "remove", "fake", "--yes"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", /^Nothing was saved\. Fix these first:\n  backends\.fake: Backend fake has 1 box, so it cannot be removed or renamed\. Turn it off and release them first\./);
  assert.equal(revision(), before);
  await app.boxes.release(THREAD, box!.id, "test");
  const removed = await cli(["backend", "remove", "fake", "--yes"]);
  assert.equal(removed.exitCode, 0, removed.stderr);
  assert.match(removed.stdout ?? "", /backends\.fake: removed, with its secrets and warm boxes/);
  assert.deepEqual(document().backends, []);
  assert.equal(app.configuration.secrets.fake, undefined);
});

test("hosts of a backend are added, changed and removed; the SSH host pool points to its machines field", async () => {
  const { cli, document } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  const added = await cli(["backend", "host", "add", "fake", "mac-1", "--field", "address=192.0.2.30"]);
  assert.equal(added.exitCode, 0, added.stderr);
  assert.match(added.stdout ?? "", /backends\.fake\.hosts\.mac-1: added, on\n  backends\.fake\.hosts\.mac-1\.address: unset → "192\.0\.2\.30"/);
  assert.equal((await cli(["backend", "host", "set", "fake", "mac-1", "--off"])).exitCode, 0);
  assert.deepEqual(document().backends[0]!.hosts, [{ name: "mac-1", enabled: false, fields: { address: "192.0.2.30" } }]);
  assert.match((await cli(["backend", "host", "add", "fake", "Mac 1"])).stderr ?? "", /Name the host with lower-case letters, digits and "-"/);
  assert.equal((await cli(["backend", "host", "remove", "fake", "mac-1"])).exitCode, 0);
  assert.deepEqual(document().backends[0]!.hosts, []);
  assert.equal((await cli(["backend", "add", "ssh-pool", "--off"])).exitCode, 0);
  assert.match((await cli(["backend", "host", "add", "ssh-pool", "build-1"])).stderr ?? "", /SSH host pool has no hosts of its own\. Its machines are lines of its machines field: bb box backend set ssh-pool --add-line machines=/);
});

test("list, types and fields describe the backends without a secret's value", async () => {
  const { cli, seen } = await start();
  assert.match((await cli(["backend", "list"])).stdout ?? "", /^There are no backends yet\./);
  assert.equal((await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", `FAKE_TOKEN=${TOKEN}`, "--warm", "linux=1"])).exitCode, 0);
  const list = await cli(["backend", "list"]);
  assert.match(list.stdout ?? "", /^fake \(Fake host, VM\): on, ready, offers linux, linux-desktop; last checked .* at revision \d+: passed\.\n {2}warm: 1 linux/);
  const types = await cli(["backend", "types"]);
  assert.match(types.stdout ?? "", /^fake: Fake host\. Guests in directories on this machine\. Kinds: linux, linux-desktop\. Guide: setup\/fake\/README\.md; scripts setup\/fake\/host\.sh\. Added: fake\./m);
  assert.match(types.stdout ?? "", /^ssh-pool: SSH host pool\. /m);
  const fields = await cli(["backend", "fields", "fake"]);
  assert.match(fields.stdout ?? "", /^Backend fake, Fake host \(fake\)\. Its guide: setup\/fake\/README\.md\.\nFields:\n {2}address \(string\) \[connection\]: Address\. Where the fake host is\. Now: unset, so "here"\.\n {2}token \(string, secret\) \[credentials\]: Token\. {2}Now: set\./);
  const typeFields = await cli(["backend", "fields", "tart"]);
  assert.match(typeFields.stdout ?? "", /Each host's fields, with bb box backend host add:\n {2}address \(string\) \[connection\]: Address\./);
  assert.match((await cli(["backend", "fields", "nothing"])).stderr ?? "", /There is no backend type "nothing"\. The types are fake, ssh-pool, tart\./);
  assertNoSecret(seen);
});

test("kind set changes the default preset's size, the default, spares and the switch, and refuses the default kind off", async () => {
  const { cli, document } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  const cores = await cli(["kind", "set", "linux", "--cores", "4"]);
  assert.equal(cores.exitCode, 0, cores.stderr);
  assert.match(cores.stdout ?? "", /kinds\.linux\.presets\.small: 2 cores, 4 GiB memory → 4 cores, 4 GiB memory\n/);
  assert.match(cores.stdout ?? "", /Now linux: small 4 cores, 4 GiB memory \(default\); medium 4 cores, 8 GiB memory; large 8 cores, 16 GiB memory; largest 16 cores, 32 GiB memory, 256 GiB disk\. Boxes made before keep their size\./);
  assert.deepEqual(document().kinds.linux, { presets: { small: { cores: 4 } } });
  const medium = await cli(["kind", "set", "linux", "--default-preset", "medium", "--preset", "large", "--memory-gib", "24", "--disk-gib", "base", "--spares", "2"]);
  assert.equal(medium.exitCode, 0, medium.stderr);
  assert.deepEqual(document().kinds.linux, { presets: { small: { cores: 4 }, large: { memoryMiB: 24576, diskGiB: null } }, default: "medium", spares: 2 });
  const off = await cli(["kind", "set", "linux", "--off"]);
  assert.equal(off.exitCode, 1);
  assert.match(off.stderr ?? "", /linux is the default kind, which stays on, as on the settings page\. Choose another default first: bb box kind set <kind> --make-default\./);
  assert.equal((await cli(["kind", "set", "linux-desktop", "--make-default"])).exitCode, 0);
  assert.equal(document().general.defaultKind, "linux-desktop");
  assert.equal((await cli(["kind", "set", "linux", "--off"])).exitCode, 0);
  assert.equal(document().kinds.linux?.enabled, false);
  const big = await cli(["kind", "set", "linux-desktop", "--cores", "999"]);
  assert.match(big.stderr ?? "", /kinds\.linux-desktop\.presets\.small: The small linux-desktop preset, 999 cores, 8 GiB memory, is above the largest size/);
  assert.match((await cli(["kind", "set", "linux-gpu"])).stderr ?? "", /There is no kind "linux-gpu"\. The kinds are /);
  assert.equal((await cli(["kind", "set", "linux", "--reset"])).exitCode, 0);
  assert.equal(document().kinds.linux, undefined);
});

test("option set and unset change general and Monitor options in one save, and list shows each with its default", async () => {
  const { cli, document } = await start();
  const off = await cli(["option", "set", "monitor.enabled=false"]);
  assert.equal(off.exitCode, 0, off.stderr);
  assert.match(off.stdout ?? "", /  monitor\.enabled: true, the default → false\nThe Monitor is off\. BB's sidebar shows the change when BB next loads\./);
  assert.deepEqual(document().monitor, { enabled: false });
  assert.equal((await cli(["option", "set", "boxesPerThread", "4"])).exitCode, 0);
  assert.equal(document().general.boxesPerThread, 4);
  const list = await cli(["option", "list"]);
  assert.match(list.stdout ?? "", /^general\.defaultKind = "linux" \(the default\): /);
  assert.match(list.stdout ?? "", /\ngeneral\.boxesPerThread = 4: /);
  assert.match(list.stdout ?? "", /\nmonitor\.enabled = false: /);
  assert.match((await cli(["option", "get", "monitor.enabled"])).stdout ?? "", /^monitor\.enabled = false: Whether the Monitor runs/);
  assert.match((await cli(["option", "get", "defaultKind"])).stdout ?? "", /^general\.defaultKind = "linux" \(the default\): /);
  const back = await cli(["option", "unset", "monitor.enabled", "general.boxesPerThread"]);
  assert.match(back.stdout ?? "", /monitor\.enabled: false → true, the default/);
  assert.equal(document().monitor, undefined);
  assert.equal(document().general.boxesPerThread, undefined);
  assert.match((await cli(["option", "set", "monitor.refreshIntervalSeconds=1"])).stderr ?? "", /monitor\.refreshIntervalSeconds is a whole number from 2 to 60, not "1"\./);
  assert.match((await cli(["option", "set", "colour=blue"])).stderr ?? "", /There is no option "colour"\. The options are general\.defaultKind, /);
  const kind = await cli(["option", "set", "defaultKind=plan9"]);
  assert.match(kind.stderr ?? "", /^Nothing was saved\. Fix these first:\n  general\.defaultKind: There is no kind "plan9"\./);
});

test("bb box option sets and unsets the snapshot settings that bite, within their ranges (070 unit 4)", async () => {
  const { cli, document } = await start();
  const set = await cli(["option", "set", "general.snapshots.perBox=3", "general.snapshots.roomPercent=70"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout ?? "", /general\.snapshots\.perBox: 5, the default → 3/);
  assert.deepEqual(document().general.snapshots, { perBox: 3, roomPercent: 70 });
  assert.match((await cli(["option", "get", "general.snapshots.roomPercent"])).stdout ?? "", /^general\.snapshots\.roomPercent = 70: How full a host's storage may be/);
  assert.match((await cli(["option", "set", "general.snapshots.roomPercent=95"])).stderr ?? "", /general\.snapshots\.roomPercent is a whole number from 50 to 90, not "95"\./);
  assert.equal((await cli(["option", "unset", "general.snapshots.perBox", "general.snapshots.roomPercent"])).exitCode, 0);
  assert.equal(document().general.snapshots, undefined);
});

test("the tailnet's OAuth client is set from a dotenv file with its mode in one save, never printed", async () => {
  const { cli, dir, seen, app, document } = await start();
  const alone = await cli(["option", "set", "--secret", "general.tailnet.clientSecret=TS_SECRET", "--secrets-file", "secrets.env"], dir);
  assert.equal(alone.exitCode, 1);
  assert.match(alone.stderr ?? "", /The tailnet keeps its OAuth client only with general\.tailnet\.mode=oauth\./);
  const missing = await cli(["option", "set", "general.tailnet.mode=oauth", "--secret", "general.tailnet.clientSecret=TS_SECRET", "--secrets-file", "secrets.env"], dir);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /general\.tailnet\.clientId: Set the Tailscale OAuth client's ID/);
  const set = await cli(["option", "set", "tailnet.mode=oauth", "tailnet.tags=tag:bb-box,tag:ci", "--secret", "tailnet.clientId=OTHER", "--secret", "tailnet.clientSecret=TS_SECRET", "--secrets-file", "secrets.env"], dir);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout ?? "", /general\.tailnet\.clientId: set\n  general\.tailnet\.clientSecret: set/);
  assert.deepEqual(document().general.tailnet, { mode: "oauth", tags: ["tag:bb-box", "tag:ci"], clientId: { set: true }, clientSecret: { set: true } });
  assert.equal(app.configuration.secrets[GENERAL_SECRETS]?.[TAILNET_CLIENT_SECRET], CLIENT_SECRET);
  const offAgain = await cli(["option", "unset", "general.tailnet.mode"]);
  assert.match(offAgain.stdout ?? "", /general\.tailnet: removed: the tailnet is off/);
  assert.equal(document().general.tailnet, undefined);
  assert.equal(app.configuration.secrets[GENERAL_SECRETS]?.[TAILNET_CLIENT_SECRET], undefined);
  assertNoSecret(seen);
});

test("a change that changes nothing saves nothing", async () => {
  const { cli, revision } = await start();
  assert.equal((await cli(["option", "set", "monitor.enabled=false"])).exitCode, 0);
  const before = revision();
  const same = await cli(["option", "set", "monitor.enabled", "off"]);
  assert.equal(same.exitCode, 0);
  assert.match(same.stdout ?? "", /^Nothing to change: the configuration already has that, at revision \d+\./);
  assert.equal(revision(), before);
});

test("every command's --json is JSON, and none holds a secret", async () => {
  const { cli, seen } = await start();
  const runs: string[][] = [
    ["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", `FAKE_TOKEN=${TOKEN}`, "--json"],
    ["backend", "set", "fake", "--field", "address=192.0.2.14", "--json"],
    ["backend", "set", "fake", "--field", "address=broken", "--json"],
    ["backend", "set", "fake", "--check", "--json"],
    ["backend", "list", "--json"],
    ["backend", "types", "--json"],
    ["backend", "fields", "fake", "--json"],
    ["kind", "set", "linux", "--cores", "3", "--json"],
    ["option", "set", "monitor.backgroundMonitoring=true", "--json"],
    ["option", "list", "--json"],
    ["option", "unset", "monitor.backgroundMonitoring", "--json"],
    ["backend", "remove", "fake", "--yes", "--json"],
  ];
  for (const args of runs) {
    const ran = await cli(args);
    assert.doesNotThrow(() => JSON.parse(ran.stdout ?? ""), `${args.join(" ")}: ${ran.stdout}${ran.stderr}`);
  }
  const refused = JSON.parse(seen[2]!);
  assert.equal(refused.saved, false);
  assert.equal(refused.refused, "Nothing was saved. Fix these first:");
  assert.deepEqual(refused.problems, [{ path: "backends.fake.address", message: "Fill in the fake host's address." }]);
  assertNoSecret(seen);
});

test("a dotenv file is read as bb secret request writes one, and as people write them", () => {
  const values = parseDotenv(
    [
      "# a comment",
      "PLAIN=abc",
      "export EXPORTED=def",
      'DOUBLE="with \\"quotes\\" and a # hash"',
      "SINGLE='it is $literal'",
      "TRAILING=value # comment",
      'KEY="-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----\\n"',
      'SPLIT="first',
      'second"',
      "EMPTY=",
      "not a line",
    ].join("\n"),
  );
  assert.deepEqual(Object.fromEntries(values), {
    PLAIN: "abc",
    EXPORTED: "def",
    DOUBLE: 'with "quotes" and a # hash',
    SINGLE: "it is $literal",
    TRAILING: "value",
    KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
    SPLIT: "first\nsecond",
    EMPTY: "",
  });
});

test("an empty value for an image field is saved as itself, so it turns its kind off rather than taking the default", async () => {
  const { cli, document } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--field", "address="])).exitCode, 0);
  assert.equal(document().backends[0]!.fields.address, "");
  const shown = (await cli(["backend", "fields", "fake"])).stdout ?? "";
  assert.match(shown, /address \(string\) \[connection\]: Address\. Where the fake host is\. Now: ""\./);
});


test("bb box run runs a command in a thread's box or one of your machines, and exits with its exit code", async () => {
  const { cli, app } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  await app.configuration.state();
  const box = (await app.boxes.settled(await app.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" })))!;
  const ran = await cli(["run", box.name, "echo", "made-up-output", "--thread", THREAD]);
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(ran.stdout, "made-up-output\n");
  const failed = await cli(["run", box.name, "echo oops >&2; exit 3", "--thread", THREAD]);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stderr, "oops\n");
  const machine = (await app.boxes.settled(await app.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", name: "proof-1" })))!;
  const onMachine = await cli(["run", machine.name, "echo machine", "--machine"]);
  assert.equal(onMachine.stdout, "machine\n");
  assert.match((await cli(["run", machine.name, "true", "--thread", THREAD])).stderr ?? "", /proof-1/);
});

test("backend set --projects keeps a backend for BB projects by name or ID, stores their IDs, refuses a name BB does not have or has twice, and an empty list gives it back to every project (#1458)", async () => {
  const { cli, document } = await start();
  assert.equal((await cli(["backend", "add", "fake", "--no-doctor"])).exitCode, 0);
  assert.equal(document().backends[0]!.projects, undefined, "a new backend serves every project");

  const kept = await cli(["backend", "set", "fake", "--projects", "client work, prj_home", "--no-doctor"]);
  assert.equal(kept.exitCode, 0, kept.stderr);
  assert.match(kept.stdout ?? "", /  backends\.fake\.projects: every project → prj_cli, prj_home\n/);
  assert.deepEqual(document().backends[0]!.projects, ["prj_cli", "prj_home"]);

  const unknown = await cli(["backend", "set", "fake", "--projects", "Nope"]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr ?? "", /BB has no project called "Nope"\. Its projects are: Client work, Home, Twin, Twin\./);
  const twice = await cli(["backend", "set", "fake", "--projects", "twin"]);
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr ?? "", /2 projects are called "twin": prj_twin_a, prj_twin_b\. Give its ID\./);
  assert.deepEqual(document().backends[0]!.projects, ["prj_cli", "prj_home"], "a refusal changes nothing");

  const cleared = await cli(["backend", "set", "fake", "--projects", "", "--no-doctor"]);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.match(cleared.stdout ?? "", /  backends\.fake\.projects: prj_cli, prj_home → every project\n/);
  assert.equal(document().backends[0]!.projects, undefined);
});
