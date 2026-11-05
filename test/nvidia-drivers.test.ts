import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-nvidia-drivers.sh", import.meta.url));
const INSTALLER = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/nvidia-userspace.sh", import.meta.url));

const CARD_FILES = [
  "usr/share/glvnd/egl_vendor.d/10_nvidia.json",
  "etc/vulkan/icd.d/nvidia_icd.json",
  "etc/vulkan/implicit_layer.d/nvidia_layers.json",
  "usr/share/egl/egl_external_platform.d/10_nvidia_wayland.json",
  "usr/share/egl/egl_external_platform.d/20_nvidia_xcb.json",
  "usr/share/egl/egl_external_platform.d/20_nvidia_xlib.json",
];
const GBM = "usr/share/egl/egl_external_platform.d/15_nvidia_gbm.json";
const MESA = "usr/share/glvnd/egl_vendor.d/50_mesa.json";

function box(): string {
  const root = tempDir("nvidia-drivers");
  for (const file of [...CARD_FILES, GBM, MESA]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), `{"file": "${file}"}\n`);
  }
  mkdirSync(join(root, "dev/dri"), { recursive: true });
  return root;
}

function run(root: string, ...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], { env: { ...process.env, BB_BOX_ROOT: root }, encoding: "utf8" });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

function shown(root: string, file: string): "shown" | "hidden" | "absent" {
  if (existsSync(join(root, file))) return "shown";
  return existsSync(join(root, `${file}.bb-box-no-card`)) ? "hidden" : "absent";
}

test("071 unit 7: in a box with no card's device nodes, NVIDIA's EGL, GBM and Vulkan files are hidden from their loaders, Mesa's stay, and a second boot changes nothing", () => {
  const root = box();
  const first = run(root);
  assert.equal(first.status, 0, first.err);
  assert.match(first.out, /^bb-box-nvidia-drivers: no card's device nodes; \/usr\/share\/glvnd\/egl_vendor\.d\/10_nvidia\.json hidden; /);
  for (const file of [...CARD_FILES, GBM]) assert.equal(shown(root, file), "hidden", file);
  assert.equal(shown(root, MESA), "shown");
  assert.equal(readFileSync(join(root, `${CARD_FILES[0]}.bb-box-no-card`), "utf8"), `{"file": "${CARD_FILES[0]}"}\n`, "kept as it was, under another name");
  const again = run(root);
  assert.equal(again.out, "bb-box-nvidia-drivers: no card's device nodes; nothing to change");
});

test("071 unit 7: once a box has a card's nodes they are shown again; NVIDIA's GBM platform only with a DRM render node, as a desktop has and a server has not", () => {
  const root = box();
  run(root);
  writeFileSync(join(root, "dev/nvidiactl"), "");
  writeFileSync(join(root, "dev/nvidia1"), "");
  const server = run(root);
  assert.equal(server.status, 0, server.err);
  assert.match(server.out, /^bb-box-nvidia-drivers: a card's device nodes and no DRM render node; /);
  for (const file of CARD_FILES) assert.equal(shown(root, file), "shown", file);
  assert.equal(shown(root, GBM), "hidden", "a server's card has no DRM nodes, so GBM stays hidden");
  writeFileSync(join(root, "dev/dri/renderD129"), "");
  run(root);
  assert.equal(shown(root, GBM), "shown", "a desktop's card has a render node");
  rmCard(root);
  run(root);
  for (const file of [...CARD_FILES, GBM]) assert.equal(shown(root, file), "hidden", `the card taken away again: ${file}`);
});

test("071 unit 7: a file the installer put back while hidden is the one kept; --check reports each file and changes nothing; nvidiactl alone is no card", () => {
  const root = box();
  run(root);
  writeFileSync(join(root, CARD_FILES[1]!), '{"newer": true}\n');
  writeFileSync(join(root, "dev/nvidiactl"), "");
  run(root);
  assert.equal(shown(root, CARD_FILES[1]!), "hidden", "nvidiactl with no /dev/nvidiaN is no card");
  assert.equal(readFileSync(join(root, `${CARD_FILES[1]}.bb-box-no-card`), "utf8"), '{"newer": true}\n');
  writeFileSync(join(root, "dev/nvidia0"), "");
  const before = run(root, "--check");
  assert.match(before.out, /^\/usr\/share\/glvnd\/egl_vendor\.d\/10_nvidia\.json hidden$/m);
  assert.equal(shown(root, CARD_FILES[0]!), "hidden", "--check changes nothing");
  assert.equal(run(root, "--bad").status, 2);
});

test("071 unit 7: the installer gives the X driver one place on a server and a desktop alike, installs the drivers' unit, and prints only its version", () => {
  const text = readFileSync(INSTALLER, "utf8");
  assert.match(text, /--x-library-path=\/usr\/lib\/x86_64-linux-gnu --x-module-path="\$x_modules"/);
  assert.match(text, /^x_modules=\/usr\/lib\/xorg\/modules$/m);
  assert.match(text, /systemctl enable bb-box-nvidia-drivers\.service/);
  assert.match(text, /^echo "\$version"$/m);
  const syntax = spawnSync("bash", ["-n", INSTALLER]);
  assert.equal(syntax.status, 0, syntax.stderr.toString());
});

function rmCard(root: string): void {
  for (const node of ["dev/nvidiactl", "dev/nvidia0", "dev/nvidia1", "dev/dri/renderD129"]) spawnSync("rm", ["-f", join(root, node)]);
}
