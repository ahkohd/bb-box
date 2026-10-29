import { DEFAULT_TAILNET_TAGS, type TailnetCredentials } from "./tailnet.ts";

export const TAILNET_CLIENT_ID = "tailnet:client-id";
export const TAILNET_CLIENT_SECRET = "tailnet:client-secret";
export const TAILNET_SECRET_KEYS: readonly string[] = [TAILNET_CLIENT_ID, TAILNET_CLIENT_SECRET];

export type TailnetMode = "off" | "oauth";

export interface TailnetSetting {
  readonly mode: TailnetMode;
  readonly tags?: readonly string[];
  readonly clientId?: { readonly set: boolean; readonly version?: number };
  readonly clientSecret?: { readonly set: boolean; readonly version?: number };
}

export interface TailnetUse {
  readonly credentials: TailnetCredentials;
  readonly tags: readonly string[];
}

const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;
const MODES: readonly TailnetMode[] = ["off", "oauth"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSetState(value: unknown): value is { readonly set: boolean } {
  return isRecord(value) && typeof value.set === "boolean" && Object.keys(value).every((key) => key === "set" || (key === "version" && typeof value.version === "number"));
}

function readSecret(value: unknown, key: string, at: string, what: string, problem: (path: string, message: string) => void, changes: Record<string, string | null>): void {
  if (value === undefined) return;
  if (isSetState(value)) {
    if (!value.set) changes[key] = null;
    return;
  }
  if (value === null || value === "") {
    changes[key] = null;
    return;
  }
  if (typeof value !== "string") return problem(at, `The ${what} is a secret: give it as text, null to clear it, or {"set": true} to keep it.`);
  changes[key] = value.trim();
}

export function readTailnet(value: unknown, problem: (path: string, message: string) => void, changes: Record<string, string | null>): TailnetSetting | undefined {
  if (!isRecord(value)) {
    problem("general.tailnet", 'tailnet is an object: {"mode": "off"}, or {"mode": "oauth", "tags": ["tag:bb-box"], "clientId": "…", "clientSecret": "…"}.');
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["mode", "tags", "clientId", "clientSecret"].includes(key)) problem(`general.tailnet.${key}`, `There is no tailnet setting "${key}". There are mode, tags, clientId and clientSecret.`);
  }
  const mode = value.mode ?? "off";
  if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
    problem("general.tailnet.mode", 'The tailnet\'s mode is "off", for a BB that machines reach without it, or "oauth", for a Tailscale OAuth client that bb-box makes keys with.');
    return undefined;
  }
  let tags: string[] | undefined;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || !value.tags.length || !value.tags.every((tag) => typeof tag === "string" && TAG.test(tag))) {
      problem("general.tailnet.tags", "The tailnet's tags are a list of at least one, each like tag:bb-box: lower-case letters, digits and -.");
    } else tags = [...new Set(value.tags as string[])];
  }
  readSecret(value.clientId, TAILNET_CLIENT_ID, "general.tailnet.clientId", "OAuth client's ID", problem, changes);
  readSecret(value.clientSecret, TAILNET_CLIENT_SECRET, "general.tailnet.clientSecret", "OAuth client's secret", problem, changes);
  return { mode: mode as TailnetMode, ...(tags ? { tags } : {}) };
}

export function tailnetProblems(setting: TailnetSetting | undefined, stored: Readonly<Record<string, string>>): { readonly path: string; readonly message: string }[] {
  if (setting?.mode !== "oauth") return [];
  const missing = [
    ...(stored[TAILNET_CLIENT_ID] ? [] : [{ path: "general.tailnet.clientId", message: "Set the Tailscale OAuth client's ID, as the guide shows." }]),
    ...(stored[TAILNET_CLIENT_SECRET] ? [] : [{ path: "general.tailnet.clientSecret", message: "Set the Tailscale OAuth client's secret, as the guide shows." }]),
  ];
  return missing;
}

export function keptTailnetSecrets(setting: TailnetSetting | undefined, stored: Readonly<Record<string, string>>, changes: Readonly<Record<string, string | null>>): Record<string, string> {
  if (setting?.mode !== "oauth") return {};
  const kept: Record<string, string> = {};
  for (const key of TAILNET_SECRET_KEYS) {
    const value = changes[key] === undefined ? stored[key] : changes[key];
    if (typeof value === "string" && value) kept[key] = value;
  }
  return kept;
}

export function exportedTailnet(setting: TailnetSetting, stored: Readonly<Record<string, string>>): TailnetSetting {
  if (setting.mode !== "oauth") return { mode: setting.mode, ...(setting.tags ? { tags: setting.tags } : {}) };
  return { ...setting, clientId: { set: !!stored[TAILNET_CLIENT_ID] }, clientSecret: { set: !!stored[TAILNET_CLIENT_SECRET] } };
}

export function tailnetUse(setting: TailnetSetting | undefined, stored: Readonly<Record<string, string>>): TailnetUse | null {
  if (setting?.mode !== "oauth") return null;
  const clientId = stored[TAILNET_CLIENT_ID];
  const clientSecret = stored[TAILNET_CLIENT_SECRET];
  if (!clientId || !clientSecret) return null;
  return { credentials: { clientId, clientSecret }, tags: setting.tags?.length ? setting.tags : DEFAULT_TAILNET_TAGS };
}
