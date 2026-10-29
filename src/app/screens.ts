import type { BoxView } from "../plugin/views.ts";

export type Screen = "device" | "desktop";

type Showing = Pick<BoxView, "device" | "desktop">;

export function screensOf(box: Showing): Screen[] {
  return [...(box.device ? (["device"] as const) : []), ...(box.desktop ? (["desktop"] as const) : [])];
}

export function screenWord(box: Showing, screen: Screen): string {
  if (screen === "desktop") return "Desktop";
  return box.device?.platform === "android" ? "Emulator" : "Simulator";
}

export function otherScreen(box: Showing, screen: Screen): Screen | null {
  return screensOf(box).find((each) => each !== screen) ?? null;
}

export function screenTitle(box: Pick<BoxView, "id" | "name" | "device" | "desktop">, screen: Screen, neighbours: readonly Pick<BoxView, "id" | "device" | "desktop">[], compactViewport = false): string {
  const word = screenWord(box, screen);
  const clashes = neighbours.some((other) => other.id !== box.id && screensOf(other).some((each) => screenWord(other, each) === word));
  if (!clashes) return word;
  return compactViewport ? box.name : `${word} · ${box.name}`;
}
