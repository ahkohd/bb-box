import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkDesktopOrRepairExpiredPassword } from "../src/backends/windows.ts";
import type { CommandTransport } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const PWSH = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
const skip = PWSH ? false : "needs PowerShell 7 (pwsh) on the test machine";

interface WindowsAnswers {
  readonly expired?: boolean;
  readonly failingRead?: number;
  readonly setFails?: boolean;
  readonly netSetExit?: number;
  readonly keepsSettings?: boolean;
  readonly quserExit?: number;
  readonly quserOutput?: string;
  readonly shutdownExit?: number;
}

const NOBODY = { quserExit: 1, quserOutput: "No User exists for *" };
const LOGGED_IN = { quserExit: 0, quserOutput: " USERNAME  SESSIONNAME  ID  STATE\n box       console       1  Disc" };

const WINDOWS_STAND_INS = String.raw`$bbTest = Get-Content -LiteralPath $env:BB_TEST_ANSWERS -Raw | ConvertFrom-Json
function Note($what) { Add-Content -LiteralPath $env:BB_TEST_CALLS -Value $what }
function Test-Set { Test-Path -LiteralPath (Join-Path $HOME 'settings-set') }
function Get-LocalUser {
  [CmdletBinding()] param([string] $Name)
  $script:bbReads = 1 + [int] $script:bbReads
  if ($bbTest.failingRead -eq $script:bbReads) { Write-Error 'Access is denied.'; return }
  $never = -not $bbTest.expired -or ($bbTest.keepsSettings -and (Test-Set))
  [pscustomobject]@{ Name = $Name; PasswordLastSet = [datetime]'2020-01-01T00:00:00'; PasswordExpires = if ($never) { $null } else { (Get-Date).AddDays(-1) } }
}
function Set-LocalUser {
  [CmdletBinding()] param([string] $Name, [bool] $PasswordNeverExpires)
  if ($bbTest.setFails) { Write-Error 'Access is denied.'; return }
  Note 'Set-LocalUser'
  Set-Content -LiteralPath (Join-Path $HOME 'settings-set') -Value 1
}
function Get-CimInstance {
  [CmdletBinding()] param([string] $ClassName, [string] $Filter)
  [pscustomobject]@{ PasswordExpires = -not ($bbTest.keepsSettings -and (Test-Set)) }
}
function net.exe {
  if ($args[1] -eq '/maxpwage:unlimited') {
    $global:LASTEXITCODE = [int] $bbTest.netSetExit
    if ($bbTest.netSetExit) { 'System error 5 has occurred.' } else { Note 'net accounts /maxpwage:unlimited' }
    return
  }
  $global:LASTEXITCODE = 0
  "Maximum password age (days):     $(if ($bbTest.keepsSettings -and (Test-Set)) { 'Unlimited' } else { '42' })"
}
function quser.exe { $global:LASTEXITCODE = [int] $bbTest.quserExit; $bbTest.quserOutput -split "\n" }
function shutdown.exe { Note 'shutdown'; $global:LASTEXITCODE = [int] $bbTest.shutdownExit; if ($bbTest.shutdownExit) { 'Access is denied.(5)' } }
`;

function windowsInPowerShell(home: string, answers: WindowsAnswers): CommandTransport {
  const run = async (script: string) => {
    const file = join(home, "script.ps1");
    writeFileSync(join(home, "answers.json"), JSON.stringify({ shutdownExit: 0, netSetExit: 0, ...answers }));
    writeFileSync(file, `${WINDOWS_STAND_INS}\n${script}\n`);
    const env = { PATH: process.env.PATH, HOME: home, BB_TEST_ANSWERS: join(home, "answers.json"), BB_TEST_CALLS: join(home, "calls") };
    const ran = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", file], { env, encoding: "utf8" });
    return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
  };
  return { run } as unknown as CommandTransport;
}

function calls(home: string): string[] {
  return existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").split("\n").filter(Boolean) : [];
}

test("an expired password with nobody logged in, by Windows' own session list, is set never to expire and Windows restarts once", { skip }, async () => {
  const home = tempDir("windows-repair");

  const checked = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(home, { expired: true, keepsSettings: true, ...NOBODY }));

  assert.equal(checked.state, "restarting", JSON.stringify(checked));
  assert.deepEqual(calls(home), ["Set-LocalUser", "net accounts /maxpwage:unlimited", "shutdown"]);
});

