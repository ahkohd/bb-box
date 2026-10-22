import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const panelPath = "/panel";
export const contract = defineRpcContract({ state: { input: z.object({}), output: z.null() } } as never);
