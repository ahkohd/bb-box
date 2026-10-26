import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TouchContact } from "../core/device.ts";
import { DriverError, type PinchGesture } from "./driver.ts";
import type { GrpcClient } from "./grpc.ts";
import { encode, type ProtoMessage } from "./protobuf.ts";
import { usKey } from "./keys.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "./schemas.ts";

export const PASTE_NOTICE_MS = 2_600;
export const PASTE_ACCESS_KEPT_MS = 5_000;
export const TOUCHES_REPLAYED_MS = 300;
const CHORD_GAP_MS = 15;
const DOWN = 0;
const UP = 1;
const PINCH_MS = { least: 200, most: 1_000 } as const;
const PINCH_SPAN_LEAST_POINTS = 10;
const PINCH_SCALE_UNCHANGED = 0.05;
const PASTEBOARD_SERVICE = "kTCCServicePasteboard";
const ALLOWED = 2;
export const HID_BUTTONS = { home: 1, lock: 2 } as const;

export const HID_USAGES: Readonly<Record<string, number>> = {
  ...Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter, index) => [`Key${letter}`, 4 + index])),
  ...Object.fromEntries([..."123456789"].map((digit, index) => [`Digit${digit}`, 30 + index])),
  Digit0: 39,
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 51,
  Quote: 52,
  Backquote: 53,
  Comma: 54,
  Period: 55,
  Slash: 56,
  CapsLock: 57,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, 58 + index])),
  Insert: 73,
  Home: 74,
  PageUp: 75,
  Delete: 76,
  End: 77,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
  ControlLeft: 224,
  ShiftLeft: 225,
  AltLeft: 226,
  MetaLeft: 227,
};

type OptionStroke = { readonly option: string; readonly then: string | null };

const DEAD_KEYS: readonly (readonly [string, string, string])[] = [
  ["`", "aeiou", "àèìòù"],
  ["e", "aeiou", "áéíóú"],
  ["i", "aeiou", "âêîôû"],
  ["u", "aeiouy", "äëïöüÿ"],
  ["n", "ano", "ãñõ"],
];

const OPTION_LETTERS: readonly (readonly [string, string])[] = [
  ["s", "ß"],
  ["c", "ç"],
  ["C", "Ç"],
  ["o", "ø"],
  ["O", "Ø"],
  ["'", "æ"],
  ['"', "Æ"],
  ["q", "œ"],
  ["Q", "Œ"],
  ["a", "å"],
  ["A", "Å"],
  ["1", "¡"],
  ["?", "¿"],
];

export const OPTION_STROKES: ReadonlyMap<string, OptionStroke> = new Map<string, OptionStroke>([
  ...DEAD_KEYS.flatMap(([dead, bases, results]) =>
    [...bases].flatMap((base, index): [string, OptionStroke][] => {
      const plain = [...results][index]!;
      const capital = plain.toUpperCase();
      return capital === plain ? [[plain, { option: dead, then: base }]] : [[plain, { option: dead, then: base }], [capital, { option: dead, then: base.toUpperCase() }]];
    }),
  ),
  ...OPTION_LETTERS.map(([key, letter]): [string, OptionStroke] => [letter, { option: key, then: null }]),
]);

export function typesWithOption(character: string): boolean {
  return OPTION_STROKES.has(character);
}

