import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { sshPoolDriver } from "../src/backends/ssh-pool/index.ts";
import { tartDriver } from "../src/backends/tart/index.ts";
import { boatDriver } from "../src/backends/boat/index.ts";
import type { BackendDriver } from "../src/backends/types.ts";
import { readDraft, withoutSecretVersions } from "../src/core/document.ts";
import { INSTALL_ID_KEY } from "../src/core/install.ts";
import { OPERATOR } from "../src/core/boxes.ts";
import { GENERAL_SECRETS } from "../src/core/box-files.ts";
import { TAILNET_CLIENT_SECRET } from "../src/core/tailnet-settings.ts";
import { parseDotenv } from "../src/plugin/config-edits.ts";
import type { ApplyResult } from "../src/plugin/configuration.ts";
import { setup, type BbBox } from "../src/plugin/setup.ts";
import { FakeBackend, fakeDriver } from "./fake-backend.ts";
import { seededRandom, tempDir } from "./helpers.ts";

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
  assert.match(missing.stderr ?? "", /The variable that the 1st --secret names is not in the line on stdin\./);
  assert.match(missing.stderr ?? "", /It has 1 variable\./);
  assert.ok(!(missing.stderr ?? "").includes("FAKE_TOKEN"), "no name from the input is shown");
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

const PADDED_VALUE = "bWFkZS11cC12YWx1ZQ==";
const ALPHANUMERIC_THEN_PADDING = /^[A-Za-z0-9]+={1,2}$/;

test("a dotenv file in base64 that ends in = padding is read as base64, and a value may hold = signs", async () => {
  for (const file of [`FAKE_TOKEN=${PADDED_VALUE}\n`, `FAKE_TOKEN=${PADDED_VALUE}`]) {
    const { cli, seen, app } = await start();
    const line = Buffer.from(file).toString("base64");
    assert.match(line, ALPHANUMERIC_THEN_PADDING, "the base64 looks like a VARIABLE= line");
    const set = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", line]);
    assert.equal(set.exitCode, 0, set.stderr);
    assert.equal(app.configuration.secrets.fake?.token, PADDED_VALUE);
    for (const text of seen) assert.ok(!text.includes(line.slice(0, 8)), `the input was printed: ${text}`);
  }
  const { cli, app, dir } = await start();
  const single = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", "FAKE_TOKEN=made=up=value=="]);
  assert.equal(single.exitCode, 0, single.stderr);
  assert.equal(app.configuration.secrets.fake?.token, "made=up=value==");
  writeFileSync(join(dir, "padded.env"), `FIRST=one\nFAKE_TOKEN=${PADDED_VALUE}`);
  const fromFile = await cli(["backend", "set", "fake", "--secret", "token=FAKE_TOKEN", "--secrets-file", "padded.env"], dir);
  assert.equal(fromFile.exitCode, 0, fromFile.stderr);
  assert.equal(app.configuration.secrets.fake?.token, PADDED_VALUE);
});

test("a malformed line on stdin or in a file is refused by its line number, with neither its value nor the line", async () => {
  const { cli, seen, dir, revision } = await start();
  const before = revision();
  const value = "made-up-malformed-value-3b9e";
  const malformed = `FIRST=one\nFAKE_TOKEN ${value}\n`;
  const piped = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", Buffer.from(malformed).toString("base64")]);
  assert.equal(piped.exitCode, 1);
  assert.match(piped.stderr ?? "", /^Line 2 of the dotenv file in base64 on stdin is not a VARIABLE=value line\. Nothing was saved\./);
  writeFileSync(join(dir, "malformed.env"), malformed);
  const filed = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets-file", "malformed.env"], dir);
  assert.equal(filed.exitCode, 1);
  assert.match(filed.stderr ?? "", /^Line 2 of the file given to --secrets-file is not a VARIABLE=value line\. Nothing was saved\./);
  const rawSecret = Buffer.from(value).toString("base64");
  assert.match(rawSecret, ALPHANUMERIC_THEN_PADDING);
  const raw = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets", rawSecret]);
  assert.equal(raw.exitCode, 1);
  assert.match(raw.stderr ?? "", /neither a VARIABLE=value line nor a dotenv file in base64/);
  const valueAsVariable = await cli(["backend", "add", "fake", "--secret", `token=${value}`, "--secrets", "FIRST=one"]);
  assert.equal(valueAsVariable.exitCode, 1);
  const valueAsPair = await cli(["backend", "add", "fake", "--secret", value, "--secrets", "FIRST=one"]);
  assert.equal(valueAsPair.exitCode, 1);
  assert.match(valueAsPair.stderr ?? "", /Give --secret as <name>=<value>\. What was given is not shown/);
  for (const text of seen) {
    assert.ok(!text.includes(value), `the value was printed: ${text}`);
    assert.ok(!text.includes(rawSecret.slice(0, 8)), `the input was printed: ${text}`);
    assert.ok(!text.includes("FAKE_TOKEN made"), `the line was printed: ${text}`);
  }
  assert.equal(revision(), before);
});