test("a password that has not expired is left as it is", { skip }, async () => {
  const home = tempDir("windows-repair");

  const checked = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(home, { expired: false, ...NOBODY }));

  assert.equal(checked.state, "not up");
  assert.deepEqual(calls(home), []);
});

test("someone logged in, though no shell runs, stops the restart, and says so", { skip }, async () => {
  const home = tempDir("windows-repair");

  const checked = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(home, { expired: true, keepsSettings: true, ...LOGGED_IN }));

  assert.equal(checked.state, "refused");
  assert.match(checked.state === "refused" ? checked.said : "", /It now never expires, but someone is logged in to the box \(USERNAME .* box +console +1 +Disc\), so BB Box did not restart it\. Restart the box once their work is saved\./);
  assert.ok(!calls(home).includes("shutdown"), "no restart");
});

test("a session list Windows does not give stops the restart", { skip }, async () => {
  const home = tempDir("windows-repair");

  const checked = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(home, { expired: true, keepsSettings: true, quserExit: 5, quserOutput: "Error 0x000006BA enumerating sessionnames" }));

  assert.equal(checked.state, "refused");
  assert.match(checked.state === "refused" ? checked.said : "", /could not tell whether anyone is logged in to the box \(quser exited with 5: Error 0x000006BA enumerating sessionnames\), so it did not restart it/);
  assert.ok(!calls(home).includes("shutdown"));
});

test("a read-back that fails, or settings Windows did not keep, stop the restart", { skip }, async () => {
  const readBackFails = tempDir("windows-repair");
  const notKept = tempDir("windows-repair");

  const unread = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(readBackFails, { expired: true, keepsSettings: true, failingRead: 2, ...NOBODY }));
  const unkept = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(notKept, { expired: true, keepsSettings: false, ...NOBODY }));

  assert.equal(unread.state, "refused");
  assert.match(unread.state === "refused" ? unread.said : "", /could not read the settings back, so it did not restart the box: Access is denied\./);
  assert.equal(unkept.state, "refused");
  assert.match(unkept.state === "refused" ? unkept.said : "", /Windows did not keep the settings: the password expires True, the maximum password age is '42'\. BB Box did not restart the box\./);
  assert.ok(!calls(readBackFails).includes("shutdown"));
  assert.ok(!calls(notKept).includes("shutdown"));
});

test("a setting Windows refuses stops the repair before any restart", { skip }, async () => {
  const userRefused = tempDir("windows-repair");
  const policyRefused = tempDir("windows-repair");

  const user = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(userRefused, { expired: true, keepsSettings: true, setFails: true, ...NOBODY }));
  const policy = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(policyRefused, { expired: true, keepsSettings: true, netSetExit: 2, ...NOBODY }));

  assert.equal(user.state, "refused");
  assert.match(user.state === "refused" ? user.said : "", /BB Box could not set it never to expire: Access is denied\./);
  assert.equal(policy.state, "refused");
  assert.match(policy.state === "refused" ? policy.said : "", /net accounts \/maxpwage:unlimited exited with 2: System error 5 has occurred\./);
  assert.ok(!calls(userRefused).includes("shutdown"));
  assert.ok(!calls(policyRefused).includes("shutdown"));
});

test("a restart Windows refuses is a refusal, not a restart", { skip }, async () => {
  const home = tempDir("windows-repair");

  const checked = await checkDesktopOrRepairExpiredPassword(windowsInPowerShell(home, { expired: true, keepsSettings: true, shutdownExit: 5, ...NOBODY }));

  assert.equal(checked.state, "refused");
  assert.match(checked.state === "refused" ? checked.said : "", /It now never expires, but Windows refused the restart \(shutdown exited with 5: Access is denied\.\(5\)\)\. Restart the box\./);
});

test("Windows restarts once for a password: if it has expired again after the restart, the repair does not restart it again", { skip }, async () => {
  const home = tempDir("windows-repair");
  const box = windowsInPowerShell(home, { expired: true, keepsSettings: true, ...NOBODY });

  const first = await checkDesktopOrRepairExpiredPassword(box);
  rmSync(join(home, "settings-set"));
  const second = await checkDesktopOrRepairExpiredPassword(box);

  assert.equal(first.state, "restarting");
  assert.equal(second.state, "refused");
  assert.match(second.state === "refused" ? second.said : "", /BB Box restarted the box once for this password already, and it still expired, so it did not restart it again\./);
  assert.equal(calls(home).filter((call) => call === "shutdown").length, 1);
});
