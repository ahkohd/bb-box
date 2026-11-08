import type { BackendDriver } from "../types.ts";
import { BoatBackend } from "./backend.ts";
import { BOAT_FIELDS, BOAT_KINDS, parseBoatPart, type BoatConfig } from "./config.ts";
import { PRODUCT } from "../../brand.ts";

export const boatDriver: BackendDriver<BoatConfig> = {
  type: "boat",
  label: "boat.dev",
  description: `Linux VMs, with or without a desktop, rented by the second from boat.dev, one for each box. Each box is forked from ${PRODUCT}'s template in seconds, and deleted when it is released.`,
  nature: "virtual",
  form: "VM",
  kinds: BOAT_KINDS,
  fields: BOAT_FIELDS,
  setup: { guide: "docs/guide/boat.md", scripts: ["setup/boat/template.sh", "setup/boat/customize-sandbox.sh"], needs: "A boat.dev account and API key, and a way for its sandboxes to reach BB." },
  parse: parseBoatPart,
  create: (config, context) => new BoatBackend(config, context),
};