const NAME_SHAPED_VALUE = "RegressionCanaryV8m3";

test("a value in the name position of a malformed line is never printed, from a file, stdin or base64, with or without --json", async () => {
  const { cli, seen, dir } = await start();
  const twoEntries = `FAKE_TOKEN=${NAME_SHAPED_VALUE}\n${NAME_SHAPED_VALUE}="unfinished`;
  writeFileSync(join(dir, "unclosed.env"), twoEntries);
  const sources = [
    ["--secrets", Buffer.from(twoEntries).toString("base64")],
    ["--secrets-file", "unclosed.env"],
    ["--secrets", `${NAME_SHAPED_VALUE}="unfinished`],
  ];
  for (const source of sources) {
    for (const json of [[], ["--json"]]) {
      const ran = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", ...source, ...json], dir);
      assert.equal(ran.exitCode, 1, JSON.stringify(ran));
      assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, /The quoted value on line \d of (the file given to --secrets-file|the dotenv file in base64 on stdin|stdin) has no closing quote/);
    }
  }
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `a name from the input was printed: ${text}`);
});

test("a value given by mistake as a --secret, a --secret-file or a --secrets-file is never printed, as a field, an option or a path", async () => {
  const { cli, seen, dir } = await start();
  const missing = await cli(["backend", "add", "fake", "--secret", `${NAME_SHAPED_VALUE}==`, "--secrets", "OTHER=one"]);
  assert.match(missing.stderr ?? "", /^Backend fake has no field by the name a --secret or --secret-file gives\. That name is not shown/, "an unknown field is named before a missing variable");
  const known = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secret", `${NAME_SHAPED_VALUE}==`, "--secrets", "FAKE_TOKEN=one"]);
  assert.match(known.stderr ?? "", /^Backend fake has no field by the name a --secret or --secret-file gives\./);
  const missingVariable = await cli(["backend", "add", "fake", "--secret", "token=MISSING", "--secrets", "OTHER=one"]);
  assert.match(missingVariable.stderr ?? "", /^The variable that the 1st --secret names is not in the line on stdin\./);
  const unknownField = await cli(["backend", "add", "fake", "--secret", `${NAME_SHAPED_VALUE}=OTHER`, "--secrets", "OTHER=one", "--json"]);
  assert.match(`${unknownField.stdout}${unknownField.stderr}`, /Backend fake has no field by the name a --secret or --secret-file gives\. That name is not shown/);
  const unknownOption = await cli(["option", "set", "general.tailnet.mode=oauth", "--secret", `${NAME_SHAPED_VALUE}=OTHER`, "--secrets", "OTHER=one"]);
  assert.match(unknownOption.stderr ?? "", /^A --secret names no option\. That name is not shown/);
  assert.match(unknownOption.stderr ?? "", /The secret options are general\.tailnet\.clientId, general\.tailnet\.clientSecret/);
  const secretFile = await cli(["backend", "add", "fake", "--secret-file", `token=${NAME_SHAPED_VALUE}`], dir);
  assert.match(secretFile.stderr ?? "", /^Cannot read the file the 1st --secret-file gives: it was not found\. Its path is not shown/);
  const secretsFile = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets-file", NAME_SHAPED_VALUE, "--json"], dir);
  assert.match(`${secretsFile.stdout}${secretsFile.stderr}`, /Cannot read the file given to --secrets-file: it was not found\./);
  const folder = await cli(["backend", "add", "fake", "--secret", "token=FAKE_TOKEN", "--secrets-file", dir], dir);
  assert.match(folder.stderr ?? "", /^Cannot read the file given to --secrets-file: it is a folder\./);
  const unknownClear = await cli(["backend", "add", "fake", "--clear-secret", NAME_SHAPED_VALUE, "--json"]);
  assert.match(`${unknownClear.stdout}${unknownClear.stderr}`, /Backend fake has no field by the name a --clear-secret gives\. That name is not shown, as it may be a secret\./);
  assert.match(`${unknownClear.stdout}${unknownClear.stderr}`, /Its secret fields are token\./);
  const optionMissing = await cli(["option", "set", "general.tailnet.mode=oauth", "--secret", `${NAME_SHAPED_VALUE}==`, "--secrets", "OTHER=one"]);
  assert.match(optionMissing.stderr ?? "", /^A --secret names no option\./, "an unknown option is named before a missing variable");
  for (const ran of [missing, known, missingVariable, unknownField, unknownOption, secretFile, secretsFile, folder, unknownClear, optionMissing]) assert.equal(ran.exitCode, 1);
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `a value given by mistake was printed: ${text}`);
});

