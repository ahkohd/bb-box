import { LabelledOwner, longestSiblingName, type OwnerNaming } from "../labelled-owner.ts";

export { BACKEND_LABEL, INSTALL_LABEL } from "../labelled-owner.ts";

export const FIRST_BOAT_BACKEND_ID = "boat";

const BOAT_NAMING: OwnerNaming = {
  firstBackendId: FIRST_BOAT_BACKEND_ID,
  firstTailnetPrefix: "bb-box-boat-",
  siblingTailnetPrefix: "bb-box-boatb-",
};

export class BoatOwner extends LabelledOwner {
  constructor(backendId: string, installId: string) {
    super(backendId, installId, BOAT_NAMING);
  }

  idempotencyKey(what: string): string {
    return `bbbox-${this.scope}-${what}`;
  }

  get stagingMark(): string | null {
    return this.takesUnlabelledMachines ? null : this.backendMark;
  }
}

export const LONGEST_BOAT_BACKEND_NAME = longestSiblingName(BOAT_NAMING.siblingTailnetPrefix);
