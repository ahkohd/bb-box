import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { providerFamily } from "../src/backends/index.ts";

test("a box's provider is its backend's type: both Proxmox drivers are Proxmox, Docker on any machine is Docker, the pool is SSH pool", () => {
  assert.deepEqual(
    ["proxmox-lxc", "proxmox-qemu", "docker", "docker:devpc", "ssh-pool", "tart", "microsandbox:studio", "hetzner", "namespace", "gone-driver"].map((id) => providerFamily(id)),
    ["Proxmox", "Proxmox", "Docker", "Docker", "SSH pool", "Tart", "microsandbox", "Hetzner Cloud", "Namespace", "gone-driver"],
  );
});
