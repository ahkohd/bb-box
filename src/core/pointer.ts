// The box's pointer, from bb-box-cursor on a Wayland desktop with Sway 1.11
// (060), as bb-box sends it to the panel: shared by the plugin and the panel,
// so it has no dependencies.

/** bb-box's message of where the box's pointer is: `BB_POINTER,<x>,<y>` in the desktop's pixels, or `BB_POINTER,` when it left the desktop. */
export const POINTER_VERB = "BB_POINTER";

/** Why a VNC viewer's pointer stream ends at once: the box's image has no bb-box-cursor, and its VNC picture has its pointer, or none to draw. */
export const POINTER_NONE = "This desktop's pointer comes with its picture.";

export const AGENT_VERB = "BB_AGENT";

export type AgentAct = "click" | "scroll" | "at";

export interface AgentPlace {
  readonly act: AgentAct;
  readonly x: number;
  readonly y: number;
}

const AGENT_ACTS: readonly string[] = ["click", "scroll", "at"] satisfies readonly AgentAct[];

export function agentMessage(place: AgentPlace): string {
  return `${AGENT_VERB},${place.act},${Math.round(place.x)},${Math.round(place.y)}`;
}

export function agentPlaceOf(rest: string): AgentPlace | null {
  const [act, x, y] = rest.split(",");
  const at = { x: Number(x), y: Number(y) };
  if (!act || !AGENT_ACTS.includes(act) || !x || !y || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return { act: act as AgentAct, ...at };
}
