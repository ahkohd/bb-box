import { defineCli, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { Problem } from "../core/document.ts";

const READ_FAILURES: Readonly<Record<string, string>> = {
  ENOENT: "it was not found",
  EACCES: "it is not readable",
  EPERM: "it is not readable",
  EISDIR: "it is a folder",
  ENOTDIR: "part of its path is not a folder",
};

export function readFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (code && READ_FAILURES[code]) || "it could not be read";
}

const JSON_FAULTS = {
  end: "the text ends before the JSON does",
  character: "a character JSON does not allow there",
  string: "a string that is never closed",
  escape: "an escape JSON does not allow in a string",
  control: "a line break or control character inside a string",
  number: "a number JSON cannot read",
  trailing: "more text after the JSON ends",
} as const;

type JsonFaultKind = keyof typeof JSON_FAULTS;

interface JsonStop {
  readonly stoppedAt: number;
  readonly kind: JsonFaultKind;
}

export interface JsonFault {
  readonly line: number;
  readonly column: number;
  readonly words: string;
}

const JSON_SPACE = " \t\n\r";
const JSON_ESCAPES = '"\\/bfnrt';
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/;
const UNICODE_ESCAPE = /^[0-9a-fA-F]{4}$/;
const UNICODE_ESCAPE_LENGTH = 4;
const FIRST_PRINTABLE = " ";

function isJsonStop(thrown: unknown): thrown is JsonStop {
  return typeof thrown === "object" && thrown !== null && "stoppedAt" in thrown && "kind" in thrown;
}

function firstStop(text: string): JsonStop | null {
  let at = 0;
  const stop = (kind: JsonFaultKind): never => {
    throw { stoppedAt: at, kind } satisfies JsonStop;
  };
  const ended = () => at >= text.length;
  const skipSpace = () => {
    while (!ended() && JSON_SPACE.includes(text[at]!)) at += 1;
  };
  const literal = (word: string) => {
    for (const character of word) {
      if (ended()) stop("end");
      if (text[at] !== character) stop("character");
      at += 1;
    }
  };
  const unclosedFrom = (opened: number): never => {
    at = opened;
    return stop("string");
  };
  const string = () => {
    const opened = at;
    at += 1;
    for (;;) {
      if (ended()) unclosedFrom(opened);
      const character = text[at]!;
      if (character === '"') {
        at += 1;
        return;
      }
      if (character < FIRST_PRINTABLE) stop("control");
      if (character === "\\") {
        at += 1;
        if (ended()) unclosedFrom(opened);
        const escape = text[at]!;
        if (escape === "u") {
          if (!UNICODE_ESCAPE.test(text.slice(at + 1, at + 1 + UNICODE_ESCAPE_LENGTH))) stop("escape");
          at += UNICODE_ESCAPE_LENGTH;
        } else if (!JSON_ESCAPES.includes(escape)) stop("escape");
      }
      at += 1;
    }
  };
  const number = () => {
    const match = JSON_NUMBER.exec(text.slice(at));
    if (!match) stop("number");
    at += match![0].length;
  };
  const afterItem = (close: string): boolean => {
    skipSpace();
    if (ended()) stop("end");
    if (text[at] === ",") {
      at += 1;
      return true;
    }
    if (text[at] === close) {
      at += 1;
      return false;
    }
    return stop("character");
  };
  const array = () => {
    at += 1;
    skipSpace();
    if (text[at] === "]") {
      at += 1;
      return;
    }
    do value();
    while (afterItem("]"));
  };
  const object = () => {
    at += 1;
    skipSpace();
    if (text[at] === "}") {
      at += 1;
      return;
    }
    do {
      skipSpace();
      if (ended()) stop("end");
      if (text[at] !== '"') stop("character");
      string();
      skipSpace();
      if (ended()) stop("end");
      if (text[at] !== ":") stop("character");
      at += 1;
      value();
    } while (afterItem("}"));
  };
  const value = (): void => {
    skipSpace();
    if (ended()) stop("end");
    const character = text[at]!;
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return string();
    if (character === "-" || (character >= "0" && character <= "9")) return number();
    if (character === "t") return literal("true");
    if (character === "f") return literal("false");
    if (character === "n") return literal("null");
    stop("character");
  };
  try {
    value();
    skipSpace();
    if (!ended()) stop("trailing");
    return null;
  } catch (thrown) {
    if (isJsonStop(thrown)) return thrown;
    return null;
  }
}

export function jsonFaultOf(text: string): JsonFault | null {
  const stopped = firstStop(text);
  if (!stopped) return null;
  const before = text.slice(0, stopped.stoppedAt);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: stopped.stoppedAt - lineStart + 1, words: JSON_FAULTS[stopped.kind] };
}

export function unnamedProblems(problems: readonly Problem[]): Problem[] {
  return problems.map((each) => each.unnamed ?? { path: each.path, message: each.message });
}

const QUOTED_BY_THE_SDK = ["unknown command", "unknown option", "invalid value", "unexpected argument"] as const;
const WORD_MARK = "bbboxrefusedword";

