export const motionPausedKey = "bb-box-motion-paused";
export const plainVideoKey = "bb-box-plain-video";

export interface VisitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function plainVideoRemembered(storage: VisitStorage | undefined): boolean {
  try {
    return storage?.getItem(plainVideoKey) === "yes";
  } catch {
    return false;
  }
}

export function rememberPlainVideo(storage: VisitStorage | undefined, plain: boolean): void {
  try {
    if (plain) storage?.setItem(plainVideoKey, "yes");
    else storage?.removeItem(plainVideoKey);
  } catch {}
}
