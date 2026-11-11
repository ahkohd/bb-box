import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APT = join(ROOT, "setup/proxmox-lxc/template/guest/apt.sh");
const MIRROR_ERROR = "E: Failed to fetch http://snapshot.ubuntu.com/ubuntu/dists/noble/InRelease  503  Service Unavailable [IP: 185.125.190.40 80]";

function layout(fails: "once" | "always" | "never"): string {
  const dir = tempDir("apt-retry");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "state"), fails === "always" ? "always" : fails === "once" ? "1" : "0");
  writeFileSync(join(dir, "log"), "");
  writeFileSync(join(dir, "sleeps"), "");
  writeFileSync(
    join(bin, "apt-get"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$APT_FAKE_LOG"
state=$(cat "$APT_FAKE_STATE")
if [ "$state" = always ] || [ "$state" != 0 ]; then
  if [ "$state" != always ]; then echo $((state - 1)) > "$APT_FAKE_STATE"; fi
  echo "${MIRROR_ERROR}" >&2
  exit 100
fi
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "sleep"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$APT_FAKE_SLEEPS"
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
      APT_FAKE_STATE: join(dir, "state"),
      APT_FAKE_SLEEPS: join(dir, "sleeps"),
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
    const dir = layout("once");
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
    assert.match(ran.stderr, /apt-get -o Acquire::Retries=5( -o Acquire::Retries::Delay=true)? update -q --error-on=any failed \(try 1 of 5\); retrying in 0 s/);
  }
});

test("apt-get update fails only when every try fails, and shows that last error", () => {
  const dir = layout("always");
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
  const once = layout("once");
  const passed = run(once, 'bash "$APT_SCRIPT" update -q --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: "0" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(lines(once, "log").length, 2);

  const always = layout("always");
  const failed = run(always, 'bash "$APT_SCRIPT" update --error-on=any\n', { APT_RETRY_DELAY_SUPPORTED: "1" });
  assert.equal(failed.status, 100);
  assert.equal(failed.stderr.split("503").length - 1, 1);
  assert.match(lines(always, "log")[0]!, /Acquire::Retries::Delay=true/);
});

test("apt-get install downloads under the retry, so it rides out an outage, then installs from the cache", () => {
  const dir = layout("once");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q --no-install-recommends jq\n', { APT_RETRY_DELAY_SUPPORTED: "1" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(lines(dir, "log"), [
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install --download-only -y -q --no-install-recommends jq",
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install --download-only -y -q --no-install-recommends jq",
    "-o Acquire::Retries=5 -o Acquire::Retries::Delay=true install -y -q --no-install-recommends jq",
  ]);
  assert.deepEqual(lines(dir, "sleeps"), ["0"]);
  assert.match(ran.stderr, /install --download-only -y -q --no-install-recommends jq failed \(try 1 of 5\); retrying in 0 s/);
});

test("an outage longer than every try fails the install with the archive's error and what to do", () => {
  const dir = layout("always");

  const ran = run(dir, '. "$APT_SCRIPT"\napt_install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0", APT_RETRY_SLEEP_SCALE: "30" });

  assert.equal(ran.status, 100);
  assert.equal(lines(dir, "log").length, 5);
  assert.ok(lines(dir, "log").every((call) => call.includes("--download-only")), "nothing is installed from a download that failed");
  assert.deepEqual(lines(dir, "sleeps"), ["30", "60", "90", "120"]);
  assert.match(ran.stderr, /503 {2}Service Unavailable/);
  assert.match(ran.stderr, /apt: apt-get -o Acquire::Retries=5 install --download-only -y -q jq failed 5 times over 300 s\. The package archive did not serve it for that long: check the errors above, then build again\.$/m);
});

test("running apt.sh install is the same retry", () => {
  const dir = layout("once");

  const ran = run(dir, 'bash "$APT_SCRIPT" install -y -q jq\n', { APT_RETRY_DELAY_SUPPORTED: "0" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(lines(dir, "log").length, 3);
});

test("the wait and the try count default to the build's, and delay follows this apt", () => {
  const source = readFileSync(APT, "utf8");
  assert.match(source, /APT_RETRY_TRIES:-5/);
  assert.match(source, /APT_RETRY_SLEEP_SCALE:-30/);
  const dir = layout("never");
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