function draftWithToken(token: string): string {
  return JSON.stringify({ backends: [{ id: "fake", type: "fake", enabled: true, fields: { token } }] }, null, 2);
}

test("a configuration file that is not JSON is refused by line, column and kind, never its path or text, plain or --json", async () => {
  const { cli, seen, dir } = await start();
  const broken = draftWithToken(NAME_SHAPED_VALUE).replace(`"${NAME_SHAPED_VALUE}"`, `"${NAME_SHAPED_VALUE}"x`);
  const faultLine = broken.split("\n").findIndex((line) => line.includes(NAME_SHAPED_VALUE));
  const faultColumn = broken.split("\n")[faultLine]!.indexOf(`"x`) + 2;
  writeFileSync(join(dir, `${NAME_SHAPED_VALUE}.json`), broken);
  for (const command of ["check", "apply"]) {
    for (const json of [[], ["--json"]]) {
      const ran = await cli(["config", command, `${NAME_SHAPED_VALUE}.json`, ...json], dir);
      assert.equal(ran.exitCode, 1);
      assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, new RegExp(`The configuration file is not valid JSON, at line ${faultLine + 1}, column ${faultColumn}: a character JSON does not allow there\\. Its path and text are not shown`));
    }
  }
  const missing = await cli(["config", "check", NAME_SHAPED_VALUE], dir);
  assert.match(missing.stderr ?? "", /^Cannot read the configuration file: it was not found\. Its path and text are not shown/);
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `the configuration file's path or text was printed: ${text}`);
});

type DraftObject = Record<string, any>;

const UNKNOWN_KEY_PLACES: ((draft: DraftObject, key: string) => void)[] = [
  (draft, key) => {
    draft[key] = 1;
  },
  (draft, key) => {
    draft.general = { [key]: 1 };
  },
  (draft, key) => {
    draft.general = { snapshots: { [key]: 1, ceilings: { [key]: "a lot" } } };
  },
  (draft, key) => {
    draft.general = { tailnet: { mode: "off", [key]: 1 } };
  },
  (draft, key) => {
    draft.monitor = { [key]: 1 };
  },
  (draft, key) => {
    draft.kinds = { [key]: { enabled: "yes" } };
  },
  (draft, key) => {
    draft.kinds = { linux: { [key]: 1, largest: { [key]: 1 }, presets: { [key]: {}, small: { [key]: 1 } } } };
  },
  (draft, key) => {
    draft.images = { [key]: { kinds: 1 } };
  },
  (draft, key) => {
    draft.images = { good: { kinds: ["linux"], script: "true", projects: ["prj_cli"], [key]: 1 } };
  },
  (draft, key) => {
    Object.assign(draft.backends[0], { [key]: 1, warm: { [key]: "two" } });
    draft.backends[0].fields[key] = 1;
  },
  (draft, key) => {
    draft.backends[0].hosts = [{ name: "host-1", [key]: 1, fields: { [key]: 1 } }];
  },
];

const REJECTED_VALUE_PLACES: ((draft: DraftObject, value: string) => void)[] = [
  (draft, value) => {
    draft.schema = value;
  },
  (draft, value) => {
    draft.general = { defaultKind: value };
  },
  (draft, value) => {
    draft.images = { valid: { kinds: [value], script: "true", projects: ["prj_cli"] } };
  },
  (draft, value) => {
    draft.backends.push({ id: "other", type: value, enabled: false });
  },
  (draft, value) => {
    draft.general = { files: [{ path: `/${value}`, content: "made up" }] };
  },
  (draft, value) => {
    draft.backends.push({ id: "ssh-pool", type: "ssh-pool", enabled: true, fields: { machines: value, "known-hosts": value } });
  },
];

