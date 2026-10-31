import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Badge, StatusDot } from "@/src/app/common.tsx";
import { MonitorGlyph, ServerGlyph } from "@/src/app/glyphs.tsx";
import { BACKENDS, type Card, type FakeBox } from "./data";
import { gpuBadge, sizeWords } from "./box-page";
import { go } from "./nav";
import { capital, cardName, cardsOf, freeMiB, gib, holders, overLimit, readAgo, waitingFor, type World } from "./placement";
import { useStore } from "./store";

export function cardSummary(world: World, card: Card): string {
  const on = holders(world, card);
  const whole = on.find((box) => box.gpu === "whole");
  if (whole) return `Whole: ${whole.name}'s`;
  const most = world.settings[card.backend].boxesPerCard;
  return `${on.length}${most > 0 ? ` of ${most}` : ""} ${on.length === 1 && most === 0 ? "box" : "boxes"} · ${gib(freeMiB(world, card))} free ${readAgo(card.backend)}`;
}

function BoxRow({ box, holdsNone }: { box: FakeBox; holdsNone?: boolean }) {
  const badge = gpuBadge(box);
  const tone = box.state === "stopped" ? "off" : box.state === "ready" ? "ok" : "busy";
  const status = box.state === "ready" ? "Ready" : box.state === "stopped" ? (holdsNone ? "Stopped, holds no card while stopped" : "Stopped") : (box.step ?? "Starting");
  return (
    <button type="button" onClick={() => go({ page: "box", id: box.id })} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">{box.desktop ? <MonitorGlyph /> : <ServerGlyph />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm text-foreground">
          {box.name}
          {badge ? <Badge>{badge}</Badge> : null}
        </span>
        <span className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <StatusDot tone={tone} />
          <span className="truncate">
            {status} · {sizeWords(box)}
          </span>
        </span>
      </span>
      <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
    </button>
  );
}

export function BoxesPage() {
  const store = useStore();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-subtle-foreground">A stand-in for the Boxes page, grouped by card to show which boxes hold each card.</p>
        <Button type="button" size="sm" className="h-7 shrink-0 font-normal" onClick={() => go({ page: "new" })}>
          New box
        </Button>
      </div>
      {BACKENDS.map((backend) => {
        const cards = cardsOf(store, backend.id);
        const without = store.boxes.filter((box) => box.backend === backend.id && box.card === null);
        return (
          <section key={backend.id} aria-label={`${backend.host}, ${backend.label}`} className="space-y-2.5">
            <h2 className="text-xs font-normal text-foreground">
              {backend.host} <span className="text-subtle-foreground">· {backend.label}</span>
            </h2>
            {cards.map((card) => {
              const on = holders(store, card);
              const parked = waitingFor(store, card);
              const over = overLimit(store, card);
              return (
                <div key={card.id} className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2.5 text-sm text-foreground">
                    {capital(cardName(card))}
                    <span className="text-xs text-muted-foreground">
                      {card.model} · {gib(card.memoryMiB)}
                    </span>
                    <span className="flex-1" />
                    <span className="text-xs tabular-nums text-muted-foreground">{cardSummary(store, card)}</span>
                  </div>
                  {over.length ? <p className="px-4 pb-2 text-xs text-warning-text">{over.length} over the limit of {store.settings[card.backend].boxesPerCard}: they keep running, and no new box goes on {cardName(card)} until it has room.</p> : null}
                  {on.length || parked.length ? (
                    <div className="divide-y divide-border border-t border-border">
                      {on.map((box) => (
                        <BoxRow key={box.id} box={box} />
                      ))}
                      {parked.map((box) => (
                        <BoxRow key={box.id} box={box} holdsNone />
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 pb-2.5 text-xs text-subtle-foreground">No box holds it.</p>
                  )}
                </div>
              );
            })}
            {without.length ? (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <p className="px-4 py-2.5 text-sm text-foreground">No card</p>
                <div className="divide-y divide-border border-t border-border">
                  {without.map((box) => (
                    <BoxRow key={box.id} box={box} />
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
