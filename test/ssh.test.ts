import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { waitUntilAnswers } from "../src/transports/ready.ts";
import { KeyFile, Ssh, SshError, SshTransport, generateKeyPair, publicKey, quote } from "../src/transports/ssh.ts";
import { TransportError } from "../src/transports/types.ts";
import { fakeSsh, tempDir } from "./helpers.ts";

test("ssh dials port 22 once with a 2 s connect timeout and no host key file", () => {
  const ssh = new Ssh({ keyPath: "/k", user: "box" });
  const args = ssh.args("192.0.2.5", "uname -a");
  const joined = args.join(" ");
  assert.match(joined, /-p 22 /);
  assert.match(joined, /ConnectTimeout=2/);
  assert.match(joined, /ConnectionAttempts=1/);
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /UserKnownHostsFile=\/dev\/null/);
  assert.deepEqual(args.slice(-3), ["box@192.0.2.5", "--", "uname -a"]);
});

test("run passes stdin, returns output and the exit code", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run("192.0.2.5", "tr a-z A-Z; echo oops >&2; exit 3", { stdin: "hello" });
  assert.equal(result.stdout, "HELLO");
  assert.equal(result.stderr, "oops\n");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("run stops at the timeout", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run("192.0.2.5", "sleep 5", { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3_000);
});

test("long output keeps its head and tail", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run("192.0.2.5", "seq 1 20000", { maxOutputBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /^1\n2\n/);
  assert.match(result.stdout, /output truncated/);
  assert.match(result.stdout, /20000\n$/);
});

test("files go in and come out byte for byte", async () => {
  const { ssh, home } = fakeSsh();
  const data = Buffer.from([0, 1, 2, 255, 10, 39, 34]);
  await ssh.writeFile("192.0.2.6", "dir with space/it's.bin", data, { mode: "0600" });
  const written = join(home("192.0.2.6"), "dir with space/it's.bin");
  assert.deepEqual(readFileSync(written), data);
  assert.equal(statSync(written).mode & 0o777, 0o600);
  assert.deepEqual(await ssh.readFile("192.0.2.6", "dir with space/it's.bin", { maxBytes: 100 }), data);
  await assert.rejects(ssh.readFile("192.0.2.6", "dir with space/it's.bin", { maxBytes: 3 }), /larger than 3 bytes/);
  await assert.rejects(ssh.readFile("192.0.2.6", "missing", { maxBytes: 3 }), SshError);
});

test("waitUntilAnswers dials every second until the box answers", async () => {
  const { ssh, upAfter } = fakeSsh();
  upAfter("192.0.2.7", 2);
  const pauses: number[] = [];
  const ready = await waitUntilAnswers(new SshTransport(ssh, "192.0.2.7", "linux"), {
    timeoutMs: 10_000,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  assert.equal(ready, true);
  assert.equal(pauses.length, 2);
  for (const pause of pauses) assert.ok(pause <= 1_000 && pause > 500);
});

test("waitUntilAnswers gives up at the deadline", async () => {
  const { ssh, down } = fakeSsh();
  down("192.0.2.8");
  assert.equal(await waitUntilAnswers(new SshTransport(ssh, "192.0.2.8", "linux"), { timeoutMs: 0, sleep: async () => {} }), false);
});

test("the SSH transport reports an unreachable box and refuses Windows file copies", async () => {
  const { ssh, down } = fakeSsh();
  const up = new SshTransport(ssh, "192.0.2.9", "linux");
  assert.equal((await up.run("exit 255")).exitCode, 255);
  down("192.0.2.10");
  const gone = new SshTransport(ssh, "192.0.2.10", "linux");
  await assert.rejects(gone.run("true"), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
  await assert.rejects(gone.readFile("x", { maxBytes: 10 }), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
  const windows = new SshTransport(ssh, "192.0.2.9", "windows");
  await assert.rejects(windows.writeFile("x", new Uint8Array()), (error: unknown) => error instanceof TransportError && error.code === "unsupported");
});

test("stream passes output on as it arrives", async () => {
  const { ssh } = fakeSsh();
  const chunks: string[] = [];
  const result = await new SshTransport(ssh, "192.0.2.9", "linux").stream("echo one; echo two >&2; exit 4", { onOutput: (chunk) => chunks.push(chunk) });
  assert.equal(result.exitCode, 4);
  assert.match(chunks.join(""), /one/);
  assert.match(chunks.join(""), /two/);
});

test("generateKeyPair makes an ed25519 key", async () => {
  const pair = await generateKeyPair();
  assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(pair.publicKey, /^ssh-ed25519 \S+ bb-box$/);
});

test("quote survives single quotes", () => {
  assert.equal(execFileSync("sh", ["-c", `printf %s ${quote("it's a \"test\" $HOME")}`], { encoding: "utf8" }), `it's a "test" $HOME`);
});

test("the key file is private and yields its public key", async () => {
  const dir = tempDir("key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")]);
  const keys = new KeyFile();
  const path = await keys.path(readFileSync(join(dir, "k"), "utf8").trim());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await keys.path(readFileSync(join(dir, "k"), "utf8")), path);
  const pub = await publicKey(path);
  assert.match(pub!, /^ssh-ed25519 \S+ bb-box$/);
  assert.equal(pub!.split(" ")[1], readFileSync(join(dir, "k.pub"), "utf8").split(" ")[1]);
  await keys.dispose();
});
