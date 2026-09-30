import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandLine, EndMark } from "../src/transports/process.ts";
import { waitUntilAnswers } from "../src/transports/ready.ts";
import { KeyFile, Ssh, SshError, SshTransport, generateKeyPair, publicKey, quote } from "../src/transports/ssh.ts";
import { TransportError } from "../src/transports/types.ts";
import { at, fakeSsh, tempDir } from "./helpers.ts";

test("ssh dials once with a 2 s connect timeout and accepts a fresh box's first host key", () => {
  const ssh = new Ssh({ keyPath: "/k" });
  const args = ssh.args(at("192.0.2.5"), "uname -a");
  const joined = args.join(" ");
  assert.match(joined, /-p 22 /);
  assert.match(joined, /ConnectTimeout=2/);
  assert.match(joined, /ConnectionAttempts=1/);
  assert.match(joined, /BatchMode=yes/);
  assert.match(joined, /StrictHostKeyChecking=no/);
  assert.match(joined, /UserKnownHostsFile=\/dev\/null/);
  assert.doesNotMatch(joined, /ProxyCommand/);
  assert.deepEqual(args.slice(-3), ["box@192.0.2.5", "--", "uname -a"]);
});

test("pinned host keys are checked against the known_hosts file", () => {
  const access = { ...at("192.0.2.5"), port: 2222, hostKeys: ["192.0.2.5 ssh-ed25519 AAAA"] };
  assert.throws(() => new Ssh({ keyPath: "/k" }).args(access, "true"), /no known_hosts file/);
  const joined = new Ssh({ keyPath: "/k", knownHostsPath: "/known" }).args(access, "true").join(" ");
  assert.match(joined, /-p 2222 /);
  assert.match(joined, /StrictHostKeyChecking=yes -o UserKnownHostsFile=\/known/);
});

