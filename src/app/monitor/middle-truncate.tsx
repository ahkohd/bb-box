import { cn } from "@/lib/utils";
import { middleParts } from "./middle.ts";

export function MiddleTruncate({ text, className, reveal = false }: { text: string; className?: string; reveal?: boolean }) {
  const { head, tail } = middleParts(text);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full whitespace-pre", className)} data-reveal={reveal ? "" : undefined}>
      <span className="min-w-0 truncate">{head}</span>
      {tail ? <span className="shrink-0">{tail}</span> : null}
    </span>
  );
}
