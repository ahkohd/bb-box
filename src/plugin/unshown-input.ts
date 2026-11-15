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