function draftWithRejectedValue(token: string, value: string, place: number): string {
  const draft = JSON.parse(draftWithToken(token)) as DraftObject;
  REJECTED_VALUE_PLACES[place]!(draft, value);
  return JSON.stringify(draft, null, 2);
}

test("a rejected value in a configuration file is named by its place, and never reaches the change summary, plain or --json", async () => {
  const { cli, seen, dir } = await start();
  for (const [place] of REJECTED_VALUE_PLACES.entries()) {
    writeFileSync(join(dir, `rejected-${place}.json`), draftWithRejectedValue("made-up-token-value", NAME_SHAPED_VALUE, place));
    for (const command of ["check", "apply"]) {
      for (const json of [[], ["--json"]]) {
        const ran = await cli(["config", command, `rejected-${place}.json`, ...json], dir);
        if (!json.length) assert.equal(ran.exitCode, 1, `place ${place}: ${JSON.stringify(ran)}`);
        assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, /is not shown, as it may be a secret|No backend offers|not one BB Box knows|on line 1/, `place ${place}`);
      }
    }
  }
  const defaultKind = await cli(["config", "check", "rejected-1.json"], dir);
  assert.match(defaultKind.stdout ?? "", /  general\.defaultKind: There is no kind by the name general\.defaultKind gives\. The kinds are /);
  assert.ok(!(defaultKind.stdout ?? "").includes("It would change"), "a rejected value never reaches the change summary");
  const offBackend = await cli(["config", "check", `rejected-${REJECTED_VALUE_PLACES.length - 1}.json`], dir);
  assert.match(offBackend.stdout ?? "", /It would change these, whose values are not shown while the file has problems:\n/);
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `a rejected value was printed: ${text}`);
});

test("a rejected command line value is never printed, as a field, kind, option, backend, host, project, line, path or number", async () => {
  const { cli, seen, dir } = await start();
  assert.equal((await cli(["backend", "add", "fake"])).exitCode, 0);
  assert.equal((await cli(["backend", "add", "ssh-pool", "--off", "--no-doctor"])).exitCode, 0);
  const value = NAME_SHAPED_VALUE;
  const refusals = [
    ["backend", "set", value],
    ["backend", "add", value],
    ["backend", "set", "fake", "--field", `${value}=one`],
    ["backend", "set", "fake", "--unset", value],
    ["backend", "set", "fake", "--field", value],
    ["backend", "set", "ssh-pool", "--field", `ios-hosts-most=${value}`],
    ["backend", "set", "ssh-pool", "--remove-line", `machines=${value}`],
    ["backend", "set", "ssh-pool", "--add-line", `${value}=line`],
    ["backend", "set", "fake", "--warm", `${value}=1`],
    ["backend", "set", "fake", "--warm", `linux=${value}`],
    ["backend", "set", "fake", "--projects", value],
    ["backend", "set", "fake", "--field-file", `address=${value}`],
    ["backend", "host", "set", "fake", value],
    ["backend", "host", "add", "fake", value],
    ["kind", "set", value, "--spares", "1"],
    ["kind", "set", "linux", "--cores", value],
    ["option", "set", `${value}=1`],
    ["option", "set", `boxesPerThread=${value}`],
    ["option", "set", `general.snapshots.ceilings.${value}=abc`],
    ["option", "get", value],
    ["image", "remove", value],
    ["image", "show", value],
    ["image", "set", "made-up", "--kinds", "linux", "--projects", "prj_cli", "--script-file", value],
    ["acquire", "linux", "--gpu", value],
  ];
  for (const args of refusals) {
    for (const json of [[], ["--json"]]) {
      const ran = await cli([...args, ...json], dir);
      assert.notEqual(ran.exitCode, 0, `${args.join(" ")} was not refused: ${JSON.stringify(ran)}`);
    }
  }
  for (const text of seen) assert.ok(!text.includes(value), `a rejected value was printed: ${text}`);
});

