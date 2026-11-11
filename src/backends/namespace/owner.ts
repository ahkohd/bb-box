import { LabelledOwner, longestSiblingName, type OwnerNaming } from "../labelled-owner.ts";

export { BACKEND_LABEL, INSTALL_LABEL } from "../labelled-owner.ts";

export const FIRST_NAMESPACE_BACKEND_ID = "namespace";

const NAMESPACE_NAMING: OwnerNaming = {
  firstBackendId: FIRST_NAMESPACE_BACKEND_ID,
  firstTailnetPrefix: "bb-box-ns-",
  siblingTailnetPrefix: "bb-box-nsb-",
};

export class NamespaceOwner extends LabelledOwner {
  constructor(backendId: string, installId: string) {
    super(backendId, installId, NAMESPACE_NAMING);
  }

  imageTag(key: string): string {
    return this.name && !this.takesUnlabelledMachines ? `${this.name}-${key}` : key;
  }
}

export const LONGEST_NAMESPACE_BACKEND_NAME = longestSiblingName(NAMESPACE_NAMING.siblingTailnetPrefix);
