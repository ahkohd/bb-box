import { ProxmoxError, parseTags, type GuestSettings, type Proxmox } from "../proxmox/api.ts";
import { copyTags, isEarlierGuest, isHeldCopy } from "../proxmox/copies.ts";
import { installFromDescription, installFromTags, installTag, namesOf, ownerFromDescription, ownerFromTags } from "../proxmox/owner.ts";

type Config = Record<string, unknown>;

export interface GuestOwner {
  readonly words: string;
  owns(config: Config): boolean;
}

export class NoLongerOurs extends Error {}

const WRITE_TRIES = 3;

function describedFor(config: Config, install: string, box: string | null): boolean {
  return box !== null && installFromDescription(config.description) === install && ownerFromDescription(config.description)?.boxId === box;
}

function isTemplate(config: Config): boolean {
  return config.template === 1 || config.template === "1";
}

export function boxOwner(install: string, box: string | null): GuestOwner {
  return {
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
  };
}

export function madeOwner(install: string, box: string | null): GuestOwner {
  return { words: `the guest bb-box is making for box ${box} of this install`, owns: (config) => !isTemplate(config) && describedFor(config, install, box) };
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

export function warmOwner(install: string): GuestOwner {
  return {
    words: "a warm guest of this install",
    owns: (config) => {
      const description = typeof config.description === "string" ? config.description : "";
      return !isTemplate(config) && description.startsWith("bb-box warm ") && installFromDescription(description) === install && copyTags(parseTags(config.tags)).box === null;
    },
  };
}

export function imageOwner(install: string, imageBox: string, imageTag: string): GuestOwner {
  return {
    words: "an image box or build of this install",
    owns: (config) => {
      const tags = parseTags(config.tags);
      const description = typeof config.description === "string" ? config.description : "";
      if (copyTags(tags).box !== null) return false;
      if (tags.includes(installTag(install)) && (tags.includes(imageBox) || tags.some((tag) => tag.startsWith(imageTag)))) return true;
      return description.startsWith("bb-box image box: ") && installFromDescription(description) === install;
    },
  };
}

export function templateOwner(vmid: number, as: Config): GuestOwner {
  return { words: `template ${vmid}, as this install's settings name it`, owns: (config) => isTemplate(config) && config.description === as.description && config.hostname === as.hostname };
}

export function eitherOwner(first: GuestOwner, second: GuestOwner): GuestOwner {
  return { words: `${first.words} or ${second.words}`, owns: (config) => first.owns(config) || second.owns(config) };
}

export function describedOwner(description: string): GuestOwner {
  return { words: "the guest bb-box has just made", owns: (config) => config.description === description };
}

export function unstampedOwner(box: string): GuestOwner {
  return {
    words: `box ${box}'s guest from before install IDs`,
    owns: (config) => {
      const names = namesOf(config);
      return names.install === null && names.box === box;
    },
  };
}

export function sameGuestOwner(install: string, as: Config): GuestOwner {
  const box = namesOf(as).box;
  return { words: `${box ? `box ${box}` : "the guest"} of this install, as bb-box read it`, owns: (config) => namesOf(config).install === install && namesOf(config).box === box };
}

function noLongerWords(vmid: number, owner: GuestOwner, config: Config | null): string {
  if (!config) return `CT ${vmid} has gone, so it is no longer ${owner.words}. bb-box changes nothing on it.`;
  const names = namesOf(config);
  const now = names.box ? `box ${names.box} of ${names.install ? `install ${names.install}` : "no install"}` : names.install ? `no box, of install ${names.install}` : "no box of any install";
  return `CT ${vmid} is no longer ${owner.words}: its config names ${now}. bb-box changes nothing on it and does not start it.`;
}

export class OwnedGuests {
  readonly #api: Proxmox;

  constructor(api: Proxmox) {
    this.#api = api;
  }

  async read(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<Config> {
    let config: Config | null;
    try {
      config = await this.#api.config(vmid, signal);
    } catch (error) {
      if (!(error instanceof ProxmoxError && error.gone)) throw error;
      config = null;
    }
    if (!config || !owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    return config;
  }

  async writeOn(vmid: number, owner: GuestOwner, config: Config, settings: GuestSettings, signal?: AbortSignal): Promise<void> {
    if (!owner.owns(config)) throw new NoLongerOurs(noLongerWords(vmid, owner, config));
    if (typeof config.digest !== "string" || !config.digest) throw new Error(`Proxmox gave no digest with CT ${vmid}'s config, so bb-box does not write it.`);
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
      if (typeof config.digest !== "string" || !config.digest) throw new Error(`Proxmox gave no digest with CT ${vmid}'s config, so bb-box does not write its network.`);
      try {
        await this.#api.setNetwork(vmid, { ...settings, digest: config.digest }, signal);
        return;
      } catch (error) {
        if (!(error instanceof ProxmoxError && error.changedMeanwhile) || tries >= WRITE_TRIES) throw error;
      }
    }
  }

  async start(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.read(vmid, owner, signal);
    await this.#api.start(vmid, signal);
  }

  async stop(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.read(vmid, owner, signal);
    await this.#api.stop(vmid, signal);
  }

  async shutdown(vmid: number, owner: GuestOwner, timeoutS: number, signal?: AbortSignal): Promise<void> {
    await this.read(vmid, owner, signal);
    await this.#api.shutdown(vmid, timeoutS, signal);
  }

  async growRootDisk(vmid: number, owner: GuestOwner, sizeGiB: number, signal?: AbortSignal): Promise<boolean> {
    await this.read(vmid, owner, signal);
    return this.#api.growRootDisk(vmid, sizeGiB, signal);
  }

  async makeTemplate(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    await this.read(vmid, owner, signal);
    await this.#api.makeTemplate(vmid, signal);
  }

  async destroy(vmid: number, owner: GuestOwner, signal?: AbortSignal): Promise<void> {
    try {
      await this.#api.config(vmid, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.gone) return;
      throw error;
    }
    await this.read(vmid, owner, signal);
    await this.#api.destroy(vmid, signal);
  }
}

export const GUEST_WRITES: readonly string[] = ["configure", "setNetwork", "start", "stop", "shutdown", "growRootDisk", "makeTemplate", "destroy", "hibernate"];