test("a word the parser refuses is named by its own place when the same text comes earlier, plain or --json", async () => {
  const { cli, seen } = await start();
  const cases: [string[], RegExp][] = [
    [["backend", "set", "fake", "--revision", "fake"], /invalid value \(word 5 after bb box, not shown, as it may be a secret\) for --revision/],
    [["list", "--thread", "extra", "extra"], /unexpected argument \(word 4 after bb box, not shown, as it may be a secret\)/],
    [["backend", "set", "fake", "--revision=fake"], /invalid value \(word 4 after bb box, not shown, as it may be a secret\) for --revision/],
    [["backend", "set", "--zzz", "fake", "--zzz"], /unknown option \(word 3 after bb box, not shown, as it may be a secret\)/],
  ];
  for (const [args, words] of cases) {
    for (const json of [[], ["--json"]]) {
      const ran = await cli([...args, ...json]);
      assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, words, args.join(" "));
    }
  }
  for (const text of seen) assert.ok(!text.includes("'extra'") && !text.includes("'fake'"), `a refused word was quoted: ${text}`);
});

function draftWithUnknownKey(token: string, key: string, place: number): string {
  const draft = JSON.parse(draftWithToken(token)) as DraftObject;
  UNKNOWN_KEY_PLACES[place]!(draft, key);
  return JSON.stringify(draft, null, 2);
}

test("an unknown key in a valid configuration file is named by its place, never its text, by check and apply, plain or --json", async () => {
  const { cli, seen, dir } = await start();
  for (const [place] of UNKNOWN_KEY_PLACES.entries()) {
    writeFileSync(join(dir, `unknown-${place}.json`), draftWithUnknownKey("made-up-token-value", NAME_SHAPED_VALUE, place));
    for (const command of ["check", "apply"]) {
      for (const json of [[], ["--json"]]) {
        const ran = await cli(["config", command, `unknown-${place}.json`, ...json], dir);
        if (!json.length) assert.equal(ran.exitCode, 1, `place ${place}: ${JSON.stringify(ran)}`);
        assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, /key in .+ is not one BB Box knows here\. Its name is not shown, as it may be a secret\./, `place ${place}`);
      }
    }
  }
  const general = await cli(["config", "check", "unknown-1.json"], dir);
  assert.match(general.stdout ?? "", /  general\.#1: The 1st key in general is not one BB Box knows here\. Its name is not shown, as it may be a secret\. There are boxesPerThread, /);
  const field = await cli(["config", "check", "unknown-9.json"], dir);
  assert.match(field.stdout ?? "", /  backends\.fake\.fields\.#2: The 2nd key in backends\.fake\.fields is not one BB Box knows here\. .* The fields of backend fake are /);
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `an unknown key was printed: ${text}`);
});

test("the settings page keeps naming an unknown key in its own draft, and only the CLI's form leaves it out", () => {
  const draft = readDraft({ general: { [NAME_SHAPED_VALUE]: 1 } }, [fakeDriver(tempDir("unknown-key"))]);
  assert.deepEqual(draft.problems.map((problem) => problem.path), [`general.${NAME_SHAPED_VALUE}`]);
  assert.match(draft.problems[0]!.message, new RegExp(`There is no general setting "${NAME_SHAPED_VALUE}"`));
  assert.equal(draft.problems[0]!.unnamed?.path, "general.#1");
  assert.ok(!JSON.stringify(draft.problems[0]!.unnamed).includes(NAME_SHAPED_VALUE));
});

test("a word the command line parser refuses is named by its place, never its text, plain or --json", async () => {
  const { cli, seen, dir } = await start();
  writeFileSync(join(dir, "empty.json"), "{}");
  const cases: [string[], RegExp][] = [
    [[NAME_SHAPED_VALUE], /unknown command \(word 1 after bb box, not shown, as it may be a secret\)/],
    [["config", NAME_SHAPED_VALUE], /unknown command \(word 2 after bb box, not shown, as it may be a secret\)/],
    [["backend", "add", "fake", `-${NAME_SHAPED_VALUE}`], /unknown option \(word 4 after bb box, not shown, as it may be a secret\)/],
    [["backend", "add", "fake", `--${NAME_SHAPED_VALUE}=one`], /unknown option \(word 4 after bb box, not shown, as it may be a secret\)/],
    [["backend", "add", "fake", "--revision", NAME_SHAPED_VALUE], /invalid value \(word 5 after bb box, not shown, as it may be a secret\) for --revision/],
    [["backend", "add", "fake", `--revision=${NAME_SHAPED_VALUE}`], /invalid value \(word 4 after bb box, not shown, as it may be a secret\) for --revision/],
    [["config", "check", "empty.json", NAME_SHAPED_VALUE], /unexpected argument \(word 4 after bb box, not shown, as it may be a secret\)/],
    [["config", "check", `-${NAME_SHAPED_VALUE}`], /unknown option \(word 3 after bb box, not shown, as it may be a secret\)/],
  ];
  for (const [args, words] of cases) {
    for (const json of [[], ["--json"]]) {
      const ran = await cli([...args, ...json], dir);
      assert.notEqual(ran.exitCode, 0);
      assert.match(`${ran.stdout ?? ""}${ran.stderr ?? ""}`, words, args.join(" "));
      if (json.length) assert.equal(JSON.parse(ran.stdout ?? "").ok, false);
    }
  }
  const suggested = await cli(["backend", "add", "fake", "--secrte", "token=FAKE_TOKEN"]);
  assert.match(suggested.stderr ?? "", /Did you mean --secret\?/);
  for (const text of seen) assert.ok(!text.includes(NAME_SHAPED_VALUE), `a refused word was printed: ${text}`);
});

