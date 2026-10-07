// The computer tools (015): the agent drives a desktop box's apps through
// their accessibility tree, and images when appearance matters. src/core/
// computer.ts does the work; this file is the agent's side of it.

import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ComputerError, TREE_LIMIT, TREE_LIMIT_MAX, type ComputerResult } from "../core/computer.ts";
import type { BbBox } from "./setup.ts";
import { boxParam, failure, thread } from "./tools.ts";
import { next } from "./views.ts";

const INSTRUCTIONS =
  "bb-box computer use: to use the apps on a desktop box, get a window ID from computer_windows or computer_launch, read the window with computer_observe, " +
  "then act with computer_act or computer_type, giving an element's reference such as e12. Each action says what changed, so observe again only to see the whole window. " +
  "An action that opens a menu or popup says so, with its items' references; press keys in it with its window ID, or window \"desktop\". " +
  "Use computer_screenshot when appearance matters, and give pixels only from your latest image. " +
  "When a tool says a person has taken control of the desktop, stop using the computer tools until they hand it back. " +
  "If they ask you to continue, or the thread makes clear they have finished, take control back with computer_take_control.";

const windowId = z.number().int().nonnegative();
// Some agents' harnesses send a number as a string where it may also be "desktop".
const windowOrDesktop = z.union([windowId, z.literal("desktop"), z.string().regex(/^\d+$/)]);
const pixel = z.number().int().nonnegative();
const keysParam = z.string().min(1).describe('One key or chord to press, such as Escape, Return, Tab, ctrl+a or ctrl+shift+t: modifiers and a key joined by "+". Write ctrl++ for ctrl and the + key.');

/** A window ID given as digits, as a number. */
function windowRef<T>(window: T | string): T | number {
  return typeof window === "string" && /^\d+$/.test(window) ? Number(window) : (window as T);
}

function result(done: ComputerResult): PluginAgentToolResult {
  const text = `${done.text}${next(...done.hints)}`;
  if (!done.image) return text;
  return { content: [{ type: "text", text }, { type: "image", data: done.image.data, mimeType: done.image.mimeType }] };
}

function refusal(error: unknown, action: string): PluginAgentToolResult {
  if (!(error instanceof ComputerError)) return failure(error, action);
  return { content: [{ type: "text", text: `${error.message}${error.hint ? next(error.hint) : ""}` }], isError: true };
}

