import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BoxError, type BoxRecord } from "../core/boxes.ts";
import { answerText, controlFromParameters } from "../core/device-control.ts";
import { deviceStateWords } from "../core/device-settings.ts";
import { DEVICE_ACTIONS, IOS_CONTENT_SIZES, ORIENTATIONS, deviceModel, modelNamed, offeredModels, type DeviceAnswer, type DeviceErrorCode, type ModelName } from "../core/device.ts";
import { inSlot, slotSwitchRefusal } from "../core/device-host.ts";
import { toolsForPurposes } from "./purposes.ts";
import type { BbBox } from "./setup.ts";
import { boxParam, failure, thread } from "./tools.ts";
import { next } from "./views.ts";

const HINTS: Partial<Record<DeviceErrorCode, string>> = {
  unsupported: "Call box_device with one of the actions it names.",
  "unknown-device": "Pick one of the devices it names, or call box_list.",
  "bad-value": "Call box_device again with what the action takes.",
  "not-booted": "Call box_status to see when the device has booted.",
  busy: "Call box_status, and try again once it says the device has booted.",
  "outcome-unknown": "Read the device's state with box_status before trying again.",
  "person-has-control": "Leave the device alone until the person hands control back, or until they ask you to continue: then call computer_take_control.",
  superseded: "Try again in a few seconds: another bb-box instance holds the box's device server.",
  failed: "Call box_status to see the device's state.",
};

function modelOf(app: BbBox, box: BoxRecord): ModelName {
  const view = app.devices.view(box.id);
  if (view.is === "connected") return view.state.model;
  return box.device?.model ?? box.askedDevice ?? box.capabilities.device!.devices[0].model;
}

function refusal(box: BoxRecord, answer: Extract<DeviceAnswer, { ok: false }>): PluginAgentToolResult {
  const now = answer.state && answer.error.code !== "outcome-unknown" ? ` The ${answer.state.model} is ${deviceStateWords(answer.state)}.` : "";
  const hint = HINTS[answer.error.code];
  return { content: [{ type: "text", text: `Box ${box.name}: ${answer.error.words}${now}${hint ? next(hint) : ""}` }], isError: true };
}

export function registerDeviceTools(bb: BbPluginApi, app: BbBox): void {
  const registerTool = toolsForPurposes(bb);

  registerTool({
    name: "box_device",
    description:
      "Control an ios or android box's device, as the panel's toolbar does: Home, Back and Recents, lock and wake, rotate, fold, appearance, text size, location, status bar, battery, network, install an app, switch device, and reboot. Each action takes only its own parameters. The answer says what happened, how long it took, and the device's state after it. While a person has control of the box, every action but install is refused, and so is an install that would replace an installed app. Screenshots, taps and URLs are the computer tools'.",
    presentation: { label: { pending: "Controlling a device", completed: "Controlled a device" } },
    parameters: z.object({
      box: boxParam,
      action: z
        .enum(DEVICE_ACTIONS)
        .describe("What to do. iOS has no back, recents, posture or network; only foldables take posture. box_status lists the device's actions."),
      turn: z.enum(["left", "right"]).optional().describe("rotate: a quarter turn from where the device is, the way the toolbar's arrows point."),
      to: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          `rotate: ${ORIENTATIONS.join(", ")}. posture: closed, half-open, open. appearance: light, dark. text_size: larger, smaller, default, or a step of the platform: an iOS content size from ${IOS_CONTENT_SIZES[0]} to ${IOS_CONTENT_SIZES.at(-1)}, such as accessibility-large, or an Android font scale such as 1.3. status_bar: clean, live. network: online, offline, slow.`,
        ),
      latitude: z.number().optional().describe("location: with longitude, from -90 to 90. Leave both out to clear the simulated location."),
      longitude: z.number().optional().describe("location: with latitude, from -180 to 180."),
      level: z.number().optional().describe("battery: with charging, a whole number from 0 to 100. Leave both out for the device's own. On iOS only the status bar's picture changes."),
      charging: z.boolean().optional().describe("battery: with level, whether it charges."),
      paths: z
        .array(z.string().min(1))
        .optional()
        .describe("install: in the box, as box_copy puts them there. On iOS one .app folder built for the simulator; on Android one .apk, or the split APKs of one app."),
      device: z.string().min(1).optional().describe("switch: a model this box offers, from box_list, such as iPhone 17. Each model keeps its own apps and data."),
    }),
    async execute(parameters, { threadId, signal }) {
      try {
        const { box: found } = await app.resolve(thread(threadId), parameters.box, signal);
        const offer = found.capabilities.device;
        if (!offer) throw new BoxError("unsupported", `Box ${found.name} has no device: box_device works on ios and android boxes.`);
        if (found.state !== "ready") throw new BoxError("not_ready", `Box ${found.name} is ${found.state}.`);
        const model = deviceModel(modelOf(app, found));
        const elsewhere = parameters.action === "switch" && parameters.device !== undefined && inSlot(found) ? modelNamed(parameters.device, model.platform) : null;
        if (elsewhere && !offeredModels(offer).includes(elsewhere.name)) return { content: [{ type: "text", text: `Box ${found.name}: ${slotSwitchRefusal(model.name, elsewhere.name)}` }], isError: true };
        const parsed = controlFromParameters(parameters, model, offeredModels(offer));
        if (!parsed.ok) return refusal(found, { id: "", ok: false, error: parsed.error, state: null });
        const answer = await app.devices.control(found, parsed.control, { signal });
        if (!answer.ok) return refusal(found, answer);
        return `${answerText(parsed.control, model, answer)}${next("Call box_status for the device's details.")}`;
      } catch (error) {
        return failure(error, "Controlling the device");
      }
    },
  });
}