const FUZZ_ROUNDS = 300;
const JSON_FUZZ_ROUNDS = 250;
const PARSER_FUZZ_ROUNDS = 150;
const FUZZ_SEED = 0x5eed_b0c5;
const SHORTEST_LEAK = 8;
const VALUE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-.";
const NAME_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

function leakedPiece(output: string, values: readonly string[]): string | null {
  for (const value of values) {
    for (let at = 0; at + SHORTEST_LEAK <= value.length; at += 1) {
      const piece = value.slice(at, at + SHORTEST_LEAK);
      if (output.includes(piece)) return piece;
    }
  }
  return null;
}

test("fuzzed secret input, arguments and configuration files never put 8 or more characters of a secret value in the output, plain or --json", async () => {
  const { cli, dir } = await start();
  const random = seededRandom(FUZZ_SEED);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const madeUpValue = () => Array.from({ length: 12 + Math.floor(random() * 30) }, () => pick([...VALUE_CHARACTERS])).join("");
  const madeUpName = () => `V${Array.from({ length: 11 + Math.floor(random() * 20) }, () => pick([...NAME_CHARACTERS])).join("")}`;
  const breakings: ((lines: string[], values: string[]) => string[])[] = [
    (lines, values) => [...lines, `${values[0]}="unfinished`],
    (lines, values) => [...lines, `${values[0]} unfinished`],
    (lines, values) => [...lines, `${values[0]}=named-by-a-value`],
    (lines) => lines,
    (lines) => lines.map((line, index) => (index === lines.length - 1 ? line.replace("=", " ") : line)),
    (lines, values) => [...lines, values[0]!],
    (lines, values) => [...lines.slice(0, -1), `${lines.at(-1)!.split("=")[0]}="${values.at(-1)}`],
    (lines, values) => [...lines.slice(0, -1), `${lines.at(-1)!.split("=")[0]}=${values.at(-1)!.slice(0, 6)}`, values.at(-1)!.slice(6)],
    (_lines, values) => [values[0]!],
  ];
  const commands: { readonly args: string[]; readonly field: string }[] = [
    { args: ["backend", "add", "fake", "--check"], field: "token" },
    { args: ["backend", "add", "fake", "--check", "--clear-secret", "token"], field: "token" },
    { args: ["option", "set", "general.tailnet.mode=oauth", "--check"], field: "general.tailnet.clientSecret" },
  ];
  const secretArguments: ((field: string, values: string[]) => string[])[] = [
    (field, values) => ["--secret", `${field}=${pick(["SECRET_0", "MISSING", values[0]!])}`],
    (_field, values) => ["--secret", `${values[0]}==`],
    (_field, values) => ["--secret", `${values[0]}=SECRET_0`],
    (_field, values) => ["--secret", values[0]!],
    (field, values) => ["--secret", `${field}=SECRET_0`, "--secret-file", `${field}=${values[0]}`],
    (_field, values) => ["--secret", `${values[0]}==`, "--secret", "token=MISSING"],
    (_field, values) => ["--clear-secret", values[0]!, "--secret", "token=SECRET_0"],
  ];
  const deliveries: ((file: string, round: number, values: string[]) => string[])[] = [
    (_file, _round, values) => ["--secrets-file", values[0]!],
    (file) => ["--secrets", Buffer.from(file).toString("base64")],
    (file) => ["--secrets", file.split("\n")[0]!],
    (file, round) => {
      writeFileSync(join(dir, `fuzz-${round}.env`), file);
      return ["--secrets-file", `fuzz-${round}.env`];
    },
  ];
  let refused = 0;
  for (let round = 0; round < FUZZ_ROUNDS; round += 1) {
    const values = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick([madeUpValue, madeUpName])());
    const lines = values.map((value, index) => `SECRET_${index}=${value}`);
    const file = pick(breakings)(lines, values).join("\n");
    const command = pick(commands);
    const json = pick([[], ["--json"]]);
    const ran = await cli([...command.args, ...pick(secretArguments)(command.field, values), ...pick(deliveries)(file, round, values), ...json], dir);
    if (ran.exitCode !== 0) refused += 1;
    const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
    assert.equal(leakedPiece(output, values), null, `round ${round} printed part of a value: ${output}`);
  }
  assert.ok(refused > FUZZ_ROUNDS / 4, `only ${refused} of ${FUZZ_ROUNDS} rounds were refused, so few error paths ran`);
  const jsonBreakings: ((draft: string, value: string) => string)[] = [
    (draft) => draft,
    (draft) => draft.slice(0, Math.floor(random() * draft.length)),
    (draft, value) => draft.replace(`"${value}"`, `"${value}`),
    (draft, value) => draft.replace(`"${value}"`, `"${value}"${pick(["x", "'", ",", "\\", "\u0001"])}`),
    (draft, value) => draft.replace(`"${value}"`, value),
    (draft, value) => draft.replace(`"${value}"`, `"${value.slice(0, 6)}\\q${value.slice(6)}"`),
    (draft, value) => draft.replace(`"${value}"`, `"${value.slice(0, 6)}\n${value.slice(6)}"`),
    (draft, value) => draft.replace(`"token"`, `"${value}" ${value}`),
    (draft, value) => `${draft}\n${value}`,
    (_draft, value) => draftWithUnknownKey("made-up-token-value", value, Math.floor(random() * UNKNOWN_KEY_PLACES.length)),
    (_draft, value) => draftWithUnknownKey(value, value, Math.floor(random() * UNKNOWN_KEY_PLACES.length)),
    (_draft, value) => draftWithRejectedValue("made-up-token-value", value, Math.floor(random() * REJECTED_VALUE_PLACES.length)),
  ];
  const parserRefusals: ((value: string) => string[])[] = [
    (value) => ["backend", "add", "fake", value],
    (value) => ["backend", "add", "fake", `-${value}`],
    (value) => ["backend", "add", "fake", "--revision", value],
    (value) => ["backend", "add", "fake", `--revision=${value}`],
    (value) => ["config", "check", "draft-0.json", value],
    (value) => ["config", value],
    (value) => [value],
    (value) => ["backend", "set", value, "--revision", value],
    (value) => ["list", "--thread", value, value],
  ];
  for (let round = 0; round < PARSER_FUZZ_ROUNDS; round += 1) {
    const value = madeUpValue();
    const ran = await cli([...pick(parserRefusals)(value), ...pick([[], ["--json"]])], dir);
    assert.notEqual(ran.exitCode, 0, `parser round ${round} was not refused`);
    const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
    assert.equal(leakedPiece(output, [value]), null, `parser round ${round} printed part of a value: ${output}`);
  }
  let jsonRefused = 0;
  for (let round = 0; round < JSON_FUZZ_ROUNDS; round += 1) {
    const value = madeUpValue();
    const name = `draft-${round}.json`;
    writeFileSync(join(dir, name), pick(jsonBreakings)(draftWithToken(value), value));
    const ran = await cli(["config", pick(["check", "apply"]), pick([name, `./${value}`, value]), ...pick([[], ["--json"]])], dir);
    if (ran.exitCode !== 0) jsonRefused += 1;
    const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
    assert.equal(leakedPiece(output, [value]), null, `JSON round ${round} printed part of a value: ${output}`);
  }
  assert.ok(jsonRefused > JSON_FUZZ_ROUNDS / 2, `only ${jsonRefused} of ${JSON_FUZZ_ROUNDS} JSON rounds were refused, so few error paths ran`);
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
  assert.match(unknown.stderr ?? "", /Backend ssh-pool has no field by the name a --field gives\. That name is not shown, as it may be a secret\. Its fields are machines, known-hosts, ssh-private-key, /);
  const none = await cli(["backend", "set", "ssh-pool", "--remove-line", "machines=build-9"]);
  assert.match(none.stderr ?? "", /No line of Machines \(machines\) is the text a --remove-line gives, or starts with it\. What was given is not shown, as it may be a secret\./);
  const notNumber = await cli(["backend", "set", "ssh-pool", "--field", "ios-hosts-ahead=two"]);
  assert.match(notNumber.stderr ?? "", /Ready slots kept on a shared iOS host \(ios-hosts-ahead\) is a number\. The value is not shown, as it may be a secret\./);
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
  assert.match((await cli(["backend", "fields", "nothing"])).stderr ?? "", /There is no backend type by the name given\. That name is not shown, as it may be a secret\. The types are fake, ssh-pool, tart\./);
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
  assert.match((await cli(["kind", "set", "linux-gpu"])).stderr ?? "", /There is no kind by the name given\. That name is not shown, as it may be a secret\. The kinds are /);
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
  assert.match((await cli(["option", "set", "monitor.refreshIntervalSeconds=1"])).stderr ?? "", /monitor\.refreshIntervalSeconds is a whole number from 2 to 60\. The value is not shown, as it may be a secret\./);
  assert.match((await cli(["option", "set", "colour=blue"])).stderr ?? "", /There is no option by the name given\. That name is not shown, as it may be a secret\. The options are general\.defaultKind, /);
  const kind = await cli(["option", "set", "defaultKind=plan9"]);
  assert.match(kind.stderr ?? "", /^Nothing was saved\. Fix these first:\n  general\.defaultKind: There is no kind by the name general\.defaultKind gives\. The kinds are /);
});

