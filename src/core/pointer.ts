// The box's pointer, from bb-box-cursor on a Wayland desktop with Sway 1.11
// (060), as bb-box sends it to the panel: shared by the plugin and the panel,
// so it has no dependencies.

/** bb-box's message of where the box's pointer is: `BB_POINTER,<x>,<y>` in the desktop's pixels, or `BB_POINTER,` when it left the desktop. */
export const POINTER_VERB = "BB_POINTER";

/** Why a VNC viewer's pointer stream ends at once: the box's image has no bb-box-cursor, and its VNC picture has its pointer, or none to draw. */
export const POINTER_NONE = "This desktop's pointer comes with its picture.";

export const AGENT_VERB = "BB_AGENT";

export type AgentAct = "click" | "scroll" | "at" | "typing" | "typed" | "held";

export type AgentClickShape = "hand" | "ibeam";

export interface AgentPlace {
  readonly act: AgentAct;
  readonly x: number;
  readonly y: number;
  readonly shape?: AgentClickShape;
  readonly agoMs?: number;
  readonly forMs?: number;
}

const AGENT_ACTS: readonly string[] = ["click", "scroll", "at", "typing", "typed", "held"] satisfies readonly AgentAct[];
const AGENT_CLICK_SHAPES: readonly string[] = ["hand", "ibeam"] satisfies readonly AgentClickShape[];
const SHAPED_ACTS: readonly AgentAct[] = ["click", "held"];
const TIMED_ACTS: readonly AgentAct[] = ["held", "typing"];
const WHOLE_MS = /^\d+$/;

function timing(place: AgentPlace): string {
  if (!TIMED_ACTS.includes(place.act) || place.agoMs === undefined) return "";
  const ago = `,${Math.max(0, Math.round(place.agoMs))}`;
  return place.forMs === undefined ? ago : `${ago},${Math.max(0, Math.round(place.forMs))}`;
}

export function agentMessage(place: AgentPlace): string {
  const shape = SHAPED_ACTS.includes(place.act) && place.shape ? `,${place.shape}` : "";
  return `${AGENT_VERB},${place.act},${Math.round(place.x)},${Math.round(place.y)}${shape}${timing(place)}`;
}

function wholeMs(text: string | undefined): number | null | undefined {
  if (text === undefined) return undefined;
  return WHOLE_MS.test(text) ? Number(text) : null;
}

export function agentPlaceOf(rest: string): AgentPlace | null {
  const [act, x, y, ...more] = rest.split(",");
  const at = { x: Number(x), y: Number(y) };
  if (!act || !AGENT_ACTS.includes(act) || !x || !y || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const known = act as AgentAct;
  const shape = SHAPED_ACTS.includes(known) ? more.shift() : undefined;
  const shaped = !!shape && AGENT_CLICK_SHAPES.includes(shape);
  if (known === "held" && !shaped) return null;
  const shapes = shaped ? { shape: shape as AgentClickShape } : {};
  if (!TIMED_ACTS.includes(known)) return { act: known, ...at, ...shapes };
  const [agoText, forText, ...extra] = more;
  const agoMs = wholeMs(agoText);
  const forMs = wholeMs(forText);
  if (agoMs === null || forMs === null || extra.length || (agoMs === undefined && known === "held")) return null;
  if (known === "held" && forMs === undefined && shape !== "ibeam") return null;
  return { act: known, ...at, ...shapes, ...(agoMs !== undefined ? { agoMs } : {}), ...(forMs !== undefined ? { forMs } : {}) };
}
