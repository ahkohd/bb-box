import { ProxmoxError, parseTags, rootDiskGiB, type GuestSettings, type Proxmox } from "../proxmox/api.ts";
import { copyTags, isEarlierGuest, isHeldCopy } from "../proxmox/copies.ts";
import { TAG, installFromDescription, installFromTags, installTag, namesOf, ownerFromDescription, ownerFromTags } from "../proxmox/owner.ts";
import { PRODUCT } from "../../brand.ts";


type Config = Record<string, unknown>;

export interface GuestOwner {
  readonly words: string;
  owns(config: Config): boolean;
}

export class NoLongerOurs extends Error {}

const WRITE_TRIES = 3;

function withoutProxmoxTrailingNewlines(description: unknown): unknown {
  return typeof description === "string" ? description.replace(/\n+$/, "") : description;
}

export function sameDescription(read: unknown, written: unknown): boolean {
  return withoutProxmoxTrailingNewlines(read) === withoutProxmoxTrailingNewlines(written);
}

function describedFor(config: Config, install: string, box: string | null): boolean {
  return box !== null && installFromDescription(config.description) === install && ownerFromDescription(config.description)?.boxId === box;
}

function isTemplate(config: Config): boolean {
  return config.template === 1 || config.template === "1";
}

export function carriesAnother(config: Config, install: string): boolean {
  const tags = parseTags(config.tags);
  const tagged = installFromTags(tags);
  if (tagged === null || tagged === install) return false;
  return ownerFromTags(tags) !== null || installFromDescription(config.description) !== install;
}

function guarded(owner: GuestOwner, install: string): GuestOwner {
  return { words: owner.words, owns: (config) => !carriesAnother(config, install) && owner.owns(config) };
}

export function boxOwner(install: string, box: string | null): GuestOwner {
  return guarded({
    words: box ? `box ${box} of this install` : "this install's guest",
    owns: (config) => {
      if (box === null) return !isTemplate(config) && namesOf(config).install === install && namesOf(config).box === null;
      const tags = parseTags(config.tags);
      if (isTemplate(config) || isHeldCopy(tags) || isEarlierGuest(tags)) return false;
      const tagged = ownerFromTags(tags);
      if (tagged) return tagged.boxId === box && installFromTags(tags) === install;
      if (copyTags(tags).box !== null) return false;
      return describedFor(config, install, box);
    },
  }, install);
}

export function madeOwner(install: string, box: string | null): GuestOwner {
  return guarded({ words: `the guest ${PRODUCT} is making for box ${box} of this install`, owns: (config) => !isTemplate(config) && describedFor(config, install, box) }, install);
}

export function copyOwner(install: string, box: string | null): GuestOwner {
  return {
    words: `a held copy or an earlier guest of box ${box ?? "-"} of this install`,
    owns: (config) => {
      const tags = parseTags(config.tags);
      return tags.includes(installTag(install)) && (copyTags(tags).box ?? namesOf(config).box) === box;
    },
  };
}

export function warmOwner(install: string, made: string): GuestOwner {
  return guarded({
    words: `the warm guest of this install that ${PRODUCT} made`,
    owns: (config) => !isTemplate(config) && sameDescription(config.description, made) && made.startsWith("bb-box warm ") && installFromDescription(made) === install && copyTags(parseTags(config.tags)).box === null,
  }, install);
}

export function imageOwner(install: string, imageBox: string, imageTag: string): GuestOwner {
  return guarded({
    words: "an image box or build of this install",
    owns: (config) => {
      const tags = parseTags(config.tags);
      const description = typeof config.description === "string" ? config.description : "";
      if (copyTags(tags).box !== null) return false;
      if (tags.includes(installTag(install)) && (tags.includes(imageBox) || tags.some((tag) => tag.startsWith(imageTag)))) return true;
      return description.startsWith("bb-box image box: ") && installFromDescription(description) === install;
    },
  }, install);
}

export function templateOwner(install: string, vmid: number, as: Config): GuestOwner {
  return guarded({ words: `template ${vmid}, as this install's settings name it`, owns: (config) => isTemplate(config) && sameDescription(config.description, as.description) && config.hostname === as.hostname }, install);
}

export function eitherOwner(first: GuestOwner, second: GuestOwner): GuestOwner {
  return { words: `${first.words} or ${second.words}`, owns: (config) => first.owns(config) || second.owns(config) };
}

export function describedOwner(install: string, description: string): GuestOwner {
  return guarded({ words: `the guest ${PRODUCT} has just made`, owns: (config) => sameDescription(config.description, description) }, install);
}

