// Windows boxes as BB machines, the trial (#539): the script that runs BB's
// Windows enrolment or reconnect command, and the setting that turns it on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQemuPart } from "../src/backends/proxmox-qemu/config.ts";
import { WINDOWS_COMMAND_SCRIPT, runWindowsCommand, windowsFailure } from "../src/plugin/enrol-windows.ts";
import type { CommandTransport, RunOptions, RunResult } from "../src/transports/types.ts";

test("BB's Windows command runs in the desktop session, after Node.js is made sure of, and goes as stdin, never in the script", async () => {
  const sent: { script: string; options: RunOptions }[] = [];
  const result: RunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
  const transport = { run: async (script: string, options: RunOptions = {}) => (sent.push({ script, options }), result) } as unknown as CommandTransport;
  const command = "irm https://bb.example.com/install.ps1 -Headers @{'X-BB-Enrollment'='secret-enrolment-credential'} | iex";
  await runWindowsCommand(transport, command, { timeoutMs: 60_000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.options.stdin, command);
  assert.ok(!sent[0]!.script.includes("secret-enrolment-credential"), "the credential is not in the script's text");
  assert.match(sent[0]!.script, /New-Object -ComObject Schedule\.Service/, "in the box user's desktop session, through a scheduled task");
  assert.match(WINDOWS_COMMAND_SCRIPT, /\$bbCommand = \[Console\]::In\.ReadToEnd\(\)\n\$global:LASTEXITCODE = 0\nInvoke-Expression \$bbCommand\nexit \$LASTEXITCODE/);
});

test("Node.js is installed first where it is missing: the pinned build, checked by its SHA-256, on the user's PATH", () => {
  assert.match(WINDOWS_COMMAND_SCRIPT, /\$bbHave -lt \[Version\]'22\.19\.0'/);
  assert.match(WINDOWS_COMMAND_SCRIPT, /https:\/\/nodejs\.org\/dist\/v24\.21\.0\/\$bbName\.zip/);
  assert.match(WINDOWS_COMMAND_SCRIPT, /x64 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'; arm64 = '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921'/);
  assert.match(WINDOWS_COMMAND_SCRIPT, /Get-FileHash -Algorithm SHA256 -LiteralPath \$bbZip\)\.Hash -ne \$bbSha/);
  assert.match(WINDOWS_COMMAND_SCRIPT, /SetEnvironmentVariable\('Path', .*'User'\)/);
});

test("a failed run says how it ended, with its last lines", () => {
  const result: RunResult = { exitCode: 1, stdout: "Installing bb\n", stderr: "bb-box: install.ps1 refused\n", timedOut: false, truncated: false, durationMs: 1 };
  assert.equal(windowsFailure("BB's Windows installer in box calm-otter", result), "BB's Windows installer in box calm-otter exited with 1:\nInstalling bb\n\nbb-box: install.ps1 refused");
});

test("Windows boxes join BB only when the Proxmox QEMU backend's trial setting is on", () => {
  const fields = { url: "https://192.0.2.10:8006", "token-id": "bbbox@pve!plugin", "token-secret": "x", "tls-fingerprint": Array(32).fill("AB").join(":") };
  const off = parseQemuPart({ fields } as never);
  const on = parseQemuPart({ fields: { ...fields, "windows-enrol": true } } as never);
  assert.ok(off.ok && on.ok, JSON.stringify([off, on]));
  assert.equal(off.ok && off.config.enrol, false);
  assert.equal(on.ok && on.config.enrol, true);
});
