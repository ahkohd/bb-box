import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxRecord } from "../src/core/boxes.ts";
import { offersText } from "../src/plugin/tools.ts";
import { formLine, type KindView, type OfferView } from "../src/plugin/views.ts";

const offer = (name: string, form: OfferView["form"], note?: string): OfferView =>
  ({ backend: name, name, type: "x", label: name, hosts: [], form, ready: 0, free: null, ...(note ? { note } : {}) }) as unknown as OfferView;
const kind = (...offers: OfferView[]): KindView => ({ offers }) as unknown as KindView;

test("box_list names each provider of a kind, with what its boxes are where that differs between them, or the provider says more", () => {
  assert.equal(offersText(kind(offer("Proxmox LXC on pve1", "LXC"), offer("Docker on devpc", "Docker"))), "Proxmox LXC on pve1 (LXC containers), Docker on devpc (Docker containers)");
  assert.equal(offersText(kind(offer("Proxmox LXC on pve1", "LXC"), offer("Proxmox LXC on pve2", "LXC"))), "Proxmox LXC on pve1, Proxmox LXC on pve2", "nothing where all are the same");
  const pool = "2 physical Macs, each lent whole (18 cores, 36 GiB; 10 cores, 16 GiB), with the Mac's own GPU; no root";
  assert.equal(offersText(kind(offer("Tart on mac1", "VM"), offer("SSH host pool", "Physical", pool))), `Tart on mac1 (VMs), SSH host pool (${pool})`);
});

test("a box's Form says what it is: as its backend said of its machine, else as its backend's form makes it, and nothing when unknown", () => {
  const box = (backend: string, os: string, facts: { label: string; value: string }[] = []) =>
    ({ backend, capabilities: { os }, guest: { ref: "x", facts } }) as unknown as BoxRecord;
  assert.equal(formLine(box("ssh-pool", "macos", [{ label: "Form", value: "a physical Mac, lent whole" }])), "a physical Mac, lent whole");
  assert.equal(formLine(box("ssh-pool", "macos")), "a physical Mac, lent whole", "a pool box from before the pool said");
  assert.equal(formLine(box("tart", "macos")), "a macOS VM");
  assert.equal(formLine(box("proxmox-lxc", "linux")), "an LXC container");
  assert.equal(formLine(box("docker:devpc", "linux")), "a Docker container");
  assert.equal(formLine(box("fake", "linux")), null);
});
