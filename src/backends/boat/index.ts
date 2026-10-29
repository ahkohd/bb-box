import type { BackendDriver } from "../types.ts";
import { BoatBackend } from "./backend.ts";
import { BOAT_FIELDS, BOAT_KINDS, parseBoatPart, type BoatConfig } from "./config.ts";

export const boatDriver: BackendDriver<BoatConfig> = {
  type: "boat",
  label: "boat.dev",
  description: "Linux VMs rented by the second from boat.dev, one for each box. Each box is forked from bb-box's template in seconds, and deleted when it is released.",
  nature: "virtual",
  form: "VM",
  kinds: BOAT_KINDS,
  fields: BOAT_FIELDS,
  setup: { guide: "docs/guide/boat.md", scripts: ["setup/boat/template.sh", "setup/boat/customize-sandbox.sh"] },
  parse: parseBoatPart,
  create: (config, context) => new BoatBackend(config, context),
};
