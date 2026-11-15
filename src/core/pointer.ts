// The box's pointer, from bb-box-cursor on a Wayland desktop with Sway 1.11
// (060), as bb-box sends it to the panel: shared by the plugin and the panel,
// so it has no dependencies.

/** bb-box's message of where the box's pointer is: `BB_POINTER,<x>,<y>` in the desktop's pixels, or `BB_POINTER,` when it left the desktop. */
export const POINTER_VERB = "BB_POINTER";

/** Why a VNC viewer's pointer stream ends at once: the box's image has no bb-box-cursor, and its VNC picture has its pointer, or none to draw. */
export const POINTER_NONE = "This desktop's pointer comes with its picture.";

export const AGENT_VERB = "BB_AGENT";

export type AgentAct = "click" | "scroll" | "at" | "typing" | "typed";

export type AgentClickShape = "hand" | "ibeam";

export interface AgentPlace {
  readonly act: AgentAct;
  readonly x: number;
  readonly y: number;
  readonly shape?: AgentClickShape;
}

const AGENT_ACTS: readonly string[] = ["click", "scroll", "at", "typing", "typed"] satisfies readonly AgentAct[];
const AGENT_CLICK_SHAPES: readonly string[] = ["hand", "ibeam"] satisfies readonly AgentClickShape[];

export function agentMessage(place: AgentPlace): string {
  const shape = place.act === "click" && place.shape ? `,${place.shape}` : "";
  return `${AGENT_VERB},${place.act},${Math.round(place.x)},${Math.round(place.y)}${shape}`;
}

export function agentPlaceOf(rest: string): AgentPlace | null {
  const [act, x, y, shape] = rest.split(",");
  const at = { x: Number(x), y: Number(y) };
  if (!act || !AGENT_ACTS.includes(act) || !x || !y || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const clickShape = act === "click" && shape && AGENT_CLICK_SHAPES.includes(shape) ? { shape: shape as AgentClickShape } : {};
  return { act: act as AgentAct, ...at, ...clickShape };
}
