import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APT = join(ROOT, "setup/proxmox-lxc/template/guest/apt.sh");
const MIRROR_ERROR = "E: Failed to fetch http://snapshot.ubuntu.com/ubuntu/dists/noble/InRelease  503  Service Unavailable [IP: 192.0.2.40 80]";
const DEB = "http://archive.ubuntu.com/ubuntu/pool/universe/c/cowsay/cowsay_3.03%2bdfsg2-8_all.deb";
const LONGER_THAN_THE_BUDGET_S = 2;
const SHORT_BUDGET_S = "1";

const APT_SAYS = {
  ok: "",
  "503": MIRROR_ERROR,
  "429": `E: Failed to fetch ${DEB}  429  Too Many Requests [IP: 192.0.2.40 80]`,
  stalled: `E: Failed to fetch ${DEB}  Connection failed [IP: 192.0.2.40 80]`,
  refused: `E: Failed to fetch ${DEB}  Could not connect to 192.0.2.40:80 (192.0.2.40). - connect (111: Connection refused)`,
  reset: `E: Failed to fetch ${DEB}  Error reading from server - read (104: Connection reset by peer) [IP: 192.0.2.40 80]`,
  "timed out": `E: Failed to fetch ${DEB}  Could not connect to 192.0.2.40:80 (192.0.2.40). - connect (110: Connection timed out)`,
  dns: `E: Failed to fetch ${DEB}  Temporary failure resolving 'archive.ubuntu.com'`,
  "half-served": `E: Failed to fetch ${DEB}  Hash Sum mismatch\n   Hashes of expected file:\n    - SHA256:0000`,
  "unknown package": "E: Unable to locate package bbbox-absent",
  "unmet dependencies": "The following packages have unmet dependencies:\n bbbox-conflict : Depends: bbbox-impossible but it is not installable\nE: Unable to correct problems, you have held broken packages.",
  "held package": "E: Held packages were changed and -y was used without --allow-change-held-packages.",
  "configuration error": "E: Syntax error /etc/apt/apt.conf.d/99broken:1: Extra junk at end of file",
  "slow, then served": "",
  "slow, then 503": MIRROR_ERROR,
} as const;

type AptSays = keyof typeof APT_SAYS;

function aptFails(says: AptSays): string {
  return `printf '%b\\n' "${APT_SAYS[says].replace(/"/g, '\\"')}" >&2; exit 100`;
}

function aptCall(says: AptSays): string {
  if (says === "ok") return "exit 0";
  if (says === "slow, then served") return `/bin/sleep ${LONGER_THAN_THE_BUDGET_S}; exit 0`;
  if (says === "slow, then 503") return `/bin/sleep ${LONGER_THAN_THE_BUDGET_S}; ${aptFails(says)}`;
  return aptFails(says);
}

