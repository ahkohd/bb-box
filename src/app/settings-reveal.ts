import type { Path } from "./settings-paths.ts";

const LOOK_STEP_MS = 40;
const LOOK_FOR_MS = 4000;
const STEADY_LOOKS = 3;
const SETTLE_FOR_MS = 1500;
export const FOUND_RING_MS = 1400;

const FOCUSABLE = "input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])";

function settingIn(root: HTMLElement, path: Path): HTMLElement | null {
  const matches = Array.from(root.querySelectorAll<HTMLElement>(`[data-draft-path="${CSS.escape(path)}"]`));
  return matches.find((element) => element instanceof HTMLInputElement && element.checked) ?? matches[0] ?? null;
}

function ringOf(target: HTMLElement): HTMLElement {
  return target.closest<HTMLElement>("[data-setting-row]") ?? target.closest<HTMLElement>("label") ?? target;
}

function focusSetting(target: HTMLElement, row: HTMLElement): void {
  target.focus({ preventScroll: true });
  if (document.activeElement === target) return;
  const inside = Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE)).find((element) => element.getAttribute("aria-disabled") !== "true");
  if (inside) {
    inside.focus({ preventScroll: true });
    if (document.activeElement === inside) return;
  }
  if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
  row.focus({ preventScroll: true });
}

function ringColor(element: HTMLElement): string {
  const style = window.getComputedStyle(element);
  return style.getPropertyValue("--color-ring").trim() || style.getPropertyValue("--ring").trim() || "currentColor";
}

function prefersLessMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ringFound(row: HTMLElement): void {
  row.setAttribute("data-found", "");
  setTimeout(() => row.removeAttribute("data-found"), FOUND_RING_MS);
  if (typeof row.animate !== "function") return;
  const color = ringColor(row);
  row.animate([{ boxShadow: `inset 0 0 0 2px ${color}`, borderRadius: "6px" }, { boxShadow: `inset 0 0 0 2px transparent`, borderRadius: "6px" }], { duration: FOUND_RING_MS, easing: prefersLessMotion() ? "steps(1, end)" : "cubic-bezier(0.23, 1, 0.32, 1)" });
}

export function revealWhenSettled(root: () => HTMLElement | null, path: Path, onMissing: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const started = Date.now();
  let foundAt: number | null = null;
  let lastTop: number | null = null;
  let steady = 0;
  const look = () => {
    if (stopped) return;
    const container = root();
    const target = container ? settingIn(container, path) : null;
    if (!target) {
      if (Date.now() - started > LOOK_FOR_MS) {
        onMissing();
        return;
      }
      timer = setTimeout(look, LOOK_STEP_MS);
      return;
    }
    foundAt ??= Date.now();
    const top = target.getBoundingClientRect().top;
    steady = top === lastTop ? steady + 1 : 0;
    lastTop = top;
    if (steady < STEADY_LOOKS && Date.now() - foundAt < SETTLE_FOR_MS) {
      timer = setTimeout(look, LOOK_STEP_MS);
      return;
    }
    const row = ringOf(target);
    row.scrollIntoView?.({ block: "center" });
    focusSetting(target, row);
    ringFound(row);
  };
  look();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
