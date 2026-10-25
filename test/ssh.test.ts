import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readFileScript, scriptText, writeFileScript } from "../src/transports/powershell.ts";
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
  assert.match(joined, /ServerAliveInterval=5 -o ServerAliveCountMax=6/, "a box that dies unseen ends the connection within about 35 s, and a link that stalls for 30 s keeps it");
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

test("the SSH transport reports an unreachable box", async () => {
  const { ssh, down } = fakeSsh();
  const up = new SshTransport(ssh, at("192.0.2.9"), "linux");
  assert.equal((await up.run("exit 255")).exitCode, 255);
  down("192.0.2.10");
  const gone = new SshTransport(ssh, at("192.0.2.10"), "linux");
  await assert.rejects(gone.run("true"), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
  await assert.rejects(gone.readFile("x", { maxBytes: 10 }), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
});

test("a box whose link dropped a command but answers again within the lost wait is not unreachable (#707)", async () => {
  const { ssh, upAfter, log } = fakeSsh({ lostWaitMs: 4_000 });
  const box = new SshTransport(ssh, at("192.0.2.11"), "linux");
  // The command's own dial and the first probe fail; the second probe answers.
  upAfter("192.0.2.11", 2);
  const result = await box.run("true");
  assert.equal(result.exitCode, 255, "the command's result stands");
  assert.equal(log().filter((entry) => entry.target.endsWith("192.0.2.11")).length, 3, "the command, a probe that failed and one that answered");
});

test("a Windows box runs each script in PowerShell, base64-encoded, so no quote reaches its command line", async () => {
  const { ssh, log, windows } = fakeSsh();
  windows("192.0.2.30");
  const box = new SshTransport(ssh, at("192.0.2.30"), "windows");
  const script = `echo "it's" \`printf %s ok\`; cat; exit 3`;
  const result = await box.run(script, { stdin: new TextEncoder().encode("in") });
  assert.deepEqual([result.exitCode, result.stdout], [3, "it's ok\nin"]);
  const [entry] = log();
  assert.doesNotMatch(entry!.command, /["`]/);
  assert.match(entry!.command, /^\$ProgressPreference='SilentlyContinue';.*;exit 0$/);
  assert.match(entry!.command, /if\(\$PSStyle\)\{\$PSStyle\.OutputRendering='PlainText'\}/, "output has no colours");
  assert.match(entry!.command, /;function Start-Detached\{.*\$env:ComSpec.* >'\+\$q\+\$o\+\$q\+' 2>&1'.*else\{\$r\.ProcessId\}\};\$global:LASTEXITCODE=0;& \(\[scriptblock\]::Create\(/, "the script can start commands outside its job");
  assert.match(entry!.command, /;function Start-Detached\{.*ProcessStartupInformation=\(New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @\{ShowWindow=\[uint16\]0\}\)\};/, "its cmd starts with no window, in the desktop session too (#916)");
  const encoded = /FromBase64String\('([^']+)'\)/.exec(entry!.command)![1]!;
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), `${script}\nif(-not $?){if($LASTEXITCODE){exit $LASTEXITCODE};exit 1}`);
  assert.equal(await box.probe(), true);
  assert.equal(log()[1]!.command, "exit 0", "the probe has no end marks, which are sh's");
});

test("a script too long for Windows' command line goes to a file in the box first", async () => {
  const { ssh, log, home, windows } = fakeSsh();
  windows("192.0.2.31");
  const box = new SshTransport(ssh, at("192.0.2.31"), "windows");
  const script = `: ${"x".repeat(40_000)}\ncat; exit 4`;
  const result = await box.run(script, { stdin: new TextEncoder().encode("in") });
  assert.deepEqual([result.exitCode, result.stdout, result.stderr], [4, "in", ""]);
  const entries = log();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.command.length < 4_000), "the script is not on the command line");
  const name = /'(bb-box-[0-9a-f]{16}\.ps1)'/.exec(entries[0]!.command)![1];
  assert.equal(/'(bb-box-[0-9a-f]{16}\.ps1)'/.exec(entries[1]!.command)![1], name);
  assert.deepEqual(readdirSync(join(home("192.0.2.31"), "tmp")), [], "the staged script is deleted before it runs");

  const output: string[] = [];
  const streamed = await box.stream(script, { stdin: new TextEncoder().encode("on"), onOutput: (chunk) => output.push(Buffer.from(chunk).toString()) });
  assert.deepEqual([streamed.exitCode, output.join("")], [4, "on"]);
});

test("a long script whose staging fails gives the staging's result", async () => {
  const { ssh, log, down, windows } = fakeSsh();
  windows("192.0.2.32");
  down("192.0.2.32");
  const result = await ssh.run(at("192.0.2.32"), `: ${"x".repeat(40_000)}`, {}, "windows");
  assert.equal(result.exitCode, 255);
  assert.match(result.stderr, /Connection refused/);
  assert.equal(log().length, 1, "the script is not run");
  const output: string[] = [];
  const streamed = await ssh.stream(at("192.0.2.32"), `: ${"x".repeat(40_000)}`, { onOutput: (chunk, from) => output.push(`${from}: ${Buffer.from(chunk).toString()}`) }, "windows");
  assert.equal(streamed.exitCode, 255);
  assert.match(output.join(""), /^stderr: ssh: connect to host 192\.0\.2\.32 port 22: Connection refused/);
});

test("a command spawned on a Windows box runs in PowerShell, with its stdin and stdout as the channel", async () => {
  const { ssh, log, windows, down } = fakeSsh();
  windows("192.0.2.33");
  const channel = await new SshTransport(ssh, at("192.0.2.33"), "windows").spawn("cat");
  const writer = channel.writable.getWriter();
  await writer.write(new TextEncoder().encode("ping\n"));
  const reader = channel.readable.getReader();
  const { value } = await reader.read();
  assert.equal(Buffer.from(value!).toString(), "ping\n");
  reader.releaseLock();
  writer.releaseLock();
  await channel.close();
  const [entry] = log();
  assert.match(entry!.command, /^\$ProgressPreference='SilentlyContinue';/);
  const encoded = /FromBase64String\('([^']+)'\)/.exec(entry!.command)![1]!;
  assert.match(Buffer.from(encoded, "base64").toString("utf8"), /^cat\n/);

  // A command too long for the command line is staged first, and a failed staging is an error.
  windows("192.0.2.34");
  down("192.0.2.34");
  await assert.rejects(ssh.spawn(at("192.0.2.34"), `: ${"x".repeat(40_000)}`, undefined, "windows"), (error: unknown) => error instanceof SshError && /could not start: .*Connection refused/.test(error.message));
});

