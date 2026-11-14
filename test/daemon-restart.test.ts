import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { restartDaemon } from "../src/plugin/setup.ts";
import { tempDir } from "./helpers.ts";

test("after a live change of cores, BB's daemon restarts once the box shows them, and the resize does not wait for it (061, #916)", async () => {
  const dir = tempDir("daemon-restart");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "restarts");
  const reads = join(dir, "reads");
  writeFileSync(
    join(bin, "systemctl"),
    `#!/bin/sh\ncase "$*" in *list-units*) echo "bb-host-daemon-x.service loaded active running";; *restart*) echo "$*" >> '${log}';; esac\n`,
  );
  // The box shows its new cores at the third look, about 2 s on.
  writeFileSync(join(bin, "nproc"), `#!/bin/sh\nn=$(cat '${reads}' 2>/dev/null || echo 0); echo $((n + 1)) > '${reads}'; [ "$n" -ge 2 ] && echo 6 || echo 4\n`);
  for (const name of ["systemctl", "nproc"]) chmodSync(join(bin, name), 0o755);
  const began = Date.now();
  execFileSync("sh", ["-c", restartDaemon(6)], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/box" } });
  assert.ok(Date.now() - began < 1_000, `the command took ${Date.now() - began} ms`);
  assert.equal(existsSync(log), false, "not restarted before the cores show");
  for (let tries = 0; tries < 60 && !existsSync(log); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(log, "utf8"), "--user restart --no-block bb-host-daemon-x.service\n");
  assert.ok(Number(readFileSync(reads, "utf8")) >= 3);
});

test("BB's daemon is not restarted on a machine that is not a box's own, nor where there is none", () => {
  const dir = tempDir("daemon-restart-none");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  const status = (home: string) => {
    try {
      execFileSync("sh", ["-c", restartDaemon(6)], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, stdio: "ignore" });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  assert.equal(status("/home/someone"), 3);
  assert.equal(status("/home/box"), 3, "no daemon unit");
});
