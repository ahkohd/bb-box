import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { glyphTone, type GlyphTone } from "./file-kind.ts";

const TONE_CLASS: Readonly<Record<GlyphTone, string>> = {
  code: "text-foreground",
  config: "text-warning-text",
  markup: "text-destructive-text",
  style: "text-foreground",
  doc: "text-success",
  media: "text-subtle-foreground",
  plain: "text-muted-foreground",
};

export function FileGlyph({
  path,
  kind,
  isExpanded,
  className,
}: {
  path: string;
  kind: "file" | "directory";
  isExpanded?: boolean;
  className?: string;
}) {
  if (kind === "directory") {
    return (
      <Icon
        name={isExpanded === true ? "FolderOpen" : "Folder"}
        aria-hidden
        className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      />
    );
  }
  return (
    <Icon
      name="File"
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE_CLASS[glyphTone(path)], className)}
    />
  );
}
