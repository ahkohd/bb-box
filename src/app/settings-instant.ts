import { useCallback, useRef, useState } from "react";
import type { ApplyResult, ConfigState } from "../plugin/configuration.ts";
import { message } from "./common.tsx";

export const MOST_TRIES = 3;
export const SAVED_SHOWN_MS = 1600;

export interface InstantWrite<T> {
  readonly key: string;
  readonly what: string;
  readonly value: T;
  read(state: ConfigState): T;
  say(value: T): string;
  send(state: ConfigState): Promise<ApplyResult>;
}

export type InstantOutcome =
  | { readonly kind: "saved"; readonly revision: number; readonly note: string | null }
  | { readonly kind: "already"; readonly revision: number; readonly note: string }
  | { readonly kind: "refused"; readonly note: string }
  | { readonly kind: "raced"; readonly note: string }
  | { readonly kind: "unknown"; readonly note: string };

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export async function runInstant<T>(write: InstantWrite<T>, seen: ConfigState, reload: () => Promise<ConfigState>): Promise<InstantOutcome> {
  let state = seen;
  for (let tries = 0; tries < MOST_TRIES; tries++) {
    if (tries > 0 && same(write.read(state), write.value)) {
      return { kind: "already", revision: state.revision, note: `Already ${write.say(write.value)}: changed elsewhere at revision ${state.revision}.` };
    }
    let result: ApplyResult;
    try {
      result = await write.send(state);
    } catch (caught) {
      return { kind: "unknown", note: await unknownNote(write, caught, reload) };
    }
    if (result.ok) return { kind: "saved", revision: result.state.revision, note: null };
    if (result.reason === "problems") {
      const reasons = result.problems.map((problem) => problem.message).join(" ") || "BB Box gave no reason.";
      return { kind: "refused", note: `${write.what} was not changed: ${reasons}` };
    }
    state = result.state;
  }
  return { kind: "raced", note: `${write.what} was not changed: the configuration changed ${MOST_TRIES} times while saving. It is ${write.say(write.read(state))}; try again.` };
}

async function unknownNote<T>(write: InstantWrite<T>, caught: unknown, reload: () => Promise<ConfigState>): Promise<string> {
  const reason = message(caught).replace(/\.+$/, "");
  try {
    const latest = await reload();
    return `Not confirmed: BB Box did not reply (${reason}). ${write.what} is ${write.say(write.read(latest))} now, at revision ${latest.revision}.`;
  } catch {
    return `Not confirmed: BB Box did not reply (${reason}), and the configuration could not be read again. Reload the page to see what is saved.`;
  }
}

export interface Instant {
  readonly pending: string | null;
  pendingValue<T>(key: string): T | undefined;
  readonly saved: string | null;
  note(key: string): string | null;
  run<T>(write: InstantWrite<T>): Promise<InstantOutcome | null>;
}

export function useInstant(state: ConfigState | null, reload: () => Promise<ConfigState>, refresh: () => Promise<void>): Instant {
  const [pending, setPending] = useState<{ readonly key: string; readonly value: unknown } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const busy = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const run = useCallback(
    async <T,>(write: InstantWrite<T>): Promise<InstantOutcome | null> => {
      const seen = latest.current;
      if (!seen || busy.current) return null;
      busy.current = true;
      setPending({ key: write.key, value: write.value });
      setSaved(null);
      setNotes((current) => withoutKey(current, write.key));
      try {
        const outcome = await runInstant(write, seen, reload);
        await refresh();
        if (outcome.kind === "saved" || outcome.kind === "already") {
          setSaved(write.key);
          setTimeout(() => setSaved((current) => (current === write.key ? null : current)), SAVED_SHOWN_MS);
        }
        const note = outcome.note;
        if (note) setNotes((current) => ({ ...current, [write.key]: note }));
        return outcome;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [reload, refresh],
  );
  return {
    pending: pending?.key ?? null,
    pendingValue: <T,>(key: string) => (pending?.key === key ? (pending.value as T) : undefined),
    saved,
    note: (key: string) => notes[key] ?? null,
    run,
  };
}

function withoutKey(notes: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const { [key]: _gone, ...rest } = notes;
  return rest;
}
