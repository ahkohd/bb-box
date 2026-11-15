import { PRODUCT } from "../brand.ts";

export interface UnnamedProblem {
  readonly path: string;
  readonly message: string;
}

export type ProblemAt = (path: string, message: string, unnamed?: UnnamedProblem) => void;

const NAME_NOT_SHOWN = "Its name is not shown, as it may be a secret.";

export function ordinal(position: number): string {
  const lastTwo = position % 100;
  const last = position % 10;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${position}${suffix}`;
}

function positionOf(keys: readonly string[], key: string): number {
  return keys.indexOf(key) + 1;
}

export function keyPath(parent: string, keys: readonly string[], key: string): string {
  const position = `#${positionOf(keys, key)}`;
  return parent ? `${parent}.${position}` : position;
}

export function unknownKey(parent: string, keys: readonly string[], key: string, known: string): UnnamedProblem {
  const where = parent || "the configuration";
  return { path: keyPath(parent, keys, key), message: `The ${ordinal(positionOf(keys, key))} key in ${where} is not one ${PRODUCT} knows here. ${NAME_NOT_SHOWN} ${known}` };
}

export const VALUE_NOT_SHOWN = "The value is not shown, as it may be a secret.";

export function unnamedValue(path: string, message: string): UnnamedProblem {
  return { path, message: `${message} ${VALUE_NOT_SHOWN}` };
}
