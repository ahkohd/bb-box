// The box's pointer, from bb-box-cursor on a Wayland desktop with Sway 1.11
// (060), as bb-box sends it to the panel: shared by the plugin and the panel,
// so it has no dependencies.

/** bb-box's message of where the box's pointer is: `BB_POINTER,<x>,<y>` in the desktop's pixels, or `BB_POINTER,` when it left the desktop. */
export const POINTER_VERB = "BB_POINTER";

/** Why a VNC viewer's pointer stream ends at once: the box's image has no bb-box-cursor, and its VNC picture has its pointer, or none to draw. */
export const POINTER_NONE = "This desktop's pointer comes with its picture.";

export const AGENT_VERB = "BB_AGENT";

export type AgentAct = "click" | "scroll" | "at" | "shape";

export type AgentShape = "arrow" | "hand" | "ibeam";

export interface AgentPlace {
  readonly act: AgentAct;
  readonly x: number;
  readonly y: number;
  readonly shape?: AgentShape;
}

const AGENT_ACTS: readonly string[] = ["click", "scroll", "at", "shape"] satisfies readonly AgentAct[];
const AGENT_SHAPES: readonly string[] = ["arrow", "hand", "ibeam"] satisfies readonly AgentShape[];
const PLACE_ONLY_FORMS: readonly string[] = ["typing", "typed", "held"];
const SCREEN_PIXEL = /^\d{1,5}$/;

export function agentMessage(place: AgentPlace): string {
  const shape = place.act === "shape" ? `,${place.shape ?? "arrow"}` : "";
  return `${AGENT_VERB},${place.act},${Math.round(place.x)},${Math.round(place.y)}${shape}`;
}

function screenPixel(text: string | undefined): number | null {
  return text !== undefined && SCREEN_PIXEL.test(text) ? Number(text) : null;
}

export function agentPlaceOf(rest: string): AgentPlace | null {
  const [act, xText, yText, ...more] = rest.split(",");
  const x = screenPixel(xText);
  const y = screenPixel(yText);
  if (!act || x === null || y === null) return null;
  if (PLACE_ONLY_FORMS.includes(act)) return { act: "at", x, y };
  if (!AGENT_ACTS.includes(act)) return null;
  if (act !== "shape") return { act: act as AgentAct, x, y };
  const [shape, ...extra] = more;
  if (!shape || !AGENT_SHAPES.includes(shape) || extra.length) return null;
  return { act: "shape", x, y, shape: shape as AgentShape };
}