type CliSpec = Parameters<typeof defineCli>[0];
type Cli = ReturnType<typeof defineCli>;

interface Refusal {
  readonly words: (typeof QUOTED_BY_THE_SDK)[number];
  readonly quoted: string;
}

interface Variant {
  readonly token: string;
  readonly piece: string;
}

const SUGGESTION = / \(Did you mean [^()]*\?\)$/;
const INVALID_VALUE_END = "' for --";

function refusalIn(text: string): Refusal | null {
  const message = text.split("\n\n")[0]!.replace(/\n$/, "").replace(SUGGESTION, "");
  for (const words of QUOTED_BY_THE_SDK) {
    const opening = `${words} '`;
    if (!message.startsWith(opening)) continue;
    const close = words === "invalid value" ? message.lastIndexOf(INVALID_VALUE_END) : message.lastIndexOf("'");
    return { words, quoted: message.slice(opening.length, Math.max(close, opening.length)) };
  }
  return null;
}

function markOf(argv: readonly string[]): string {
  let mark = WORD_MARK;
  while (argv.some((token) => token.includes(mark))) mark = `${mark}x`;
  return mark;
}

function variantsOf(token: string, mark: string): Variant[] {
  const dashes = token.startsWith("--") ? "--" : token.startsWith("-") ? "-" : "";
  const equals = token.indexOf("=");
  const variants: Variant[] = [{ token: mark, piece: token }];
  if (dashes) {
    const name = token.slice(dashes.length, equals === -1 ? undefined : equals);
    variants.push({ token: `${dashes}${mark}${equals === -1 ? "" : token.slice(equals)}`, piece: name });
  }
  if (equals !== -1) variants.push({ token: `${token.slice(0, equals + 1)}${mark}`, piece: token.slice(equals + 1) });
  return variants;
}

function refusalWithPiece(text: string, mark: string, piece: string): Refusal | null {
  const refusal = refusalIn(text);
  if (!refusal || !refusal.quoted.includes(mark)) return null;
  return { words: refusal.words, quoted: refusal.quoted.replaceAll(mark, piece) };
}

async function refusedPositions(probe: Cli, argv: string[], ctx: PluginCliContext, refusal: Refusal): Promise<number[]> {
  const mark = markOf(argv);
  for (const [index, token] of argv.entries()) {
    for (const variant of variantsOf(token, mark)) {
      const tried = argv.map((each, at) => (at === index ? variant.token : each));
      const probed = refusalWithPiece((await probe.run(tried, ctx)).stderr ?? "", mark, variant.piece);
      if (probed && probed.words === refusal.words && probed.quoted === refusal.quoted) return [index];
    }
  }
  return argv.flatMap((token, index) => (variantsOf(token, mark).some((variant) => refusal.quoted === variant.piece || refusal.quoted.endsWith(` ${variant.piece}`)) ? [index] : []));
}

function placeWords(positions: readonly number[]): string {
  if (!positions.length) return "not shown, as it may be a secret";
  const words = positions.map((index) => String(index + 1));
  const listed = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
  return `word ${listed} after bb box, not shown, as it may be a secret`;
}

function unquoted(text: string, refusal: Refusal, positions: readonly number[]): string {
  return text.replaceAll(`${refusal.words} '${refusal.quoted}'`, `${refusal.words} (${placeWords(positions)})`);
}

function unquotedJson(stdout: string, refusal: Refusal, positions: readonly number[]): string {
  let parsed: { ok?: unknown; error?: { message?: unknown; hint?: unknown } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unquoted(stdout, refusal, positions);
  }
  if (parsed?.ok !== false || typeof parsed.error !== "object" || parsed.error === null) return stdout;
  const { message, hint } = parsed.error;
  const error = {
    ...parsed.error,
    ...(typeof message === "string" ? { message: unquoted(message, refusal, positions) } : {}),
    ...(typeof hint === "string" ? { hint: unquoted(hint, refusal, positions) } : {}),
  };
  return `${JSON.stringify({ ...parsed, error }, null, 2)}\n`;
}

function parseOnly(spec: CliSpec): CliSpec {
  const commands = Object.fromEntries(Object.entries(spec.commands).map(([path, command]) => [path, { ...command, run: () => ({ exitCode: 0 }) }]));
  return { ...spec, commands } as CliSpec;
}

export function unquotedCli(spec: CliSpec): Cli {
  const cli = defineCli(spec);
  const probe = defineCli(parseOnly(spec));
  return {
    ...cli,
    run: async (argv: string[], ctx: PluginCliContext) => {
      const result = await cli.run(argv, ctx);
      const refusal = result.exitCode === 0 ? null : refusalIn(result.stderr ?? "");
      if (!refusal) return result;
      const positions = await refusedPositions(probe, argv, ctx, refusal);
      return {
        ...result,
        ...(result.stdout === undefined ? {} : { stdout: unquotedJson(result.stdout, refusal, positions) }),
        ...(result.stderr === undefined ? {} : { stderr: unquoted(result.stderr, refusal, positions) }),
      };
    },
  };
}