test("bb box option sets and unsets the snapshot settings that bite, within their ranges (070 unit 4)", async () => {
  const { cli, document } = await start();
  const set = await cli(["option", "set", "general.snapshots.perBox=3", "general.snapshots.roomPercent=70"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout ?? "", /general\.snapshots\.perBox: 5, the default → 3/);
  assert.deepEqual(document().general.snapshots, { perBox: 3, roomPercent: 70 });
  assert.match((await cli(["option", "get", "general.snapshots.roomPercent"])).stdout ?? "", /^general\.snapshots\.roomPercent = 70: How full a host's storage may be/);
  assert.match((await cli(["option", "set", "general.snapshots.roomPercent=95"])).stderr ?? "", /general\.snapshots\.roomPercent is a whole number from 50 to 90\. The value is not shown, as it may be a secret\./);
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
      "PADDED=bWFkZS11cA==",
      "",
      "LAST=a=b=c=",
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
    PADDED: "bWFkZS11cA==",
    LAST: "a=b=c=",
  });
});

test("a dotenv line that is not VARIABLE=value, or a quote never closed, is refused by its line number alone", () => {
  const raw = "made-up-line-without-equals-5e1d";
  assert.throws(() => parseDotenv(`# made up\nFIRST=one\n${raw}\n`, "the file secrets.env"), (error: Error) => {
    assert.equal(error.message, "Line 3 of the file secrets.env is not a VARIABLE=value line. Nothing was saved.");
    assert.ok(!JSON.stringify(error).includes(raw));
    return true;
  });
  const opened = "made-up-unclosed-value-77c0";
  assert.throws(() => parseDotenv(`FIRST=one\nSECOND="${opened}\nTHIRD=three\n`), (error: Error) => {
    assert.equal(error.message, "The quoted value on line 2 of the dotenv file has no closing quote. Nothing was saved.");
    assert.ok(!JSON.stringify(error).includes(opened.slice(0, 8)));
    return true;
  });
  assert.deepEqual(Object.fromEntries(parseDotenv("\uFEFFFIRST=one\r\n")), { FIRST: "one" });
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
  assert.match(unknown.stderr ?? "", /BB has no project by the 1st name or ID given\. That name is not shown, as it may be a secret\. Its projects are: Client work, Home, Twin, Twin\./);
  const twice = await cli(["backend", "set", "fake", "--projects", "twin"]);
  assert.equal(twice.exitCode, 1);
  assert.match(twice.stderr ?? "", /2 projects are called "twin": prj_twin_a, prj_twin_b\. Give its ID\./);
  assert.deepEqual(document().backends[0]!.projects, ["prj_cli", "prj_home"], "a refusal changes nothing");

  const cleared = await cli(["backend", "set", "fake", "--projects", "", "--no-doctor"]);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.match(cleared.stdout ?? "", /  backends\.fake\.projects: prj_cli, prj_home → every project\n/);
  assert.equal(document().backends[0]!.projects, undefined);
});
