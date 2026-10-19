// The Wayland desktop on Ubuntu 26.04, whose Sway and wayvnc carry the box's
// own pointer shapes: the guest scripts build it on 24.04 or 26.04, by the
// image's release, and the X11 desktops and Linux stay on 24.04.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../setup/", import.meta.url));
const read = (path: string) => readFileSync(join(SETUP, path), "utf8");

test("the build's fallback apt source names the image's own release, as 26.04 is resolute, not noble", () => {
  const baseline = read("proxmox-lxc/template/guest/baseline.sh");
  assert.match(baseline, /suite=\$\(\. \/etc\/os-release && echo "\$VERSION_CODENAME"\)/);
  assert.match(baseline, /Suites: \$suite \$suite-updates \$suite-backports \$suite-security/);
  assert.doesNotMatch(baseline, /Suites: noble/);
  // dnsutils is only 24.04's transitional name for bind9-dnsutils, which 26.04 dropped.
  const base = read("proxmox-lxc/template/guest/customize-base.sh");
  assert.match(base, /\bbind9-dnsutils\b/);
  assert.doesNotMatch(/^extra_packages=.*$/m.exec(base)![0], / dnsutils /);
});

test("Selkies is pinned for 26.04 beside 24.04, on both architectures, and the Wayland desktop takes its release's", () => {
  const rows = read("proxmox-lxc/template/desktop-pins.tsv")
    .split("\n")
    .filter((line) => line.startsWith("selkies"))
    .map((line) => line.split("\t"));
  for (const [arch, deb] of [["x86_64", "amd64"], ["arm64", "arm64"]] as const) {
    const ours = rows.filter((row) => row[4] === arch);
    assert.deepEqual(ours.map((row) => [row[0], row[1]]), [["selkies", `selkies-2.0.0-ubuntu24.04-${deb}.deb`], ["selkies-ubuntu26.04", `selkies-2.0.0-ubuntu26.04-${deb}.deb`]]);
    for (const row of ours) {
      assert.equal(row[2], `https://github.com/selkies-project/selkies/releases/download/2.0.0/${row[1]}`);
      assert.match(row[3]!, /^[0-9a-f]{64}$/);
    }
  }
  const wayland = read("proxmox-lxc/template/guest/customize-desktop-wayland.sh");
  assert.match(wayland, /release=\$\(\. \/etc\/os-release && echo "\$VERSION_ID"\)/);
  assert.match(wayland, /case \$release in 24\.04 \| 26\.04\) ;; \*\) die /);
  assert.match(wayland, /\[ "\$release" != 26\.04 \] \|\| selkies_pin=selkies-ubuntu26\.04/);
  assert.match(wayland, /selkies=\$\(check "\$selkies_pin"\)/);
  // The cursor helper's protocol XML, on 26.04 only.
  assert.match(wayland, /\[ "\$release" != 26\.04 \] \|\| desktop_packages="\$desktop_packages wayland-protocols"/);
});

test("a Proxmox LXC Wayland template is built from Ubuntu 26.04, and the rest from 24.04", () => {
  const common = read("proxmox-lxc/host/common.sh");
  assert.match(common, /^BBBOX_OS_TEMPLATE=\$\{BBBOX_OS_TEMPLATE:-local:vztmpl\/ubuntu-24\.04-standard_/m);
  assert.match(common, /^BBBOX_OS_TEMPLATE_WAYLAND=\$\{BBBOX_OS_TEMPLATE_WAYLAND:-local:vztmpl\/ubuntu-26\.04-standard_26\.04-1_amd64\.tar\.zst\}$/m);
  assert.match(read("proxmox-lxc/host/bb-box.env.example"), /^BBBOX_OS_TEMPLATE_WAYLAND=local:vztmpl\/ubuntu-26\.04-standard_26\.04-1_amd64\.tar\.zst$/m);
  const build = read("proxmox-lxc/template/build.sh");
  assert.match(build, /os_template=\$BBBOX_OS_TEMPLATE\n\[ -z "\$wayland" \] \|\| os_template=\$BBBOX_OS_TEMPLATE_WAYLAND\n/);
  assert.match(build, /pct create "\$ct" "\$os_template" /);
  assert.doesNotMatch(build, /pct create "\$ct" "\$BBBOX_OS_TEMPLATE"/);
});

test("Docker's Wayland stage has a base of its own, Ubuntu 26.04, and the rest stay on 24.04", () => {
  const dockerfile = read("docker/Dockerfile");
  assert.match(dockerfile, /^ARG UBUNTU=ubuntu:24\.04@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^ARG UBUNTU_WAYLAND=ubuntu:26\.04@sha256:[0-9a-f]{64}$/m);
  assert.match(dockerfile, /^FROM \$\{UBUNTU_WAYLAND\} AS desktop-wayland$/m);
  for (const stage of ["fetch", "linux", "desktop"]) assert.match(dockerfile, new RegExp(`^FROM \\$\\{UBUNTU\\} AS ${stage}$`, "m"), `${stage} stays on UBUNTU`);
});

test("each command a guest script runs as the box user, or npm as root, has a PATH of its own: pct exec gives a 26.04 CT one without /usr/local/bin", async () => {
  const { readdirSync } = await import("node:fs");
  const guest = join(SETUP, "proxmox-lxc", "template", "guest");
  const bare: string[] = [];
  for (const name of readdirSync(guest).filter((file) => file.endsWith(".sh"))) {
    for (const [index, line] of readFileSync(join(guest, name), "utf8").split("\n").entries()) {
      if (/^\s*#/.test(line) || !/\brunuser -u /.test(line)) continue;
      // What /usr/bin has on any PATH needs none.
      if (/runuser -u "\$user" -- (mkdir|install|chmod|test) /.test(line)) continue;
      if (!/\bPATH=/.test(line)) bare.push(`${name}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(bare, []);
  const base = read("proxmox-lxc/template/guest/customize-base.sh");
  assert.match(base, /env HOME="\$box_home" PATH="\$box_path" npm config get prefix/);
  assert.match(base, /env HOME=\/root PATH=\/usr\/local\/bin:\/usr\/bin:\/bin npm config get prefix/);
});