/** A sh stand-in for PowerShell that writes and reads files as bb-box's Windows file copies do, and runs any other script with sh. */
const FILES = String.raw`p=$(printf '%s' "$1" | sed -n "1s/^try{\$p=\$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('\(.*\)');if(\[IO.Directory\].*/\1/p" | sed "s/''/'/g")
case "$1" in
  *OpenStandardInput*) mkdir -p "$(dirname "$p")" && cat > "$p" ;;
  *OpenStandardOutput*) cat -- "$p" ;;
  *) exec sh -c "$1" ;;
esac
`;

test("a Windows box's file copies run in PowerShell, with the file's bytes as their stdin and stdout", async () => {
  const { ssh, log, home, windows, powershell, down } = fakeSsh();
  windows("192.0.2.35");
  powershell("192.0.2.35", FILES);
  const box = new SshTransport(ssh, at("192.0.2.35"), "windows");
  const data = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
  await box.writeFile("dir with space/it's.bin", data, { mode: "0600" });
  assert.deepEqual(readFileSync(join(home("192.0.2.35"), "dir with space", "it's.bin")), Buffer.from(data));
  const script = (command: string) => Buffer.from(/FromBase64String\('([^']+)'\)/.exec(command)![1]!, "base64").toString("utf8");
  const [written] = log();
  assert.doesNotMatch(written!.command, /chmod|["`]/, "PowerShell writes the file, and the mode does not apply");
  assert.equal(script(written!.command), scriptText(writeFileScript("dir with space/it's.bin")));
  assert.match(writeFileScript("it's"), /FromPSPath\('it''s'\)/, "a quote in the path is doubled");

  assert.deepEqual(await box.readFile("dir with space/it's.bin", { maxBytes: 512 }), Buffer.from(data));
  assert.equal(script(log()[1]!.command), scriptText(readFileScript("dir with space/it's.bin")));
  await assert.rejects(box.readFile("dir with space/it's.bin", { maxBytes: 100 }), /^SshError: dir with space\/it's.bin is larger than 100 bytes\.$/);
  await assert.rejects(box.readFile("missing.bin", { maxBytes: 100 }), (error: unknown) => error instanceof SshError && /^Could not read missing.bin: exit 1 \(.*No such file/.test(error.message));

  // A path too long for the command line is staged first, and a failed staging is an error.
  windows("192.0.2.36");
  down("192.0.2.36");
  const long = "x".repeat(30_000);
  await assert.rejects(ssh.writeFile(at("192.0.2.36"), long, data, {}, "windows"), (error: unknown) => error instanceof SshError && error.message.startsWith(`Could not write ${long}: exit 255 (ssh: connect to host 192.0.2.36`));
  assert.equal(log().filter((entry) => entry.target === "box@192.0.2.36").length, 1, "the copy is not run");
  down("192.0.2.35");
  await assert.rejects(box.writeFile("x", data), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
});

test("commands to one box share a connection that bb-box opens once", async () => {
  const { ssh, log, dir } = fakeSsh({ share: true });
  const box = at("192.0.2.20");
  const results = await Promise.all([1, 2, 3].map((n) => ssh.run(box, `echo ${n}`)));
  assert.deepEqual(results.map((result) => result.stdout), ["1\n", "2\n", "3\n"]);
  await ssh.writeFile(box, "f", new TextEncoder().encode("x"));
  assert.equal((await ssh.readFile(box, "f", { maxBytes: 10 })).toString(), "x");
  assert.equal(await ssh.probe(box), true);

  const entries = log();
  const masters = entries.filter((entry) => entry.control === "master");
  assert.equal(masters.length, 1, "one shared connection");
  const path = masters[0]!.args.find((arg) => arg.startsWith("ControlPath="))!;
  assert.ok(path.startsWith(`ControlPath=${join(dir, "shared")}/`));
  assert.ok(masters[0]!.args.includes("ControlMaster=yes") && masters[0]!.args.includes("ControlPersist=120s"));
  const commands = entries.filter((entry) => !entry.control);
  assert.equal(commands.length, 6);
  for (const entry of commands.slice(0, 5)) assert.ok(entry.args.includes("ControlMaster=no") && entry.args.includes(path), entry.command);
  assert.ok(!commands[5]!.args.some((arg) => arg.startsWith("ControlPath=")), "a probe dials afresh");

  // Another box gets its own connection; forget closes only this box's.
  await ssh.run(at("192.0.2.21"), "true");
  await ssh.forget(box);
  assert.deepEqual(
    log().filter((entry) => entry.control === "exit").map((entry) => [entry.target, entry.args.includes(path)]),
    [["box@192.0.2.20", true]],
  );
  await ssh.run(box, "true");
  assert.equal(log().filter((entry) => entry.control === "master" && entry.target === "box@192.0.2.20").length, 2, "a forgotten box's next command opens a new connection");
  await ssh.dispose();
  assert.deepEqual(log().filter((entry) => entry.control === "exit").map((entry) => entry.target).sort(), ["box@192.0.2.20", "box@192.0.2.20", "box@192.0.2.21"]);
});

test("a terminal opens on the box's shared connection, with no handshake of its own (#916)", async () => {
  const { ssh, log, dir } = fakeSsh({ share: true });
  const box = at("192.0.2.20");
  await ssh.run(box, "true");
  const terminal = await ssh.terminal(box, { cols: 80, rows: 24 });
  const opened = () => log().find((entry) => (entry as { interactive?: boolean }).interactive);
  for (let tries = 0; tries < 100 && !opened(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  await terminal.close();
  const entries = log();
  const path = entries.find((entry) => entry.control === "master")!.args.find((arg) => arg.startsWith("ControlPath="))!;
  assert.ok(path.startsWith(`ControlPath=${join(dir, "shared")}/`));
  const shell = opened();
  assert.ok(shell, JSON.stringify(entries));
  assert.ok(shell.args.includes("ControlMaster=no") && shell.args.includes(path), "on the shared connection, not a handshake of its own");
  assert.equal(entries.filter((entry) => entry.control === "master").length, 1);
  await ssh.dispose();
});

test("forget closes only its own box's connection, when boxes behind one host share a user and address", async () => {
  const { ssh, log } = fakeSsh({ share: true });
  const vm = (port: number, mac: string) => ({ host: "127.0.0.1", port, user: "box", hostKeys: [], jump: at(mac) });
  const boxes = [vm(50001, "192.0.2.40"), vm(50002, "192.0.2.40"), vm(50001, "192.0.2.41")];
  for (const box of boxes) await ssh.run(box, "true");
  const paths = log()
    .filter((entry) => entry.control === "master")
    .map((entry) => entry.args.find((arg) => arg.startsWith("ControlPath="))!);
  assert.equal(new Set(paths).size, 3, "a connection each");
  const closed = () => log().filter((entry) => entry.control === "exit").map((entry) => entry.args.find((arg) => arg.startsWith("ControlPath="))!);
  await ssh.forget(boxes[0]!);
  assert.deepEqual(closed(), [paths[0]]);
  await ssh.dispose();
});

test("no more than 8 commands share a connection, and the rest dial alone", async () => {
  const { ssh, log } = fakeSsh({ share: true });
  const box = at("192.0.2.22");
  await Promise.all(Array.from({ length: 10 }, (_, n) => ssh.run(box, `sleep 0.3; echo ${n}`)));
  const commands = log().filter((entry) => !entry.control);
  assert.equal(commands.filter((entry) => entry.args.includes("ControlMaster=no")).length, 8);
  assert.equal(commands.filter((entry) => !entry.args.some((arg) => arg.startsWith("ControlPath="))).length, 2);
});

test("a box that cannot be reached gets no shared connection for 5 s, and SSH's own failure retires one", async () => {
  const { ssh, log, down } = fakeSsh({ share: true });
  const box = at("192.0.2.23");
  down("192.0.2.23");
  assert.equal((await ssh.run(box, "true")).exitCode, 255);
  assert.equal((await ssh.run(box, "true")).exitCode, 255);
  let entries = log();
  assert.equal(entries.filter((entry) => entry.control === "master").length, 1, "one try at a shared connection");
  assert.ok(entries.filter((entry) => !entry.control).every((entry) => !entry.args.some((arg) => arg.startsWith("ControlPath="))), "commands dial alone");

  const up = at("192.0.2.24");
  await ssh.run(up, "true");
  assert.equal((await ssh.run(up, "exit 255")).exitCode, 255);
  await ssh.run(up, "true");
  entries = log().filter((entry) => entry.target === "box@192.0.2.24");
  const paths = entries.filter((entry) => entry.control === "master").map((entry) => entry.args.find((arg) => arg.startsWith("ControlPath=")));
  assert.equal(paths.length, 2, "exit 255 retires the connection");
  assert.notEqual(paths[0], paths[1]);
  await ssh.dispose();
});

/** The sockets of the shared connections bb-box opened to `target`, in order. */
function sockets(entries: ReturnType<ReturnType<typeof fakeSsh>["log"]>, target: string): string[] {
  return entries
    .filter((entry) => entry.control === "master" && entry.target === target)
    .map((entry) => entry.args.find((arg) => arg.startsWith("ControlPath="))!.slice("ControlPath=".length));
}

test("a shared connection whose socket has gone, as when its box restarts, gives way to a new one", async () => {
  const { ssh, log } = fakeSsh({ share: true });
  const box = at("192.0.2.25");
  await ssh.run(box, "true");
  const [ended] = sockets(log(), "box@192.0.2.25");
  rmSync(ended!);
  assert.equal((await ssh.run(box, "echo 1")).stdout, "1\n");
  const [, next] = sockets(log(), "box@192.0.2.25");
  assert.ok(next && next !== ended, "a new shared connection");
  assert.ok(log().at(-1)!.args.includes(`ControlPath=${next}`), "the command used the new connection");
  await ssh.dispose();
  assert.deepEqual(log().filter((entry) => entry.control === "exit").map((entry) => entry.args.includes(`ControlPath=${next}`)), [true], "only the live one is closed");
});

test("a command that times out retires its shared connection, and forget and dispose close retired ones", async () => {
  const { ssh, log } = fakeSsh({ share: true });
  const box = at("192.0.2.26");
  await ssh.run(box, "true");
  assert.equal((await ssh.run(box, "sleep 5", { timeoutMs: 200 })).timedOut, true);
  await ssh.run(box, "true");
  const paths = sockets(log(), "box@192.0.2.26");
  assert.equal(paths.length, 2, "the timeout retired the first connection");
  const closed = () => log().filter((entry) => entry.control === "exit").map((entry) => entry.args.find((arg) => arg.startsWith("ControlPath="))!.slice("ControlPath=".length));
  await ssh.forget(box);
  assert.deepEqual(closed().sort(), [...paths].sort(), "forget closes the retired connection too");

  // A connection retired by a write that timed out is closed when bb-box stops.
  const other = at("192.0.2.27");
  await ssh.run(other, "true");
  await assert.rejects(ssh.writeFile(other, "f", new Uint8Array(), { timeoutMs: 1 }), /timed out/);
  await ssh.run(other, "true");
  const otherPaths = sockets(log(), "box@192.0.2.27");
  assert.equal(otherPaths.length, 2);
  await ssh.dispose();
  assert.deepEqual(closed().sort(), [...paths, ...otherPaths].sort());
});

test("the ready check opens the shared connection, which the box's next command uses", async () => {
  const { ssh, log, down } = fakeSsh({ share: true });
  const box = new SshTransport(ssh, at("192.0.2.28"), "linux");
  assert.equal(await box.answers(), true);
  await box.run("true");
  const [path] = sockets(log(), "box@192.0.2.28");
  const commands = log().filter((entry) => !entry.control && entry.target === "box@192.0.2.28");
  assert.equal(commands.length, 2);
  for (const entry of commands) assert.ok(entry.args.includes(`ControlPath=${path}`));
  down("192.0.2.29");
  assert.equal(await new SshTransport(ssh, at("192.0.2.29"), "linux").answers(), false);
  await ssh.dispose();
});

test("a command waits for a slow shared connection no longer than its timeout, or until aborted, then dials alone", async () => {
  const { ssh, log, holdShare } = fakeSsh({ share: true });
  const box = at("192.0.2.30");
  const commands = () => log().filter((entry) => !entry.control && entry.target === "box@192.0.2.30");
  const shared = (entry: { args: string[] }) => entry.args.some((arg) => arg.startsWith("ControlPath="));
  const open = holdShare("192.0.2.30");
  const started = Date.now();
  assert.equal((await ssh.run(box, "echo 1", { timeoutMs: 1_000 })).stdout, "1\n");
  assert.ok(Date.now() - started < 3_000, "it stopped waiting at its timeout");
  assert.equal(shared(commands()[0]!), false, "it dialled alone");

  const controller = new AbortController();
  const aborted = ssh.run(box, "echo 2", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("released")), 50);
  await assert.rejects(aborted, /released/);
  assert.equal(commands().length, 1, "an aborted command does not dial");

  open();
  assert.equal((await ssh.run(box, "echo 3")).stdout, "3\n");
  assert.equal(shared(commands().at(-1)!), true, "once it opens, commands use it");
  await ssh.dispose();
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

test("a script that prints the command lines in the box, as ps aux does, runs to its end", async () => {
  const line = new CommandLine({ argv: (script) => ["sh", "-c", script] });
  const result = await line.run('echo one; ps -o args= -p "$PPID"; echo two; exit 3', { timeoutMs: 10_000 });
  assert.match(result.stdout, /^one\n.*bb_box_status.*\ntwo\n$/s, "the wrapper's own command line is output, not its end");
  assert.equal(result.exitCode, 3);
});

test("a file read whose connection ends before its output's end mark fails, rather than give part of the file as all of it", async () => {
  const lostTail = (script: string): [string, ...string[]] => {
    const [first, second] = [...script.matchAll(/printf '%s%s%s\\n' '([^']*)' '([^']*)'/g)][0]!.slice(1);
    return ["sh", "-c", `printf 'the first part'; printf '%s0\\n' ${quote(`${first}${second}`)} >&2`];
  };
  const line = new CommandLine({ argv: lostTail });
  await assert.rejects(line.readFile("/tmp/file", { maxBytes: 1024, timeoutMs: 10_000 }), /Could not read \/tmp\/file: the connection ended before all of it arrived/);
  const whole = new CommandLine({ argv: (script) => ["sh", "-c", script] });
  assert.equal((await whole.readFile("/dev/null", { maxBytes: 1024, timeoutMs: 10_000 })).length, 0);
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
