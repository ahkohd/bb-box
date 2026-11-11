import { createHash } from "node:crypto";
import { tailnetHostname } from "../../core/tailnet.ts";
import { backendIdName } from "../../core/provider-name.ts";

export const INSTALL_LABEL = "bbbox-install";
export const BACKEND_LABEL = "bbbox-backend";
const FIRST_NAMESPACE_BACKEND_ID = "namespace";
const TAILNET_HASH_LENGTH = 6;

type Labels = Readonly<Record<string, string>>;

export class NamespaceOwner {
  readonly backendId: string;
  readonly installId: string;

  constructor(backendId: string, installId: string) {
    this.backendId = backendId;
    this.installId = installId;
  }

  get takesUnlabelledMachines(): boolean {
    return this.backendId === FIRST_NAMESPACE_BACKEND_ID;
  }

  get backendMark(): string {
    return this.backendId.replace(":", "-");
  }

  get name(): string | null {
    return backendIdName(this.backendId);
  }

  labels(): Record<string, string> {
    return { [INSTALL_LABEL]: this.installId, [BACKEND_LABEL]: this.backendMark };
  }

  owns(labels: Labels): boolean {
    if (labels[INSTALL_LABEL] !== this.installId) return false;
    const mark = labels[BACKEND_LABEL];
    return mark === undefined ? this.takesUnlabelledMachines : mark === this.backendMark;
  }

  madeByAnotherBackendOfThisInstall(labels: Labels): boolean {
    return labels[INSTALL_LABEL] === this.installId && !this.owns(labels);
  }

  uniqueTag(what: string): string {
    const scope = this.takesUnlabelledMachines ? this.installId : `${this.installId}-${this.backendMark}`;
    return `bbbox-${scope}-${what}`.replace(/[^A-Za-z0-9-]+/g, "-");
  }

  imageTag(key: string): string {
    return this.name && !this.takesUnlabelledMachines ? `${this.name}-${key}` : key;
  }

  tailnetPrefix(): string {
    const install = tailnetHostname(this.installId);
    if (this.takesUnlabelledMachines) return `bb-box-ns-${install}-`;
    return `${namespaceSiblingTailnetPrefix(install)}${createHash("sha256").update(this.backendId).digest("hex").slice(0, TAILNET_HASH_LENGTH)}-`;
  }
}

export function namespaceSiblingTailnetPrefix(install: string): string {
  return `bb-box-nsb-${install}-`;
}