export function hidKey(key: string): { readonly usage: number; readonly shift: boolean } | null {
  const us = usKey(key);
  const usage = us ? HID_USAGES[us.code] : undefined;
  return us && usage !== undefined ? { usage, shift: us.shift } : null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HidStream {
  readonly #client: () => GrpcClient;
  readonly #log: (line: string) => void;
  #queue: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #open = false;
  #stream = 0;
  #recentTouches: { readonly event: Uint8Array; readonly at: number }[] = [];

  constructor(client: () => GrpcClient, log: (line: string) => void) {
    this.#client = client;
    this.#log = log;
  }

  get open(): boolean {
    return this.#open;
  }

  ensure(): void {
    if (this.#open) return;
    const client = this.#client();
    const stream = ++this.#stream;
    this.#open = true;
    this.#queue = [];
    const self = this;
    async function* events() {
      for (;;) {
        while (self.#stream === stream && self.#queue.length) yield self.#queue.shift()!;
        if (self.#stream !== stream) return;
        await new Promise<void>((resolve) => (self.#wake = resolve));
      }
    }
    void (async () => {
      try {
        for await (const _ of client.call(GRPC_METHODS.idb.hid, events())) continue;
      } catch (error) {
        if (this.#stream === stream) this.#ended(error);
      } finally {
        if (this.#stream === stream) {
          this.#open = false;
          this.#queue = [];
        }
      }
    })();
  }

  #ended(error: unknown): void {
    const since = performance.now() - TOUCHES_REPLAYED_MS;
    const replayed = this.#recentTouches.filter((touch) => touch.at >= since);
    this.#log(`input: idb_companion ended the HID stream (${error instanceof Error ? error.message : String(error)})${replayed.length ? `; ${replayed.length} touch events of the last ${TOUCHES_REPLAYED_MS} ms go again on a new stream` : "; the next input opens another"}`);
    this.#open = false;
    this.#queue = [];
    if (!replayed.length) return;
    this.ensure();
    this.#queue.push(...replayed.map((touch) => touch.event));
    this.#wake?.();
    this.#wake = null;
  }

  send(event: ProtoMessage): void {
    this.ensure();
    const encoded = encode(IDB_SCHEMA, "idb.HIDEvent", event);
    if ((event.press as { action?: { touch?: unknown } } | undefined)?.action?.touch) {
      const now = performance.now();
      this.#recentTouches = [...this.#recentTouches.filter((touch) => touch.at >= now - TOUCHES_REPLAYED_MS), { event: encoded, at: now }];
    }
    this.#queue.push(encoded);
    this.#wake?.();
    this.#wake = null;
  }

  close(): void {
    this.#stream++;
    this.#open = false;
    this.#queue = [];
    this.#recentTouches = [];
    this.#wake?.();
    this.#wake = null;
  }
}

function run(program: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(program, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(String(stdout)))),
  );
}

export interface PasteboardAccessOptions {
  readonly udid: () => string | null;
  readonly log: (line: string) => void;
  readonly devicesDir?: string;
  readonly processes?: () => Promise<readonly string[]>;
  readonly bundleId?: (app: string) => Promise<string | null>;
  readonly sql?: (database: string, statement: string) => Promise<string>;
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function runningApps(commands: readonly string[], deviceData: string): readonly string[] {
  const apps = new Set<string>();
  for (const command of commands) {
    const own = command.startsWith(`${deviceData}/Containers/Bundle/Application/`) || command.includes("/RuntimeRoot/Applications/");
    const app = /^(.*?\.app)\//.exec(command)?.[1];
    if (own && app) apps.add(app);
  }
  return [...apps];
}

export class PasteboardAccess {
  readonly #options: PasteboardAccessOptions;
  readonly #ids = new Map<string, string | null>();
  #before: Map<string, number | null> | null = null;
  #putBack: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PasteboardAccessOptions) {
    this.#options = options;
  }

  #deviceData(udid: string): string {
    return join(this.#options.devicesDir ?? join(homedir(), "Library/Developer/CoreSimulator/Devices"), udid, "data");
  }

  #sql(database: string, statement: string): Promise<string> {
    return this.#options.sql ? this.#options.sql(database, statement) : run("/usr/bin/sqlite3", ["-cmd", ".timeout 2000", database, statement]);
  }

  async #bundleId(app: string): Promise<string | null> {
    if (this.#ids.has(app)) return this.#ids.get(app)!;
    const id = this.#options.bundleId
      ? await this.#options.bundleId(app)
      : await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]).then((out) => out.trim() || null, () => null);
    this.#ids.set(app, id);
    return id;
  }

  async #processes(): Promise<readonly string[]> {
    if (this.#options.processes) return this.#options.processes();
    return (await run("/bin/ps", ["-x", "-o", "command="])).split("\n");
  }

  async allow(): Promise<readonly string[]> {
    const udid = this.#options.udid();
    if (!udid) return [];
    const data = this.#deviceData(udid);
    const database = join(data, "Library/TCC/TCC.db");
    const ids = (await Promise.all(runningApps(await this.#processes(), data).map((app) => this.#bundleId(app)))).filter((id): id is string => !!id);
    if (!ids.length) return [];
    if (!this.#before) {
      const rows = await this.#sql(database, `select client || '|' || auth_value from access where service = ${sqlText(PASTEBOARD_SERVICE)} and client_type = 0;`);
      const known = new Map(rows.split("\n").filter(Boolean).map((row) => [row.slice(0, row.lastIndexOf("|")), Number(row.slice(row.lastIndexOf("|") + 1))] as const));
      this.#before = new Map(ids.map((id) => [id, known.get(id) ?? null]));
    } else {
      for (const id of ids) if (!this.#before.has(id)) this.#before.set(id, null);
    }
    const rows = ids.map((id) => `(${sqlText(PASTEBOARD_SERVICE)}, ${sqlText(id)}, 0, ${ALLOWED}, 4, 1, 0)`).join(", ");
    await this.#sql(
      database,
      `insert into access (service, client, client_type, auth_value, auth_reason, auth_version, flags) values ${rows} on conflict (service, client, client_type, indirect_object_identifier) do update set auth_value = ${ALLOWED};`,
    );
    if (this.#putBack) clearTimeout(this.#putBack);
    this.#putBack = setTimeout(() => void this.putBack().catch((error) => this.#options.log(`paste: the apps' paste setting was not put back: ${error instanceof Error ? error.message : String(error)}`)), PASTE_ACCESS_KEPT_MS);
    this.#putBack.unref?.();
    return ids;
  }

  async putBack(): Promise<void> {
    if (this.#putBack) clearTimeout(this.#putBack);
    this.#putBack = null;
    const before = this.#before;
    this.#before = null;
    const udid = this.#options.udid();
    if (!before || !udid) return;
    const database = join(this.#deviceData(udid), "Library/TCC/TCC.db");
    const statements = [...before].map(([id, value]) =>
      value === null
        ? `delete from access where service = ${sqlText(PASTEBOARD_SERVICE)} and client = ${sqlText(id)} and client_type = 0;`
        : `update access set auth_value = ${value} where service = ${sqlText(PASTEBOARD_SERVICE)} and client = ${sqlText(id)} and client_type = 0;`,
    );
    await this.#sql(database, statements.join(" "));
  }
}

type Pair = { readonly start: readonly [TouchContact, TouchContact]; last: readonly [TouchContact, TouchContact]; readonly began: number };

export interface IosInputOptions {
  readonly client: () => GrpcClient;
  readonly scale: () => number;
  readonly access: PasteboardAccess;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export class IosInput {
  readonly #options: IosInputOptions;
  readonly #hid: HidStream;
  #single: { readonly x: number; readonly y: number } | null = null;
  #pair: Pair | null = null;
  #waitingForLift = false;
  readonly #modifiers = new Set<string>();
  readonly #implicitShift = new Set<string>();
  #noticeUntil = 0;

  constructor(options: IosInputOptions) {
    this.#options = options;
    this.#hid = new HidStream(options.client, options.log);
  }

  #now(): number {
    return this.#options.now?.() ?? performance.now();
  }

  prepare(): void {
    this.#hid.ensure();
  }

  close(): void {
    this.#hid.close();
    this.#single = null;
    this.#pair = null;
    this.#modifiers.clear();
    this.#implicitShift.clear();
  }

  #point(contact: { readonly x: number; readonly y: number }): { x: number; y: number } {
    const scale = this.#options.scale();
    return { x: contact.x / scale, y: contact.y / scale };
  }

  #press(action: ProtoMessage, direction: number): void {
    this.#hid.send({ press: { action, direction } });
  }

  button(button: keyof typeof HID_BUTTONS): void {
    this.#press({ button: { button: HID_BUTTONS[button] } }, DOWN);
    this.#press({ button: { button: HID_BUTTONS[button] } }, UP);
  }

  touch(contacts: readonly TouchContact[]): void {
    if (!contacts.length) {
      if (this.#pair) this.#pinchFromPair(this.#pair);
      else if (this.#single) this.#press({ touch: { point: this.#single } }, UP);
      this.#single = null;
      this.#pair = null;
      this.#waitingForLift = false;
      return;
    }
    if (this.#waitingForLift) return;
    if (contacts.length >= 2) {
      const two: readonly [TouchContact, TouchContact] = [contacts[0]!, contacts[1]!];
      if (this.#single) {
        this.#press({ touch: { point: this.#single } }, UP);
        this.#single = null;
      }
      if (this.#pair) this.#pair.last = two;
      else this.#pair = { start: two, last: two, began: this.#now() };
      return;
    }
    if (this.#pair) {
      this.#pinchFromPair(this.#pair);
      this.#pair = null;
      this.#waitingForLift = true;
      return;
    }
    const point = this.#point(contacts[0]!);
    this.#single = point;
    this.#press({ touch: { point } }, DOWN);
  }

  #pinchFromPair(pair: Pair): void {
    const span = (two: readonly [TouchContact, TouchContact]) => {
      const a = this.#point(two[0]);
      const b = this.#point(two[1]);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const from = span(pair.start);
    const to = span(pair.last);
    if (from < PINCH_SPAN_LEAST_POINTS || Math.abs(to / from - 1) < PINCH_SCALE_UNCHANGED) return;
    const centre = this.#point({ x: (pair.start[0].x + pair.start[1].x) / 2, y: (pair.start[0].y + pair.start[1].y) / 2 });
    const ms = Math.max(PINCH_MS.least, Math.min(PINCH_MS.most, this.#now() - pair.began));
    this.#hid.send({ pinch: { center: centre, scale: to / from, duration: ms / 1000, radius: from / 2 } });
  }

  async pinch(gesture: PinchGesture, signal: AbortSignal): Promise<void> {
    const scale = this.#options.scale();
    if (gesture.from <= 0 || gesture.to <= 0) throw new DriverError("failed", "A pinch needs a span above zero at its start and its end.");
    this.#hid.send({ pinch: { center: this.#point(gesture.centre), scale: gesture.to / gesture.from, duration: gesture.ms / 1000, radius: gesture.from / scale / 2 } });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, gesture.ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async #afterNotice(): Promise<void> {
    const left = this.#noticeUntil - this.#now();
    if (left > 0) await wait(left);
  }

  async #strokeWithOption(stroke: OptionStroke, down: boolean): Promise<void> {
    if (!down) {
      if (stroke.then) await this.key(stroke.then, false);
      return;
    }
    await this.#afterNotice();
    const option = HID_USAGES.AltLeft!;
    this.#press({ key: { keycode: option } }, DOWN);
    await this.key(stroke.option, true);
    await this.key(stroke.option, false);
    this.#press({ key: { keycode: option } }, UP);
    if (stroke.then) await this.key(stroke.then, true);
  }

  async key(key: string, down: boolean): Promise<void> {
    const stroke = OPTION_STROKES.get(key);
    if (stroke) return this.#strokeWithOption(stroke, down);
    const hid = hidKey(key);
    if (!hid) throw new DriverError("unsupported", `iOS has no key named ${JSON.stringify(key)}. Keys take W3C names, such as a, A, Enter, Backspace, ArrowLeft or Meta.`);
    const modifier = key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";
    if (down) {
      await this.#afterNotice();
      if (modifier) this.#modifiers.add(key);
      if (!modifier && this.#modifiers.has("Meta") && hid.usage === HID_USAGES.KeyV) {
        await this.#allowPaste();
        this.#noticeUntil = this.#now() + PASTE_NOTICE_MS;
      }
      if (hid.shift && !this.#modifiers.has("Shift")) {
        this.#implicitShift.add(key);
        this.#press({ key: { keycode: HID_USAGES.ShiftLeft! } }, DOWN);
      }
      this.#press({ key: { keycode: hid.usage } }, DOWN);
      return;
    }
    if (modifier) this.#modifiers.delete(key);
    this.#press({ key: { keycode: hid.usage } }, UP);
    if (this.#implicitShift.delete(key)) this.#press({ key: { keycode: HID_USAGES.ShiftLeft! } }, UP);
  }

  async #allowPaste(): Promise<void> {
    try {
      const ids = await this.#options.access.allow();
      if (!ids.length) this.#options.log("paste: no app of the device's was found running, so its paste may need the person's answer");
    } catch (error) {
      this.#options.log(`paste: could not let the running apps paste from outside: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async paste(): Promise<void> {
    await this.#afterNotice();
    await this.#allowPaste();
    const meta = HID_USAGES.MetaLeft!;
    const v = HID_USAGES.KeyV!;
    const held = this.#modifiers.has("Meta");
    if (!held) this.#press({ key: { keycode: meta } }, DOWN);
    await wait(CHORD_GAP_MS);
    this.#press({ key: { keycode: v } }, DOWN);
    await wait(CHORD_GAP_MS);
    this.#press({ key: { keycode: v } }, UP);
    await wait(CHORD_GAP_MS);
    if (!held) this.#press({ key: { keycode: meta } }, UP);
    this.#noticeUntil = this.#now() + PASTE_NOTICE_MS;
  }
}
