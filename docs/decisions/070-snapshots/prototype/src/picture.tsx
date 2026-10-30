import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import type { FakeBox, FakeSnap, Screen } from "./data";
import { when } from "./words";

function random(seed: number): () => number {
  let state = seed * 9301 + 49297;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

function Lines({ x, y, width, count, next, tone }: { x: number; y: number; width: number; count: number; next: () => number; tone: string }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <rect key={index} x={x} y={y + index * 9} width={width * (0.35 + next() * 0.6)} height={3.5} rx={1.5} fill={tone} />
      ))}
    </>
  );
}

function LinuxScreen({ seed }: { seed: number }) {
  const next = random(seed);
  const hue = Math.round(next() * 360);
  const left = 18 + next() * 70;
  const top = 26 + next() * 22;
  const terminal = next() > 0.45;
  return (
    <svg viewBox="0 0 320 200" className="size-full" aria-hidden>
      <defs>
        <linearGradient id={`wall-${seed}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 32% 30%)`} />
          <stop offset="1" stopColor={`hsl(${(hue + 50) % 360} 30% 16%)`} />
        </linearGradient>
      </defs>
      <rect width="320" height="200" fill={`url(#wall-${seed})`} />
      <rect width="320" height="12" fill="#1c1c1f" />
      <rect x={left} y={top} width="196" height="132" rx="4" fill="#f4f4f5" />
      <rect x={left} y={top} width="196" height="16" rx="4" fill="#d4d4d8" />
      <rect x={left + 30} y={top + 4} width="120" height="8" rx="4" fill="#fafafa" />
      <rect x={left + 12} y={top + 26} width="70" height="9" rx="2" fill={`hsl(${hue} 55% 45%)`} />
      <Lines x={left + 12} y={top + 44} width={170} count={6} next={next} tone="#a1a1aa" />
      <rect x={left + 12} y={top + 104} width="54" height="14" rx="3" fill={`hsl(${hue} 55% 45%)`} />
      {terminal ? (
        <g>
          <rect x={left + 128} y={top + 64} width="150" height="96" rx="4" fill="#0b0b0d" stroke="#3f3f46" />
          <Lines x={left + 138} y={top + 78} width={120} count={8} next={next} tone="#4ade80" />
        </g>
      ) : null}
    </svg>
  );
}

function MacScreen({ seed }: { seed: number }) {
  const next = random(seed);
  const hue = 200 + Math.round(next() * 80);
  return (
    <svg viewBox="0 0 320 200" className="size-full" aria-hidden>
      <rect width="320" height="200" fill={`hsl(${hue} 45% 42%)`} />
      <circle cx="250" cy="150" r="110" fill={`hsl(${hue + 30} 50% 55%)`} opacity="0.55" />
      <rect width="320" height="10" fill="#e4e4e7" opacity="0.9" />
      <rect x="34" y="28" width="220" height="140" rx="6" fill="#fafafa" />
      <rect x="34" y="28" width="62" height="140" rx="6" fill="#e4e4e7" />
      <circle cx="44" cy="37" r="2.6" fill="#f87171" />
      <circle cx="52" cy="37" r="2.6" fill="#fbbf24" />
      <circle cx="60" cy="37" r="2.6" fill="#4ade80" />
      <Lines x={42} y={52} width={46} count={10} next={next} tone="#a1a1aa" />
      <rect x="106" y="46" width={80 + next() * 60} height="9" rx="2" fill="#3f3f46" />
      <Lines x={106} y={66} width={140} count={9} next={next} tone="#a1a1aa" />
      <rect x="86" y="182" width="148" height="14" rx="5" fill="#f4f4f5" opacity="0.7" />
    </svg>
  );
}

function PhoneScreen({ seed }: { seed: number }) {
  const next = random(seed);
  const hue = Math.round(next() * 360);
  return (
    <svg viewBox="0 0 320 200" className="size-full" aria-hidden>
      <rect width="320" height="200" fill="#27272a" />
      <rect x="128" y="6" width="64" height="188" rx="9" fill="#fafafa" />
      <rect x="150" y="10" width="20" height="4" rx="2" fill="#18181b" />
      <rect x="134" y="22" width="52" height="30" rx="4" fill={`hsl(${hue} 60% 50%)`} />
      <Lines x={134} y={60} width={52} count={8} next={next} tone="#a1a1aa" />
      <rect x="134" y="150" width="52" height="12" rx="6" fill={`hsl(${hue} 60% 45%)`} />
      <rect x="146" y="184" width="28" height="3" rx="1.5" fill="#18181b" />
    </svg>
  );
}

export function ScreenPicture({ screen, seed }: { screen: Screen; seed: number }) {
  if (screen === "macos") return <MacScreen seed={seed} />;
  if (screen === "phone") return <PhoneScreen seed={seed} />;
  return <LinuxScreen seed={seed} />;
}

const FRAME = "relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-recessed max-sm:h-[30px] max-sm:w-12";

export function Thumbnail({ snap, box, now }: { snap: FakeSnap; box: FakeBox; now: number }) {
  const [open, setOpen] = useState(false);
  if (snap.picture === null || box.screen === "none") {
    return (
      <span className={cn(FRAME, "text-subtle-foreground")} aria-hidden>
        <BoxGlyph className="size-4" />
      </span>
    );
  }
  const label = `${box.name}'s screen at ${when(snap.takenAt, now)}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Show ${label}`} className={cn(FRAME, "cursor-zoom-in focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}>
          <ScreenPicture screen={box.screen} seed={snap.picture} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <figure className="space-y-1.5">
          <div role="img" aria-label={label} className="h-[200px] w-[320px] overflow-hidden rounded-md border border-border">
            <ScreenPicture screen={box.screen} seed={snap.picture} />
          </div>
          <figcaption className="px-0.5 text-xs text-muted-foreground">
            <span className="text-foreground">{snap.name}</span> · {when(snap.takenAt, now)}
          </figcaption>
        </figure>
      </PopoverContent>
    </Popover>
  );
}
