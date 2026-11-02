import assert from "node:assert/strict";
import { after } from "node:test";
import { ProxmoxLxcBackend } from "../../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../../src/backends/proxmox/api.ts";
import type { GpuPart } from "../../src/backends/types.ts";
import { FAKE_TOKEN, FakeProxmox, type FakeGuest } from "../fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, lxcConfig, testContext } from "../helpers.ts";
import { CARD_A, CARD_B, FakeNode, INSTALL, REPORT_VMID, boxLabels, cardLines, heldCopyLabels, type GuestSpec } from "./node.ts";

const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

export class Bridge {
  readonly node = new FakeNode({ writes: "off" });
  readonly proxmox = new FakeProxmox();
  helperRuns = 0;
  answering = true;

  constructor() {
    this.proxmox.addTemplate(9000);
    this.proxmox.addTemplate(9001, { cores: "4", memory: "8192" });
    this.proxmox.guests.set(REPORT_VMID, { vmid: REPORT_VMID, type: "qemu", name: "bb-box-gpu-memory", status: "stopped", template: false, config: { name: "bb-box-gpu-memory", description: "" } });
  }

  guest(vmid: number, spec: GuestSpec, pending?: FakeGuest["pending"]): void {
    this.node.guest(vmid, spec);
    const parsed = this.node.config(vmid);
    this.proxmox.guests.set(vmid, {
      vmid,
      name: parsed.keys.hostname ?? `CT${vmid}`,
      ...(spec.pool === null ? {} : { pool: spec.pool ?? "bbbox" }),
      status: spec.running ? "running" : "stopped",
      template: spec.template === true,
      config: { ...parsed.keys, ...(parsed.description ? { description: parsed.description.replace(/\n$/, "") } : {}) },
      ...(pending ? { pending } : {}),
    });
  }

  tags(vmid: number): string[] {
    return parseTags(this.proxmox.guests.get(vmid)!.config.tags);
  }

  syncTags(): void {
    for (const [vmid, guest] of this.proxmox.guests) {
      if ((guest.type ?? "lxc") !== "lxc" || guest.template || !this.node.text(vmid)) continue;
      const text = this.node.text(vmid);
      const line = `tags: ${guest.config.tags ?? ""}`;
      if (/^tags: .*$/m.test(text) && text.replace(/^tags: .*$/m, line) !== text) this.node.write(`etc/pve/nodes/pve/lxc/${vmid}.conf`, text.replace(/^tags: .*$/m, line));
    }
  }

  helper(): void {
    this.syncTags();
    const run = this.node.run(["--once", "--dry-run"]);
    assert.equal(run.status, 0, run.stderr);
    this.helperRuns++;
    this.proxmox.guests.get(REPORT_VMID)!.config.description = this.node.report();
  }

  backend(): ProxmoxLxcBackend {
    const config = lxcConfig({
      "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
      "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
      "proxmox-lxc-desktop-templates": `9001 GPU-${CARD_A.uuid}`,
      "proxmox-lxc-node": "pve",
      "proxmox-lxc-vmid-first": 7000,
      "proxmox-lxc-vmid-last": 7099,
    });
    const backend = new ProxmoxLxcBackend(config, testContext(new MemoryStorage(), INSTALL, { id: "proxmox-lxc" }), {
      fetch: this.proxmox.fetch,
      sleep: async () => {
        if (this.answering) this.helper();
      },
      sshBinary: FAKE_SSH_BINARY,
      portCheck: async () => true,
      readyTimeoutMs: 0,
    });
    made.push(backend);
    return backend;
  }

  configs(): Map<number, Record<string, string>> {
    return new Map([...this.proxmox.guests].filter(([, guest]) => (guest.type ?? "lxc") === "lxc").map(([vmid, guest]) => [vmid, { ...guest.config }]));
  }

  tagWrites(): Record<string, string>[] {
    return this.proxmox.calls.filter((call) => call.method !== "GET").map((call) => ({ method: call.method, path: call.path, ...call.params }));
  }
}

export function desktop(box: string, name: string, card = CARD_A, more: Partial<GuestSpec> = {}): GuestSpec {
  return { box, name, kind: "linux-desktop", lines: cardLines(card, "desktop"), ...more };
}

export const request = (options: { check?: boolean; undo?: boolean; parts?: readonly (readonly [string, GpuPart])[] } = {}) => ({
  check: options.check === true,
  undo: options.undo === true,
  recordedParts: new Map(options.parts ?? []),
});

export function today(bridge: Bridge): void {
  bridge.guest(7001, desktop("bx7001", "amber-fox", CARD_A, { running: true }));
  bridge.guest(7002, desktop("bx7002", "lone-pine", CARD_B));
  bridge.guest(7003, { box: "bx7003", name: "calm-reef", kind: "linux", lines: cardLines(CARD_A, "server"), running: true });
  bridge.guest(7004, { description: `bb-box warm desktop\ninstall ${INSTALL}`, tags: ["bb-box", `install.${INSTALL}`, "warm", "template.9001", "bb-box-starting"], hostname: "bb-box-warm", lines: cardLines(CARD_B, "desktop"), running: true });
  bridge.guest(7005, { box: "bx7005", name: "tidy-glade", kind: "linux", running: true });
  bridge.guest(7006, { box: "bx7006", name: "cpu-desk", kind: "linux-desktop-cpu" });
  bridge.guest(9001, { tags: ["bb-box", `install.${INSTALL}`], template: true, lines: cardLines(CARD_A, "desktop") });
  bridge.guest(7010, { ...boxLabels("bx7010", "other-box", "linux-desktop", "zz99"), lines: cardLines(CARD_A, "desktop"), running: true });
  bridge.guest(7011, { ...desktop("bx7011", "elsewhere"), pool: null });
  bridge.guest(7012, { ...heldCopyLabels("bx7001"), lines: cardLines(CARD_A, "desktop") });
  bridge.guest(7013, { description: `bb-box image box: build\ninstall ${INSTALL}`, tags: ["bb-box", `install.${INSTALL}`, "image-box", "template.9001"], lines: cardLines(CARD_A, "desktop"), running: true });
  bridge.guest(7014, { description: `bb-box warm desktop\ninstall ${INSTALL}`, tags: ["bb-box", `install.${INSTALL}`, "filling", "template.9001"], lines: cardLines(CARD_B, "desktop"), running: true });
  bridge.guest(7015, { description: `bb-box warm desktop\ninstall ${INSTALL}`, tags: ["bb-box", `install.${INSTALL}`, "retired", "template.9001"], lines: cardLines(CARD_B, "desktop") });
}