export function registerComputerTools(bb: BbPluginApi, app: BbBox): void {
  const { boxes, computer } = app;

  bb.agents.registerTool({
    name: "computer_windows",
    description: "List the windows on a desktop box's screen, with the window IDs the other computer tools take.",
    presentation: { label: { pending: "Listing windows", completed: "Listed windows" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        return result(await computer.windows((await app.resolve(thread(threadId), ref, signal)).box, signal));
      } catch (error) {
        return refusal(error, "Listing the windows");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_observe",
    description:
      "Read a window on a desktop box as text: its accessibility tree, one element per line, with a reference such as e12 for each element you can act on. " +
      "Pass query to see only matching elements, or screenshot for an image of the window as well.",
    instructions: INSTRUCTIONS,
    presentation: { label: { pending: "Reading a window", completed: "Read a window" } },
    parameters: z.object({
      box: boxParam,
      window: windowId.describe("The window's ID, from computer_windows or computer_launch."),
      query: z.string().min(1).optional().describe("Show only elements whose line contains this text, ignoring case, with their ancestors."),
      limit: z
        .number()
        .int()
        .positive()
        .max(TREE_LIMIT_MAX)
        .optional()
        .describe(`How many lines of the tree to show. Defaults to ${TREE_LIMIT}.`),
      screenshot: z.boolean().optional().describe("Also return an image of the window. Defaults to false."),
    }),
    async execute({ box: ref, window, query, limit, screenshot }, { threadId, signal }) {
      try {
        return result(await computer.observe((await app.resolve(thread(threadId), ref, signal)).box, { window, query, limit, screenshot }, signal));
      } catch (error) {
        return refusal(error, "Reading the window");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_screenshot",
    description:
      "Take an image of a window on a desktop box, or of the whole desktop. Use it when appearance matters or the tree does not show what you need. " +
      "Pixels you give computer_act are pixels of your latest image of that window, which may be smaller than the window or screen: the result says the scale.",
    presentation: { label: { pending: "Taking a screenshot", completed: "Took a screenshot" } },
    parameters: z.object({
      box: boxParam,
      window: windowOrDesktop.optional().describe('The window\'s ID, or "desktop" for the whole screen. Defaults to "desktop".'),
    }),
    async execute({ box: ref, window }, { threadId, signal }) {
      try {
        return result(await computer.screenshot((await app.resolve(thread(threadId), ref, signal)).box, windowRef(window ?? "desktop"), signal));
      } catch (error) {
        return refusal(error, "Taking the screenshot");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_act",
    description:
      "Click, double-click, right-click, scroll or set a value on a desktop box: on an element by its reference from computer_observe, " +
      "or at x and y in your latest image of a window or the desktop. Or press a key or chord with action key and keys, as computer_type does. " +
      "Says what changed in the window, which menus or popups opened or closed, and on the desktop which windows opened, closed or changed.",
    presentation: { label: { pending: "Acting on the desktop", completed: "Acted on the desktop" } },
    parameters: z.object({
      box: boxParam,
      action: z.enum(["click", "double_click", "right_click", "scroll", "set_value", "key"]).describe("What to do: click, double_click or right_click on ref or at x and y; scroll in direction; set_value to value; key to press keys."),
      ref: z.string().min(1).optional().describe("The element's reference from computer_observe, such as e12."),
      window: windowOrDesktop
        .optional()
        .describe('With x and y: the window whose image they are pixels of, or "desktop". For key without ref: the window that gets the key, or "desktop" for whatever has the focus.'),
      x: pixel.optional().describe("Pixels from the left of your latest image of the window."),
      y: pixel.optional().describe("Pixels from the top of your latest image of the window."),
      value: z.string().optional().describe("For set_value: the value, such as a field's text or a slider's number."),
      direction: z.enum(["up", "down", "left", "right"]).optional().describe("For scroll."),
      amount: z.number().int().min(1).max(50).optional().describe("For scroll: how many steps. Defaults to 3."),
      keys: keysParam.optional().describe("For key: the key or chord, such as Escape or ctrl+a."),
    }),
    async execute(input, { threadId, signal }) {
      try {
        const { box: ref, window, ...act } = input;
        return result(await computer.act((await app.resolve(thread(threadId), ref, signal)).box, { ...act, window: window === undefined ? undefined : windowRef(window) }, signal));
      } catch (error) {
        return refusal(error, "Acting on the desktop");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_type",
    description:
      "Type text, or press a key or chord such as Escape, Return, Tab, ctrl+a or ctrl+shift+t, into an element by its reference, or into the focused element of a window. " +
      'For an open menu or popup, give its window ID, or window "desktop" for whatever has the focus. Says what the element reads afterwards.',
    presentation: { label: { pending: "Typing", completed: "Typed" } },
    parameters: z.object({
      box: boxParam,
      text: z.string().optional().describe("Characters to type."),
      keys: keysParam.optional(),
      ref: z.string().min(1).optional().describe("The element's reference from computer_observe, such as e12."),
      window: windowOrDesktop
        .optional()
        .describe('Without ref: the window whose focused element gets the input, a menu or popup by its window ID, or "desktop" for whatever has the focus.'),
    }),
    async execute(input, { threadId, signal }) {
      try {
        const { box: ref, window, ...typed } = input;
        return result(await computer.type((await app.resolve(thread(threadId), ref, signal)).box, { ...typed, window: window === undefined ? undefined : windowRef(window) }, signal));
      } catch (error) {
        return refusal(error, "Typing");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_launch",
    description:
      "Open an app on a desktop box by its name or path, or open a URL in the box's browser. Says which windows it opened; for a URL, waits up to 10 s for the page's title.",
    presentation: { label: { pending: "Opening an app", completed: "Opened an app" } },
    parameters: z.object({
      box: boxParam,
      app: z.string().min(1).optional().describe("The app's name, such as firefox or mousepad, or the path of its program."),
      url: z.string().min(1).optional().describe("A URL to open in the default browser."),
    }),
    async execute({ box: ref, app: name, url }, { threadId, signal }) {
      try {
        return result(await computer.launch((await app.resolve(thread(threadId), ref, signal)).box, { app: name, url }, signal));
      } catch (error) {
        return refusal(error, "Opening the app");
      }
    },
  });

  bb.agents.registerTool({
    name: "computer_take_control",
    description:
      "Take control of a desktop box's desktop back from a person who took it in BB, so the computer tools work again. Keys they held down are let go, and the desktop gets back its size. " +
      "Use it when the person asks you to continue, or when the thread makes clear they have finished; otherwise wait for them to hand control back.",
    presentation: { label: { pending: "Taking control", completed: "Took control" } },
    parameters: z.object({ box: boxParam }),
    async execute({ box: ref }, { threadId, signal }) {
      try {
        return result(await computer.takeControl((await app.resolve(thread(threadId), ref, signal)).box));
      } catch (error) {
        return refusal(error, "Taking control");
      }
    },
  });
}
