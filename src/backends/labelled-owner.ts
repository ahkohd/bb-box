import { HOSTNAME_LIMIT, TAILNET_HASH_LENGTH, fitsTailnetHostname, shortTailnetInstall, tailnetHash, tailnetHostname } from "../core/tailnet.ts";
import { LONGEST_INSTALL_ID } from "../core/install.ts";
import { backendIdName } from "../core/provider-name.ts";

export const INSTALL_LABEL = "bbbox-install";
export const BACKEND_LABEL = "bbbox-backend";

type Labels = Readonly<Record<string, string>>;

export interface OwnerNaming {
  readonly firstBackendId: string;
  readonly firstTailnetPrefix: string;
  readonly siblingTailnetPrefix: string;
}

export class LabelledOwner {
  readonly backendId: string;
  readonly installId: string;
  readonly #naming: OwnerNaming;

  constructor(backendId: string, installId: string, naming: OwnerNaming) {
    this.backendId = backendId;
    this.installId = installId;
    this.#naming = naming;
  }

  get takesUnlabelledMachines(): boolean {
    return this.backendId === this.#naming.firstBackendId;
  }

  get backendMark(): string {
    return this.backendId.replace(":", "-");
  }

  get name(): string | null {
    return backendIdName(this.backendId);
  }

  get scope(): string {
    return this.takesUnlabelledMachines ? this.installId : `${this.installId}-${this.backendMark}`;
  }

  labels(): Record<string, string> {
    return { [INSTALL_LABEL]: this.installId, [BACKEND_LABEL]: this.backendMark };
  }

  owns(labels: Labels): boolean {
    return labels[INSTALL_LABEL] === this.installId && this.madeByThisBackendId(labels);
  }

  madeByThisBackendId(labels: Labels): boolean {
    const mark = labels[BACKEND_LABEL];
    return mark === undefined ? this.takesUnlabelledMachines : mark === this.backendMark;
  }

  madeByAnotherBackendOfThisInstall(labels: Labels): boolean {
    return labels[INSTALL_LABEL] === this.installId && !this.owns(labels);
  }

  uniqueTag(what: string): string {
    return `bbbox-${this.scope}-${what}`.replace(/[^A-Za-z0-9-]+/g, "-");
  }

  tailnetPrefix(): string {
    return this.#prefixWith(tailnetHostname(this.installId));
  }

  tailnetHostname(box: string): string {
    const whole = `${this.tailnetPrefix()}${box}`;
    if (fitsTailnetHostname(whole)) return tailnetHostname(whole);
    const prefix = this.#prefixWithRoomForABox();
    return `${prefix}${shortenedBox(box, HOSTNAME_LIMIT - prefix.length)}`;
  }

  holdsTailnetHostname(hostname: string): boolean {
    return hostname.startsWith(this.tailnetPrefix()) || hostname.startsWith(this.#prefixWithRoomForABox());
  }

  #prefixWith(install: string): string {
    if (this.takesUnlabelledMachines) return `${this.#naming.firstTailnetPrefix}${install}-`;
    return `${this.#naming.siblingTailnetPrefix}${install}-${lengthThenName(this.name ?? this.backendMark)}-`;
  }

  #prefixWithRoomForABox(): string {
    const prefix = this.tailnetPrefix();
    return prefix.length <= LONGEST_PREFIX_WITH_ROOM_FOR_A_BOX ? prefix : this.#prefixWith(shortTailnetInstall(this.installId));
  }
}

const READABLE_BOX_LETTERS = 2;
const SHORTEST_BOX_PART = READABLE_BOX_LETTERS + "-".length + TAILNET_HASH_LENGTH;
const LONGEST_PREFIX_WITH_ROOM_FOR_A_BOX = HOSTNAME_LIMIT - SHORTEST_BOX_PART;

function shortenedBox(box: string, room: number): string {
  const readable = tailnetHostname(box).slice(0, room - "-".length - TAILNET_HASH_LENGTH).replace(/-+$/, "");
  return readable ? `${readable}-${tailnetHash(box)}` : tailnetHash(box);
}

function lengthThenName(name: string): string {
  return `${name.length}-${name}`;
}

const LONGEST_LENGTH_DIGITS_AND_SEPARATORS = "99--".length;

export function longestSiblingName(siblingTailnetPrefix: string): number {
  return HOSTNAME_LIMIT - `${siblingTailnetPrefix}${"x".repeat(LONGEST_INSTALL_ID)}-`.length - LONGEST_LENGTH_DIGITS_AND_SEPARATORS;
}