export function unstampedOwner(box: string): GuestOwner {
  return {
    words: `box ${box}'s guest from before install IDs`,
    owns: (config) => {
      const names = namesOf(config);
      return parseTags(config.tags).includes(TAG) && names.install === null && names.box === box;
    },
  };
}

export function sameGuestOwner(install: string, as: Config): GuestOwner {
  const box = namesOf(as).box;
  return { words: `${box ? `box ${box}` : "the guest"} of this install, as ${PRODUCT} read it`, owns: (config) => namesOf(config).install === install && namesOf(config).box === box };
}

function namedWords(config: Config): string {
  const names = namesOf(config);
  if (!parseTags(config.tags).includes(TAG) && !names.install) return `no ${PRODUCT} guest`;
  return names.box ? `box ${names.box} of ${names.install ? `install ${names.install}` : "no install"}` : names.install ? `no box, of install ${names.install}` : "no box of any install";
}

function noLongerWords(vmid: number, owner: GuestOwner, config: Config | null): string {
  if (!config) return `CT ${vmid} has gone, so it is no longer ${owner.words}. ${PRODUCT} changes nothing on it.`;
  return `CT ${vmid} is no longer ${owner.words}: its config names ${namedWords(config)}. ${PRODUCT} changes nothing on it and does not start it.`;
}

export type Sighting = (vmid: number, words: string) => void;

export type PowerAction = "start" | "stop" | "shutdown" | "delete";

export interface NodePower {
  helperFor(vmid: number, config: Config, action: PowerAction, signal?: AbortSignal): Promise<string | null>;
  ask(vmid: number, action: PowerAction, owner: GuestOwner, helper: string, signal?: AbortSignal): Promise<void>;
  acted(vmid: number, action: PowerAction): Promise<void>;
}

export interface ConfigWriteCheck {
  beforeWrite(vmid: number, config: Config, settings: GuestSettings, signal?: AbortSignal): Promise<void>;
}

export class OwnedGuests {
  readonly #api: Proxmox;
  readonly #seen: Sighting;
  readonly #power: NodePower | null;
  readonly #check: ConfigWriteCheck | null;

  constructor(api: Proxmox, seen: Sighting = () => {}, power: NodePower | null = null, check: ConfigWriteCheck | null = null) {
    this.#api = api;
    this.#seen = seen;
    this.#power = power;
    this.#check = check;
  }

