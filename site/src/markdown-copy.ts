import { markdownPath } from "./llms.ts";
import { readPages } from "./repo.ts";

let idsWithCopies: Set<string> | undefined;

export function markdownCopyOf(base: string, id: string): string | undefined {
  idsWithCopies ??= new Set(readPages().map((page) => page.id));
  return idsWithCopies.has(id) ? markdownPath(base, id) : undefined;
}
