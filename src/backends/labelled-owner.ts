import { HOSTNAME_LIMIT, tailnetHostname } from "../core/tailnet.ts";
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
    const install = tailnetHostname(this.installId);
    if (this.takesUnlabelledMachines) return `${this.#naming.firstTailnetPrefix}${install}-`;
    return `${this.#naming.siblingTailnetPrefix}${install}-${lengthThenName(this.name ?? this.backendMark)}-`;
  }
}

function lengthThenName(name: string): string {
  return `${name.length}-${name}`;
}

const LONGEST_LENGTH_DIGITS_AND_SEPARATORS = "99--".length;

export function longestSiblingName(siblingTailnetPrefix: string): number {
  return HOSTNAME_LIMIT - `${siblingTailnetPrefix}${"x".repeat(LONGEST_INSTALL_ID)}-`.length - LONGEST_LENGTH_DIGITS_AND_SEPARATORS;
}