  async #helperFor(vmid: number, config: Config, action: PowerAction, signal?: AbortSignal): Promise<string | null> {
    return this.#power === null ? null : await this.#power.helperFor(vmid, config, action, signal);
  }

  async #configOrNull(vmid: number, signal?: AbortSignal): Promise<Config | null> {
    try {
      return await this.#api.config(vmid, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return null;
      throw error;
    }
  }

  async readIfThere(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<Config | null> {
    const config = await this.#configOrNull(vmid, signal);
    if (config && !owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    return config;
  }

  async read(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<Config> {
    const config = await this.#configOrNull(vmid, signal);
    if (!config || !owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    return config;
  }

  async #after(vmid: number, owner: GuestOwner, what: string, signal?: AbortSignal): Promise<Config | null> {
    const config = await this.#configOrNull(vmid, signal);
    if (config && !owner.owns(config)) {
      const words = `CT ${vmid} held a guest that is not ${owner.words} right after ${PRODUCT}'s ${what}: its config names ${namedWords(config)}. ${PRODUCT} acts on it no more.`;
      this.#seen(vmid, words);
      throw new NoLongerOurs(words);
    }
    return config;
  }

  async #act(vmid: number, owner: GuestOwner, what: string, run: () => Promise<void>, signal?: AbortSignal, onTheNode?: PowerAction): Promise<void> {
    const config = await this.read(vmid, owner, signal);
    const helper = onTheNode ? await this.#helperFor(vmid, config, onTheNode, signal) : null;
    if (onTheNode && helper !== null) {
      await this.#power!.ask(vmid, onTheNode, owner, helper, signal);
      await this.#power!.acted(vmid, onTheNode);
      return;
    }
    await run();
    if (!(await this.#after(vmid, owner, what, signal))) throw new NoLongerOurs(`CT ${vmid} went right after ${PRODUCT}'s ${what}. ${PRODUCT} acts on it no more.`);
    if (onTheNode) await this.#power?.acted(vmid, onTheNode);
  }

  async writeOn(vmid: number, owner: GuestOwner, config: Config, settings: GuestSettings, signal?: AbortSignal): Promise<void> {
    if (!owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    if (typeof config.digest !== "string" || !config.digest) throw new Error(`Proxmox gave no digest with CT ${vmid}'s config, so ${PRODUCT} does not write it.`);
    await this.#check?.beforeWrite(vmid, config, settings, signal);
    await this.#api.configure(vmid, { ...settings, digest: config.digest }, signal);
  }

  async configure(vmid: number, owner: GuestOwner, change: GuestSettings | ((config: Config) => GuestSettings | null), signal?: AbortSignal): Promise<void> {
    for (let tries = 1; ; tries++) {
      const config = await this.read(vmid, owner, signal);
      const settings = typeof change === "function" ? change(config) : change;
      if (!settings) return;
      try {
        await this.writeOn(vmid, owner, config, settings, signal);
        return;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.changedMeanwhile) || tries >= WRITE_TRIES) throw error;
      }
    }
  }

  async setNetwork(vmid: number, owner: GuestOwner, change: Readonly<Record<string, string>> | ((config: Config) => Readonly<Record<string, string>>), signal?: AbortSignal): Promise<void> {
    for (let tries = 1; ; tries++) {
      const config = await this.read(vmid, owner, signal);
      const settings = typeof change === "function" ? change(config) : change;
      if (!Object.keys(settings).length) return;
      if (typeof config.digest !== "string" || !config.digest) throw new Error(`Proxmox gave no digest with CT ${vmid}'s config, so ${PRODUCT} does not write its network.`);
      try {
        await this.#api.setNetwork(vmid, { ...settings, digest: config.digest }, signal);
        return;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.changedMeanwhile) || tries >= WRITE_TRIES) throw error;
      }
    }
  }

  async start(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.#act(vmid, owner, "start", () => this.#api.start(vmid, signal), signal, "start");
  }

  async stop(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.#act(vmid, owner, "stop", () => this.#api.stop(vmid, signal), signal, "stop");
  }

  async shutdown(vmid: number, owner: GuestOwner, timeoutS: number, signal?: AbortSignal): Promise<void> {
    await this.#act(vmid, owner, "shutdown", () => this.#api.shutdown(vmid, timeoutS, signal), signal, "shutdown");
  }

  async makeTemplate(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.#act(vmid, owner, "template", () => this.#api.makeTemplate(vmid, signal), signal);
  }

  async growRootDisk(vmid: number, owner: GuestOwner, sizeGiB: number, signal?: AbortSignal): Promise<boolean> {
    for (let tries = 1; ; tries++) {
      const config = await this.read(vmid, owner, signal);
      const current = rootDiskGiB(config);
      if (current !== null && current >= sizeGiB) return false;
      if (typeof config.digest !== "string" || !config.digest) throw new Error(`Proxmox gave no digest with CT ${vmid}'s config, so ${PRODUCT} does not grow its disk.`);
      try {
        await this.#api.resizeRootDisk(vmid, sizeGiB, config.digest, signal);
        return true;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.changedMeanwhile) || tries >= WRITE_TRIES) throw error;
      }
    }
  }

  async destroy(vmid: number, owner: GuestOwner, signal?: AbortSignal, beforeRemove?: (signal?: AbortSignal) => Promise<void>): Promise<void> {
    const config = await this.#configOrNull(vmid, signal);
    if (!config) {
      await this.#power?.acted(vmid, "delete");
      return;
    }
    if (!owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    const helper = await this.#helperFor(vmid, config, "delete", signal);
    if (helper !== null) {
      if ((await this.#api.status(vmid, signal))?.status === "running") await this.#power!.ask(vmid, "stop", owner, helper, signal);
      const now = await this.read(vmid, owner, signal);
      if (now.protection === 1 || now.protection === "1") await this.writeOn(vmid, owner, now, { delete: ["protection"] }, signal);
      await this.#power!.ask(vmid, "delete", owner, helper, signal);
      await this.#power!.acted(vmid, "delete");
      return;
    }
    await beforeRemove?.(signal);
    if ((await this.#api.status(vmid, signal))?.status === "running") await this.stop(vmid, owner, signal);
    for (let tries = 1; ; tries++) {
      await this.read(vmid, owner, signal);
      try {
        await this.#api.remove(vmid, signal);
        break;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.protected) || tries >= WRITE_TRIES) throw error;
        const protectedNow = await this.#after(vmid, owner, "delete", signal);
        if (!protectedNow) {
          await this.#power?.acted(vmid, "delete");
          return;
        }
        await this.writeOn(vmid, owner, protectedNow, { delete: ["protection"] }, signal);
      }
    }
    await this.#after(vmid, owner, "delete", signal);
    await this.#power?.acted(vmid, "delete");
  }
}

export const GUEST_WRITES: readonly string[] = ["configure", "setNetwork", "start", "stop", "shutdown", "growRootDisk", "resizeRootDisk", "makeTemplate", "destroy", "remove", "hibernate"];

export const COMPOUND_WRITES: readonly string[] = ["destroy", "growRootDisk"];
