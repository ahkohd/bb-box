import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BUILD = fileURLToPath(new URL("../setup/proxmox-lxc/template/build.sh", import.meta.url));

function devicesFor(lines: string): string[] {
  const definition = readFileSync(BUILD, "utf8")
    .split("\n")
    .find((line) => line.startsWith("devices_of()"));
  assert.ok(definition, "build.sh defines devices_of");
  const script = `${definition}\nmapfile -t devices < <(devices_of "$1")\nprintf '%s\\n' "\${#devices[@]}"\n[ "\${#devices[@]}" -eq 0 ] || printf '%s\\n' "\${devices[@]}"`;
  const run = spawnSync("bash", ["-c", script, "build", lines], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [count, ...devices] = run.stdout.trimEnd().split("\n");
  assert.equal(Number(count), devices.length);
  return devices;
}

test("071 unit 7: build.sh gives a template no empty device line where it has no GPU's, as for linux --cpu or a host without NVIDIA", () => {
  assert.deepEqual(devicesFor(""), [], "linux --cpu, and Linux on a host without NVIDIA, have no lines");
  assert.deepEqual(devicesFor("# NVIDIA 580.142, no card"), []);
  assert.deepEqual(devicesFor("# cpu only"), []);
  const card = ["/dev/nvidia1,mode=0666", "/dev/nvidiactl,mode=0666", "/dev/dri/renderD129,mode=0666", "# gpu 0000:21:00.0"].join("\n");
  assert.deepEqual(devicesFor(card), ["/dev/nvidia1,mode=0666", "/dev/nvidiactl,mode=0666", "/dev/dri/renderD129,mode=0666"]);
});

test("071 unit 7: the new guest scripts carry no comments beyond the shebang", () => {
  for (const name of ["bb-box-nvidia-drivers.sh", "nvidia-userspace.sh"]) {
    const text = readFileSync(fileURLToPath(new URL(`../setup/proxmox-lxc/template/guest/${name}`, import.meta.url)), "utf8");
    const comments = text.split("\n").slice(1).filter((line) => /^\s*#/.test(line));
    assert.deepEqual(comments, [], name);
  }
});
