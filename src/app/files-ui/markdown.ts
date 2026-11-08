import { extensionOf } from "./file-kind.ts";

export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown"]);

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

export type FileViewMode = "preview" | "read" | "edit";

export const MARKDOWN_PREVIEW_MAX_CHARS = 1024 * 1024;

export function canPreviewMarkdown(path: string, text: string): boolean {
  return isMarkdownPath(path) && text.length <= MARKDOWN_PREVIEW_MAX_CHARS;
}

export function allowedMode(
  requested: FileViewMode,
  path: string,
  text: string | null,
): FileViewMode {
  if (requested !== "preview") return requested;
  return text !== null && canPreviewMarkdown(path, text) ? "preview" : "read";
}