function layout(...calls: AptSays[]): string {
  const dir = tempDir("apt-retry");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "calls"), "0");
  writeFileSync(join(dir, "log"), "");
  writeFileSync(join(dir, "sleeps"), "");
  writeFileSync(join(dir, "clock"), "0.00 0.00\n");
  const cases = calls.map((says, index) => `  ${index + 1}) ${aptCall(says)} ;;`).join("\n");
  writeFileSync(
    join(bin, "apt-get"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$APT_FAKE_LOG"
n=$(( $(cat "$APT_FAKE_CALLS") + 1 ))
echo "$n" > "$APT_FAKE_CALLS"
case $n in
${cases}
  *) ${aptCall(calls[calls.length - 1]!)} ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "sleep"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$APT_FAKE_SLEEPS"
read -r now _ < "$APT_RETRY_CLOCK"
echo "$(( \${now%%.*} + $1 )).00 0.00" > "$APT_RETRY_CLOCK"
exit 0
`,
    { mode: 0o755 },
  );
  return dir;
}

function run(dir: string, body: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", body], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      APT_SCRIPT: APT,
      APT_FAKE_LOG: join(dir, "log"),
      APT_FAKE_CALLS: join(dir, "calls"),
      APT_FAKE_SLEEPS: join(dir, "sleeps"),
      APT_RETRY_CLOCK: join(dir, "clock"),
      APT_RETRY_SLEEP_SCALE: "0",
      APT_RETRY_TRIES: "5",
      ...env,
    },
  });
}

function lines(dir: string, name: string): string[] {
  const text = readFileSync(join(dir, name), "utf8");
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

test("apt-get update tries again after one mirror failure, and passes Acquire::Retries", () => {
  for (const delay of ["1", "0"] as const) {
    const dir = layout("503", "ok");
    const ran = run(dir, '. "$APT_SCRIPT"\napt_update -q --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: delay });
    assert.equal(ran.status, 0, ran.stderr);
    const calls = lines(dir, "log");
    assert.equal(calls.length, 2, calls.join("\n"));
    for (const call of calls) {
      assert.match(call, /^-o Acquire::Retries=5( -o Acquire::Retries::Delay=true)? update -q --error-on=any$/);
      if (delay === "1") assert.match(call, /^-o Acquire::Retries=5 -o Acquire::Retries::Delay=true update /);
      else assert.doesNotMatch(call, /Delay/);
    }
    assert.deepEqual(lines(dir, "sleeps"), ["0"]);
    assert.equal(ran.stderr.includes("503"), false);
    assert.match(ran.stderr, /apt-get -o Acquire::Retries=5( -o Acquire::Retries::Delay=true)? update -q --error-on=any failed \(try 1 of 5\), as the package archive did not serve it; retrying in 0 s/);
  }
});

test("apt-get update fails only when every try fails, and shows that last error", () => {
  const dir = layout("503");
  const ran = run(dir, '. "$APT_SCRIPT"\napt_update --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: "1" });
  assert.equal(ran.status, 100);
  assert.equal(lines(dir, "log").length, 5);
  assert.deepEqual(lines(dir, "sleeps"), ["0", "0", "0", "0"]);
  assert.equal(ran.stderr.split("503").length - 1, 1);
  assert.match(ran.stderr, /InRelease {2}503 {2}Service Unavailable/);
  assert.match(ran.stderr, /try 4 of 5/);
  assert.doesNotMatch(ran.stderr, /try 5 of 5/);
});

test("running apt.sh update is the same retry", () => {
  const once = layout("503", "ok");
  const passed = run(once, 'bash "$APT_SCRIPT" update -q --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: "0" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(lines(once, "log").length, 2);

  const always = layout("503");
  const failed = run(always, 'bash "$APT_SCRIPT" update --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: "1" });
  assert.equal(failed.status, 100);
  assert.equal(failed.stderr.split("503").length - 1, 1);
  assert.match(lines(always, "log")[0]!, /Acquire::Retries::Delay=true/);
});

test("apt-get install downloads under the retry, so it rides out an outage, then installs from the cache", () => {
  const dir = layout("503", "ok");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q --no-install-recommends jq\n', { APT_RETRY_DELAY_SUPPORTED: "1" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(lines(dir, "log"), [
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install --download-only -y -q --no-install-recommends jq",
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install --download-only -y -q --no-install-recommends jq",
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install -y -q --no-install-recommends jq",
  ]);
  assert.deepEqual(lines(dir, "sleeps"), ["0"]);
  assert.match(ran.stderr, /install --download-only -y -q --no-install-recommends jq failed \(try 1 of 5\), as the package archive did not serve it; retrying in 0 s/);
});

test("an outage longer than every try fails the install with the archive's error and what to do", () => {
  const dir = layout("503");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_SLEEP_SCALE: "30" });

  assert.equal(ran.status, 100);
  assert.equal(lines(dir, "log").length, 5);
  assert.ok(lines(dir, "log").every((call) => call.includes("--download-only")), "nothing is installed from a download that failed");
  assert.deepEqual(lines(dir, "sleeps"), ["30", "60", "90", "120"]);
  assert.match(ran.stderr, /503 {2}Service Unavailable/);
  assert.match(ran.stderr, /apt: apt-get -o Acquire::Retries=5 install --download-only -y -q jq failed 5 times over 300 s\. The package archive did not serve it for 300 s after its first failure, and its tries go on for at most 600 s after that: check the errors above, then build again\.$/m);
});

test("an error that is not the archive's fails at once with apt's own message, and is not tried again", () => {
  for (const says of ["unknown package", "unmet dependencies", "held package", "configuration error"] as const) {
    const dir = layout(says, "ok");

    const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_SLEEP_SCALE: "30" });

    assert.equal(ran.status, 100, says);
    assert.equal(lines(dir, "log").length, 1, says);
    assert.deepEqual(lines(dir, "sleeps"), [], says);
    assert.ok(ran.stderr.includes(APT_SAYS[says].split("\n").at(-1)!), ran.stderr);
    assert.match(ran.stderr, /apt: apt-get -o Acquire::Retries=5 install --download-only -y -q jq failed for a reason other than the package archive, so it was not tried again: see apt's message above\.$/m);
  }
});

test("each way the archive fails to serve a file is tried again", () => {
  for (const says of ["503", "429", "stalled", "refused", "reset", "timed out", "dns", "half-served"] as const) {
    const dir = layout(says, "ok");

    const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0" });

    assert.equal(ran.status, 0, `${says}: ${ran.stderr}`);
    assert.equal(lines(dir, "log").length, 3, says);
  }
});

test("the tries stop before a wait that would pass their budget, counted from the first failure", () => {
  const dir = layout("503");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_SLEEP_SCALE: "30", APT_RETRY_BUDGET_S: "100" });

  assert.equal(ran.status, 100);
  assert.deepEqual(lines(dir, "sleeps"), ["30", "60"]);
  assert.match(ran.stderr, /jq failed 3 times over 90 s\. The package archive did not serve it for 90 s after its first failure, and its tries go on for at most 100 s after that/);
});

test("a download still arriving when the budget would end is not stopped", () => {
  const dir = layout("slow, then served", "ok");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_BUDGET_S: SHORT_BUDGET_S });

  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(lines(dir, "log"), ["-o Acquire::Retries=5 install --download-only -y -q jq", "-o Acquire::Retries=5 install -y -q jq"]);
  assert.doesNotMatch(ran.stderr, /stopped|failed/);
});

test("a long download that the archive then fails is tried again, as the budget starts at the failure", () => {
  const dir = layout("slow, then 503", "ok");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_BUDGET_S: SHORT_BUDGET_S });

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(lines(dir, "log").length, 3);
  assert.match(ran.stderr, /jq failed \(try 1 of 5\), as the package archive did not serve it; retrying in 0 s/);
});

test("running apt.sh install is the same retry", () => {
  const dir = layout("503", "ok");

  const ran = run(dir, 'bash "$APT_SCRIPT" install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(lines(dir, "log").length, 3);
});

test("the wait and the try count default to the build's, and delay follows this apt", () => {
  const source = readFileSync(APT, "utf8");
  assert.match(source, /APT_RETRY_TRIES:-5/);
  assert.match(source, /APT_RETRY_SLEEP_SCALE:-30/);
  const dir = layout("ok");
  const ran = run(dir, '. "$APT_SCRIPT"\nif apt_retry_delay_supported; then echo yes; else echo no; fi\napt_update -q\n', { APT_RETRY_TRIES: "1" });
  assert.equal(ran.status, 0, ran.stderr);
  const probe = spawnSync(
    "bash",
    ["-c", 'shopt -s nullglob; files=(/usr/lib/*/libapt-pkg.so.* /usr/lib/libapt-pkg.so.*); if [ ${#files[@]} -eq 0 ]; then echo no; elif grep -a -q -F \'Acquire::Retries::Delay\' "${files[@]}"; then echo yes; else echo no; fi'],
    { encoding: "utf8" },
  );
  const supported = probe.stdout.trim() === "yes";
  assert.equal(ran.stdout.trim(), supported ? "yes" : "no");
  const call = lines(dir, "log")[0]!;
  assert.match(call, /^-o Acquire::Retries=5 /);
  if (supported) assert.match(call, /Acquire::Retries::Delay=true/);
  else assert.doesNotMatch(call, /Delay/);
});

test("image builds do not call apt-get update or apt-get install on their own", () => {
  const guest = join(ROOT, "setup/proxmox-lxc/template/guest");
  const files = [
    ...readdirSync(guest)
      .filter((name) => name.endsWith(".sh"))
      .map((name) => join(guest, name)),
    join(ROOT, "setup/docker/customize.sh"),
    join(ROOT, "setup/docker/Dockerfile"),
    join(ROOT, "setup/proxmox-qemu/linux/customize-vm.sh"),
    join(ROOT, "setup/tart/prepare-linux-image.sh"),
    join(ROOT, "setup/boat/template.sh"),
    join(ROOT, "setup/android/customize-android.sh"),
  ];
  const raw: string[] = [];
  for (const file of files) {
    const relative = file.slice(ROOT.length);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const code = line.replace(/#.*/, "");
        if (!/\bapt-get\b/.test(code)) return;
        if (/\bapt_(retry|update|install)\b|\bapt\.sh\b|\$\{opts\[@\]\}/.test(code)) return;
        if (!/\b(update|install)\b/.test(code.replace(/'[^']*'|"[^"]*"/g, ""))) return;
        raw.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(raw, []);
});
