// Video on GPU desktops (#863): the image's Selkies encodes with NVENC on the
// GPU display path, without NvFBC, and its check sees NVENC at work.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUEST = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/", import.meta.url));
const read = (path: string) => readFileSync(join(GUEST, path), "utf8");

test("Selkies' launcher encodes with NVENC on the GPU display path, without NvFBC, and with x264 on the CPU elsewhere", () => {
  const launcher = read("files/selkies");
  assert.doesNotMatch(launcher, /sleep infinity/, "it no longer waits on the GPU path");
  assert.match(launcher, /^use_cpu=true\n\[ "\$\(cat \/run\/bb-box\/display-mode 2>\/dev\/null\)" != gpu \] \|\| use_cpu=false$/m);
  assert.match(launcher, /^\[ "\$use_cpu" = true \] \|\| export LD_PRELOAD=\/usr\/local\/lib\/bb-box-nofbc\.so$/m);
  assert.match(launcher, /--encoder=h264enc --use-cpu="\$use_cpu"/);
  const customize = read("customize-desktop.sh");
  assert.match(customize, /gcc -O2 -Wall -Werror -shared -fPIC -o \/usr\/local\/lib\/bb-box-nofbc\.so "\$build\/guest\/files\/bb-box-nofbc\.c" -ldl/);
  assert.match(customize, /install -m 0644 "\$build\/guest\/files\/selkies-probe\.mjs" \/usr\/local\/libexec\/bb-box\/selkies-probe\.mjs/);
});

test("the desktop check asks Selkies for video, and on the GPU path needs NVIDIA's encoder loaded", () => {
  const check = read("check-desktop.sh");
  assert.doesNotMatch(check, /waits on the GPU path/);
  assert.match(check, /t "Selkies video" sh -c 'out=\$\(node \/usr\/local\/libexec\/bb-box\/selkies-probe\.mjs 5980 3\)/);
  assert.match(check, /grep -q libnvidia-encode "\/proc\/\$pid\/maps"/);
});

test("bb-box-nofbc keeps libnvidia-fbc from loading, and only it", { skip: spawnSync("gcc", ["--version"]).status !== 0 && "needs gcc" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-box-nofbc-"));
  try {
    const so = join(dir, "nofbc.so");
    const built = spawnSync("gcc", ["-O2", "-Wall", "-Werror", "-shared", "-fPIC", "-o", so, join(GUEST, "files", "bb-box-nofbc.c"), "-ldl"], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const load = (name: string) =>
      spawnSync("python3", ["-c", `import ctypes, sys\ntry:\n  ctypes.CDLL(${JSON.stringify(name)}); print("loaded")\nexcept OSError as e:\n  print("refused")`], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: so } }).stdout.trim();
    assert.equal(load("libnvidia-fbc.so.1"), "refused");
    assert.equal(load("libm.so.6"), "loaded", "anything else loads as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
