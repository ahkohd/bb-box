import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { forPurpose } from "../transports/spawns.ts";

type RegisterTool = BbPluginApi["agents"]["registerTool"];

/** bb.agents.registerTool, with what each tool starts counted as for "tool <its name>". */
const registered = new WeakMap<BbPluginApi, string[]>();

export function registeredTools(bb: BbPluginApi): readonly string[] {
  return registered.get(bb) ?? [];
}

export function toolsForPurposes(bb: BbPluginApi): RegisterTool {
  return ((tool: { name: string; execute: (params: unknown, context: unknown) => unknown }) => {
    bb.agents.registerTool({ ...tool, execute: (params: unknown, context: unknown) => forPurpose(`tool ${tool.name}`, () => tool.execute(params, context)) } as never);
    registered.set(bb, [...registeredTools(bb), tool.name]);
  }) as RegisterTool;
}