/** An ssh stand-in that logs each dial and runs ProxyCommand after expanding %h, %p and %% as OpenSSH does. */
const CHAIN_SSH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const option = (name) => args.find((arg, i) => args[i - 1] === "-o" && arg.startsWith(name + "="))?.slice(name.length + 1);
const port = args[args.indexOf("-p") + 1];
const forward = args.includes("-W") ? " -W " + args[args.indexOf("-W") + 1] : "";
const target = args.filter((arg) => /^[\\w.-]+@[\\w.-]+$/.test(arg)).at(-1);
appendFileSync(process.env.CHAIN_LOG, target + ":" + port + forward + "\\n");
const proxy = option("ProxyCommand");
if (proxy) {
  const host = target.split("@")[1];
  const expanded = proxy.replace(/%(.)/g, (_, c) => (c === "h" ? host : c === "p" ? port : c === "%" ? "%" : "%" + c));
  process.exit(spawnSync("sh", ["-c", expanded], { stdio: "inherit" }).status ?? 1);
}
`;

test("a jump host is reached with the same key and options, and nested jumps dial in turn", () => {
  const dir = tempDir("ssh-chain");
  const binary = join(dir, "ssh");
  writeFileSync(binary, CHAIN_SSH, { mode: 0o755 });
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  const ssh = new Ssh({ keyPath: "/k", binary });
  const bastion = { host: "bastion.example", port: 22, user: "jump", hostKeys: [] };
  const mac = { host: "mac.example", port: 2200, user: "admin", hostKeys: [], jump: bastion };
  const args = ssh.args({ ...at("10.0.0.5"), jump: mac }, "true");
  const log = join(dir, "log");
  execFileSync(binary, args, { env: { ...process.env, CHAIN_LOG: log } });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "box@10.0.0.5:22",
    "admin@mac.example:2200 -W 10.0.0.5:22",
    "jump@bastion.example:22 -W mac.example:2200",
  ]);
  const proxy = args.find((arg) => arg.startsWith("ProxyCommand="))!;
  assert.match(proxy, /'-i' '\/k'/, "the jump uses the same key");
});

test("a route to a port in the box is ssh -W", async () => {
  const ssh = new Ssh({ keyPath: "/k", binary: "ssh" });
  const route = await new SshTransport(ssh, at("192.0.2.5"), "linux").route(5900);
  assert.equal(route.type, "command");
  assert.deepEqual(route.type === "command" && route.argv.slice(-3), ["-W", "127.0.0.1:5900", "box@192.0.2.5"]);
  assert.ok(route.type === "command" && route.argv.includes("ExitOnForwardFailure=yes"));
});

test("run passes stdin, returns output and the exit code", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run(at("192.0.2.5"), "tr a-z A-Z; echo oops >&2; exit 3", { stdin: "hello" });
  assert.equal(result.stdout, "HELLO");
  assert.equal(result.stderr, "oops\n");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("run stops at the timeout", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run(at("192.0.2.5"), "sleep 5", { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3_000);
});

test("long output keeps its head and tail", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run(at("192.0.2.5"), "seq 1 20000", { maxOutputBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /^1\n2\n/);
  assert.match(result.stdout, /output truncated/);
  assert.match(result.stdout, /20000\n$/);
});

test("files go in and come out byte for byte", async () => {
  const { ssh, home } = fakeSsh();
  const data = Buffer.from([0, 1, 2, 255, 10, 39, 34]);
  await ssh.writeFile(at("192.0.2.6"), "dir with space/it's.bin", data, { mode: "0600" });
  const written = join(home("192.0.2.6"), "dir with space/it's.bin");
  assert.deepEqual(readFileSync(written), data);
  assert.equal(statSync(written).mode & 0o777, 0o600);
  assert.deepEqual(await ssh.readFile(at("192.0.2.6"), "dir with space/it's.bin", { maxBytes: 100 }), data);
  await assert.rejects(ssh.readFile(at("192.0.2.6"), "dir with space/it's.bin", { maxBytes: 3 }), /larger than 3 bytes/);
  await assert.rejects(ssh.readFile(at("192.0.2.6"), "missing", { maxBytes: 3 }), SshError);
});

test("waitUntilAnswers dials every second until the box answers", async () => {
  const { ssh, upAfter } = fakeSsh();
  upAfter("192.0.2.7", 2);
  const pauses: number[] = [];
  const ready = await waitUntilAnswers(new SshTransport(ssh, at("192.0.2.7"), "linux"), {
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
  assert.equal(await waitUntilAnswers(new SshTransport(ssh, at("192.0.2.8"), "linux"), { timeoutMs: 0, sleep: async () => {} }), false);
});

test("the SSH transport reports an unreachable box and refuses Windows file copies", async () => {
  const { ssh, down } = fakeSsh();
  const up = new SshTransport(ssh, at("192.0.2.9"), "linux");
  assert.equal((await up.run("exit 255")).exitCode, 255);
  down("192.0.2.10");
  const gone = new SshTransport(ssh, at("192.0.2.10"), "linux");
  await assert.rejects(gone.run("true"), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
  await assert.rejects(gone.readFile("x", { maxBytes: 10 }), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
  const windows = new SshTransport(ssh, at("192.0.2.9"), "windows");
  await assert.rejects(windows.writeFile("x", new Uint8Array()), (error: unknown) => error instanceof TransportError && error.code === "unsupported");
});

test("stream passes output on as it arrives", async () => {
  const { ssh } = fakeSsh();
  const chunks: Record<string, string> = { stdout: "", stderr: "" };
  const result = await new SshTransport(ssh, at("192.0.2.9"), "linux").stream("echo one; echo two >&2; exit 4", {
    onOutput: (chunk, from) => (chunks[from] += Buffer.from(chunk).toString("utf8")),
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(chunks, { stdout: "one\n", stderr: "two\n" });
});

test("the end mark is found across chunks, and output that only looks like it passes through", () => {
  const text = (chunk: Buffer) => chunk.toString("utf8");
  const split = new EndMark("<end>:");
  assert.equal(text(split.push(Buffer.from("out"))), "out");
  assert.equal(text(split.push(Buffer.from("put<e"))), "put", "a possible start of the mark is held back");
  assert.equal(text(split.push(Buffer.from("nd>:1"))), "");
  assert.equal(split.status, null, "the status is read up to its newline");
  assert.equal(text(split.push(Buffer.from("7\nlate"))), "");
  assert.equal(split.status, 17);
  assert.equal(text(split.push(Buffer.from("later"))), "", "output after the mark is dropped");

  const lookalike = new EndMark("<end>:");
  assert.equal(text(lookalike.push(Buffer.from("a<en"))), "a");
  assert.equal(text(lookalike.push(Buffer.from("d but not"))), "<end but not");
  assert.equal(text(lookalike.push(Buffer.from("x<"))), "x");
  assert.equal(text(lookalike.rest()), "<", "what was held back is output after all when the stream ends");
  assert.equal(lookalike.status, null);
});

/** A web server that keeps running, and writes its pid and port in its working directory. */
const SERVER = `import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
writeFileSync("server.pid", String(process.pid));
const server = createServer((_, response) => response.end("still here"));
server.listen(0, "127.0.0.1", () => writeFileSync("server.port", String(server.address().port)));
`;

test("run returns when the script's shell exits, and a server the script left in the background keeps running", async (t) => {
  const { ssh, home } = fakeSsh();
  const node = quote(process.execPath);
  // Each shell holds the session's output open until the server stops: a
  // subshell waiting for it, or bash's for a backgrounded list, as in the
  // form box_run's hints recommend.
  const forms = [`(nohup ${node} server.mjs >server.log 2>&1; echo stopped >>server.log) & echo started`];
  if (existsSync("/bin/bash")) forms.push(`bash -c ${quote(`cd web && nohup ${node} server.mjs >server.log 2>&1 &`)}; echo started`);
  for (const [index, form] of forms.entries()) {
    const host = `192.0.2.${20 + index}`;
    const web = join(home(host), "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "server.mjs"), SERVER);
    const started = Date.now();
    const result = await ssh.run(at(host), index ? form : `cd web && ${form}`, { timeoutMs: 20_000 });
    const pid = join(web, "server.pid");
    t.after(() => {
      if (existsSync(pid)) process.kill(Number(readFileSync(pid, "utf8")));
    });
    assert.deepEqual({ exitCode: result.exitCode, stdout: result.stdout, timedOut: result.timedOut }, { exitCode: 0, stdout: "started\n", timedOut: false }, form);
    assert.ok(Date.now() - started < 5_000, `run returned at once: ${form}`);
    const port = join(web, "server.port");
    for (let wait = 0; !existsSync(port) && wait < 100; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await fetch(`http://127.0.0.1:${readFileSync(port, "utf8")}/`);
    assert.equal(await response.text(), "still here", `the server answers after run returned: ${form}`);
  }
});

test("output a background process writes after the script's shell exits is not waited for", async () => {
  const { ssh } = fakeSsh();
  const result = await ssh.run(at("192.0.2.30"), "(sleep 3; echo late) & echo now", { timeoutMs: 20_000 });
  assert.equal(result.stdout, "now\n");
  assert.ok(result.durationMs < 2_500, "run returned before the background process wrote");
});

test("a timeout ends a run whose command line exited while something it started holds the output", async () => {
  // Without an end mark, as for PowerShell, a run waits for its output to close.
  const line = new CommandLine({ argv: (script) => ["sh", "-c", script], posix: false });
  const result = await line.run("(sleep 3; echo late) & echo now", { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, "now\n");
  assert.ok(result.durationMs < 2_500, "the run did not wait for the background process");
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
  const known = await keys.knownHosts(["192.0.2.5 ssh-ed25519 AAAA", ""]);
  assert.equal(readFileSync(known, "utf8"), "192.0.2.5 ssh-ed25519 AAAA\n");
  assert.equal(statSync(known).mode & 0o777, 0o600);
  await keys.dispose();
});
