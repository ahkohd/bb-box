import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after } from "node:test";
import { ProxmoxLxcBackend } from "../../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../../src/backends/proxmox/api.ts";
import type { BoxIdentity, Guest } from "../../src/backends/types.ts";
import { FAKE_TOKEN, FakeProxmox, TOKEN_ROLE } from "../fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, testContext } from "../helpers.ts";
import { boxTags, describe } from "../../src/backends/proxmox/owner.ts";
import { CARD_A, CARD_B, FakeNode, INSTALL, POOL, REPORT_VMID, cardLines, type FakeCard } from "./node.ts";

export const SECOND_INSTALL = "9zz2";
export const SECOND_POOL = "other";

const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

function encode(text: string): string {
  return text.replace(/[^\x20-\x39\x3b-\x7e]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function configText(config: Readonly<Record<string, string>>): string {
  const { description, digest: _digest, ...keys } = config;
  const lines = description ? description.split("\n").map((line) => `#${encode(line)}`) : [];
  for (const key of Object.keys(keys).sort()) lines.push(`${key}: ${keys[key]}`);
  return lines.map((line) => `${line}\n`).join("");
}

export function devices(lines: readonly string[]): Record<string, string> {
  return Object.fromEntries(lines.map((line, index) => [`dev${index}`, line]));
}

export interface BackendOptions {
  readonly install?: string;
  readonly pool?: string;
  readonly perGpu?: number;
  readonly templates?: string;
  readonly first?: number;
  readonly warm?: number;
  readonly onSleep?: () => void;
  readonly kindsOff?: readonly string[];
}

let bridges = 0;

export class ClaimsBridge {
  readonly node: FakeNode;
  readonly proxmox = new FakeProxmox();
  readonly ssh = fakeSsh();
  readonly url = `https://pve-${++bridges}.example.com:8006/`;
  answering = true;
  passes = 0;

  constructor(options: { readonly writes?: "on" | "off"; readonly pveContainer?: string } = {}) {
    this.node = new FakeNode({ writes: options.writes ?? "on", pools: [POOL, SECOND_POOL], ...(options.pveContainer ? { pveContainer: options.pveContainer } : {}) });
    this.proxmox.pools.add(SECOND_POOL);
    this.proxmox.privileges.set(`/pool/${SECOND_POOL}`, new Set(TOKEN_ROLE));
    this.proxmox.addTemplate(9000, { unprivileged: "1" });
    this.proxmox.addTemplate(9001, { cores: "4", memory: "8192", unprivileged: "1", ...devices(cardLines(CARD_A, "desktop")) });
    this.proxmox.addTemplate(9002, { cores: "4", memory: "8192", unprivileged: "1", ...devices(cardLines(CARD_B, "desktop")) });
    this.proxmox.guests.set(REPORT_VMID, { vmid: REPORT_VMID, type: "qemu", name: "bb-box-gpu-memory", status: "stopped", template: false, config: { name: "bb-box-gpu-memory", description: "" } });
    this.pass();
  }

  #nodeVmids(): number[] {
    return readdirSync(this.node.file("etc/pve/nodes/pve/lxc")).flatMap((name) => (/^(\d+)\.conf$/.exec(name) ? [Number(name.slice(0, -5))] : []));
  }

  push(): void {
    const seen = new Set<number>();
    for (const [vmid, guest] of this.proxmox.guests) {
      if ((guest.type ?? "lxc") !== "lxc") continue;
      seen.add(vmid);
      this.node.guest(vmid, { pool: guest.pool ?? null, running: guest.status === "running" });
      this.node.write(`etc/pve/nodes/pve/lxc/${vmid}.conf`, configText(guest.config));
    }
    for (const vmid of this.#nodeVmids()) if (!seen.has(vmid)) this.node.remove(vmid);
  }

  pull(): void {
    for (const [vmid, guest] of this.proxmox.guests) {
      if ((guest.type ?? "lxc") !== "lxc" || !this.#nodeVmids().includes(vmid)) continue;
      for (const key of Object.keys(guest.config)) if (/^dev\d+$/.test(key)) delete guest.config[key];
      Object.assign(guest.config, Object.fromEntries(Object.entries(this.node.config(vmid).keys).filter(([key]) => /^dev\d+$/.test(key))));
    }
    this.proxmox.guests.get(REPORT_VMID)!.config.description = this.node.report();
  }

  pass(): void {
    this.push();
    const run = this.node.run(["--once"]);
    assert.equal(run.status, 0, run.stderr);
    this.passes++;
    this.pull();
  }

  tick(): void {
    if (this.answering) this.pass();
  }

  backend(options: BackendOptions = {}): ProxmoxLxcBackend {
    const first = options.first ?? (options.install === SECOND_INSTALL ? 7050 : 7000);
    const config = lxcConfig({
      "proxmox-lxc-url": this.url,
      "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
      "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
      "proxmox-lxc-desktop-templates": options.templates ?? `9001 GPU-${CARD_A.uuid}\n9002 GPU-${CARD_B.uuid}`,
      "proxmox-lxc-node": "pve",
      "proxmox-lxc-pool": options.pool ?? (options.install === SECOND_INSTALL ? SECOND_POOL : POOL),
      "proxmox-lxc-vmid-first": first,
      "proxmox-lxc-vmid-last": first + 49,
      ...(options.perGpu !== undefined ? { "proxmox-lxc-desktops-per-gpu": options.perGpu } : {}),
      ...(options.warm !== undefined ? { "proxmox-lxc-desktop-warm": options.warm } : {}),
    });
    const shipped = testContext(new MemoryStorage(), options.install ?? INSTALL, { id: "proxmox-lxc", warm: { "linux-desktop": options.warm ?? 0 } });
    const context = { ...shipped, kind: (id: string) => (options.kindsOff?.includes(id) ? { ...shipped.kind(id), enabled: false } : shipped.kind(id)) };
    const backend = new ProxmoxLxcBackend(config, context, {
      fetch: this.proxmox.fetch,
      sleep: async () => {
        options.onSleep?.();
        this.tick();
      },
      sshBinary: FAKE_SSH_BINARY,
      portCheck: async () => true,
      readyTimeoutMs: 0,
    });
    made.push(backend);
    return Object.assign(backend, { errors: context.errors });
  }

  timerReport(): void {
    const gpus = [CARD_A, CARD_B].map((card) => `    gpu GPU-${card.uuid} ${card.bus} ${card.index} ${card.freeMiB} ${card.totalMiB}`);
    this.proxmox.guests.get(REPORT_VMID)!.config.description = ["bb-box: each GPU's memory, from the host. Do not edit.", "", `    at ${Math.floor(Date.now() / 1000)}`, ...gpus].join("\n");
  }

  stoppedGuest(vmid: number, box: BoxIdentity, template: number): Guest {
    return { ref: String(vmid), host: "pve", address: null, size: null, data: { template, box: box.boxId } };
  }

  tags(vmid: number): string[] {
    return parseTags(this.proxmox.guests.get(vmid)!.config.tags);
  }

  gpuTags(vmid: number): string[] {
    return this.tags(vmid).filter((tag) => tag.startsWith("gpu."));
  }

  lines(vmid: number): string[] {
    return this.node.lines(vmid);
  }

  cardOf(vmid: number): FakeCard | null {
    const lines = this.lines(vmid);
    return [CARD_A, CARD_B].find((card) => lines.includes(`/dev/nvidia${card.minor},mode=0666`)) ?? null;
  }

  configs(): Map<number, string> {
    return new Map(this.#nodeVmids().map((vmid) => [vmid, this.node.text(vmid)]));
  }

  desktop(vmid: number, card: FakeCard, box: BoxIdentity, install: string, more: { readonly marker?: string; readonly running?: boolean; readonly pool?: string; readonly description?: string; readonly tags?: readonly string[] } = {}): void {
    const template = card === CARD_A ? 9001 : 9002;
    const base = this.proxmox.guests.get(template)!.config;
    const { template: _template, protection: _protection, ...config } = base;
    this.proxmox.guests.set(vmid, {
      vmid,
      name: box.name,
      pool: more.pool ?? (install === SECOND_INSTALL ? SECOND_POOL : POOL),
      status: more.running ? "running" : "stopped",
      template: false,
      config: {
        ...config,
        hostname: box.name,
        description: more.description ?? describe(box, install),
        tags: [...(more.tags ?? boxTags(box, install, template)), ...(more.marker ? [more.marker] : [])].join(";"),
        rootfs: `local-lvm:base-${template}-disk-0/vm-${vmid}-disk-0,size=8G`,
      },
    });
    this.proxmox.statusPass();
  }
}

export { CARD_A, CARD_B, INSTALL, POOL };
