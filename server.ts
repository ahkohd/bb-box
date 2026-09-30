// bb-box's server entry. See src/plugin/setup.ts.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { setup } from "./src/plugin/setup.ts";

export type { Contract } from "./src/plugin/contract.ts";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  await setup(bb);
}
