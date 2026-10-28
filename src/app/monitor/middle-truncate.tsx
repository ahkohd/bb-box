import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { fitMiddle } from "./middle.ts";

function useFittedText(text: string) {
  const frame = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState(text);
  useLayoutEffect(() => {
    const box = frame.current;
    const measure = ruler.current;
    if (!box || !measure) return;
    const fit = () => {
      const room = box.getBoundingClientRect().width;
      if (room <= 0) {
        setFitted(text);
        return;
      }
      const shown = fitMiddle(text, (candidate) => {
        measure.textContent = candidate;
        return measure.getBoundingClientRect().width <= room + 0.5;
      });
      measure.textContent = "";
      setFitted(shown);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);
  return { frame, ruler, fitted };
}

export function MiddleTruncate({ text, className, reveal = false }: { text: string; className?: string; reveal?: boolean }) {
  const { frame, ruler, fitted } = useFittedText(text);
  return (
    <span ref={frame} data-middle-truncate="" className={cn("relative inline-flex min-w-0 max-w-full flex-col", className)} data-reveal={reveal ? "" : undefined}>
      <span className="h-0 overflow-hidden whitespace-pre">{text}</span>
      <span aria-hidden="true" className="overflow-hidden whitespace-pre">{fitted}</span>
      <span ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre" />
    </span>
  );
}
