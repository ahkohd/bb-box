import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { GpuPart } from "../backends/types.ts";
import { kindGpuDefaults, WHOLE_CARDS_FIELD, wholeCardsAnywhere } from "../core/document.ts";
import { gpuWhenNotAsked, isGpuPart } from "../core/gpu.ts";
import type { Contract } from "../plugin/contract.ts";
import type { FieldView } from "../plugin/configuration.ts";
import type { SettingsCard, SettingsCardHolder, SettingsCards } from "../plugin/gpu-settings.ts";
import { capitalised, cardName, gib, GPU_CHOICE_LABELS, kindGpuChoices, kindGpuWords, limitAfterSave, loweredLimitWords, readAgo, wholeCardsNow, wholeKeptWords } from "./gpu-settings-words.ts";
import { MenuSelect } from "./box-form.tsx";
import { boxPage } from "./box-route.ts";
import { useBoxesNav } from "./box-nav.tsx";
import { BackendFieldRow, GROUP_WORDS, type BackendForm } from "./settings-backend-fields.tsx";
import { REPOSITORY_URL } from "./settings-backends.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { Card, Group, RowControl, RowNote, Rows, SavedTick } from "./settings-parts.tsx";
import { backendFieldPath, kindPath } from "./settings-paths.ts";

export const BOXES_PER_CARD_FIELD = "boxes-per-card";

const CARDS_FAILED: SettingsCards = { is: "unread", host: null, why: "BB Box could not ask for the cards.", setup: null };

function useCards(backend: string, revision: number): SettingsCards | null {
  const rpc = useRpc<Contract>();
  const [cards, setCards] = useState<SettingsCards | null>(null);
  useEffect(() => {
    let live = true;
    rpc
      .call("config.cards", { backend })
      .then((read) => live && setCards(read))
      .catch(() => live && setCards(CARDS_FAILED));
    return () => {
      live = false;
    };
  }, [backend, revision]);
  return cards;
}

function WholeCardsRow({ form, field, kept }: { form: BackendForm; field: FieldView; kept: readonly { readonly name: string }[] }) {
  const { state, instant, writes } = useSettings();
  const id = useId();
  const key = switchKey.backendField(form.config.id, WHOLE_CARDS_FIELD);
  const now = wholeCardsNow(state.document, form.config, instant.pendingValue<boolean>(key) ?? null);
  const words = now.on ? "Lets a box have a card to itself." : `Off: no box is given a whole card or changes to one.${wholeKeptWords(kept)}`;
  return (
    <div className="px-4 py-3" data-setting-row={backendFieldPath(form.config.id, WHOLE_CARDS_FIELD)}>
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-switch`} className="text-sm text-foreground">
            {field.label}
          </label>
          <p id={`${id}-words`} className="mt-0.5 text-xs leading-snug text-subtle-foreground">
            {words}
            {now.fromInstall ? " From the install-wide option, general.wholeCards, as this backend's own is not set." : ""}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <SavedTick show={instant.isSaved(key)} />
          <RowControl>
            <Switch
              id={`${id}-switch`}
              data-draft-path={backendFieldPath(form.config.id, WHOLE_CARDS_FIELD)}
              aria-describedby={`${id}-words`}
              checked={now.on}
              aria-disabled={instant.pending !== null || undefined}
              onCheckedChange={(on) => void instant.run(writes.backendField(form.state, form.config, WHOLE_CARDS_FIELD, on, `Whole cards on ${form.driver.label}`))}
            />
          </RowControl>
        </span>
      </div>
      <RowNote note={instant.note(key)} className="pt-1" />
    </div>
  );
}

function HolderChip({ holder }: { holder: SettingsCardHolder }) {
  const nav = useBoxesNav();
  const state = holder.part === "whole" ? "whole" : holder.running ? "shared" : "stopped";
  const className = "inline-flex h-6 items-center rounded-full border border-border bg-background px-2 text-xs font-normal text-foreground";
  if (!holder.box) {
    return (
      <span className={className}>
        {holder.name}
        <span className="pl-1 text-muted-foreground">{state}</span>
      </span>
    );
  }
  const route = boxPage(holder.box, ["from-settings"]);
  return (
    <a href={nav.href(route)} onClick={nav.onLink(route)} className={cn(className, "cursor-pointer hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}>
      {holder.name}
      <span className="pl-1 text-muted-foreground">{state}</span>
    </a>
  );
}

function CardRow({ card }: { card: SettingsCard }) {
  const facts = [card.model, card.totalMiB !== null ? gib(card.totalMiB) : null].filter(Boolean).join(" · ");
  const free = card.freeMiB === null ? "free memory not read" : `${gib(card.freeMiB)} free when read`;
  const boxes = card.holders.length ? `${card.holders.length} ${card.holders.length === 1 ? "holder" : "holders"}` : "no box";
  return (
    <div className="px-4 py-2.5" data-card={card.uuid}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
        {capitalised(cardName(card.index))}
        {facts ? <span className="text-xs text-muted-foreground">{facts}</span> : null}
        <span className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {boxes} · {free}
        </span>
      </div>
      <p className="mt-0.5 truncate font-mono text-2xs text-subtle-foreground">{card.uuid}</p>
      {card.outsideMiB !== null ? <p className="mt-0.5 text-xs text-muted-foreground">{gib(card.outsideMiB)} in use outside this install's boxes.</p> : null}
      {card.overWords ? <p className="mt-0.5 text-xs text-warning-text">{card.overWords}</p> : null}
      {card.holders.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {card.holders.map((holder, index) => (
            <HolderChip key={`${holder.name}-${index}`} holder={holder} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function cardsHeading(cards: Extract<SettingsCards, { is: "read" }>, now: number): string {
  const when = cards.at ? ` ${readAgo(cards.at, now)}` : "";
  return cards.source === "helper" ? `The cards on ${cards.host}, as its GPU helper reported them${when}.` : `The cards on ${cards.host}, as Docker lists them${when}.`;
}

function CardsList({ cards }: { cards: SettingsCards | null }) {
  if (cards === null) {
    return (
      <p className="min-h-5 px-1 text-xs text-subtle-foreground" role="status">
        Reading the cards…
      </p>
    );
  }
  if (cards.is === "none") return null;
  if (cards.is === "unread") {
    return (
      <p className="min-h-5 px-1 text-xs leading-snug text-subtle-foreground" role="status">
        {cards.why}
        {cards.setup ? (
          <>
            {" "}
            <UrlLink href={`${REPOSITORY_URL}/${cards.setup}`} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {cards.setup.includes("proxmox") ? "Set up the helper" : "Set up GPU boxes"}
            </UrlLink>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="min-h-5 px-1 text-xs leading-snug text-subtle-foreground" role="status">
        {cardsHeading(cards, Date.now())}
      </p>
      {cards.cards.length ? (
        <Card>
          <Rows>
            {cards.cards.map((card) => (
              <CardRow key={card.uuid} card={card} />
            ))}
          </Rows>
        </Card>
      ) : null}
    </div>
  );
}

export function GpusGroup({ form, title, fields }: { form: BackendForm; title: string; fields: readonly FieldView[] }) {
  const cards = useCards(form.config.id, form.state.revision);
  const read = cards?.is === "read" ? cards : null;
  const limitPath = backendFieldPath(form.config.id, BOXES_PER_CARD_FIELD);
  const limitField = fields.find((field) => field.key === BOXES_PER_CARD_FIELD);
  const replaced = limitField?.replaces ? form.draft.current(backendFieldPath(form.config.id, limitField.replaces)) : null;
  const typed = form.draft.changed(limitPath) ? limitAfterSave(form.draft.current(limitPath), replaced, limitField?.default) : null;
  const lowered = read && typed !== null ? loweredLimitWords(read.cards, typed, read.limit, read.counts) : null;
  return (
    <Group title={title} description={GROUP_WORDS.gpus}>
      <Card>
        <Rows>
          {fields.map((field) =>
            field.key === WHOLE_CARDS_FIELD ? (
              <WholeCardsRow key={field.key} form={form} field={field} kept={read?.wholeKept ?? []} />
            ) : (
              <div key={field.key}>
                <BackendFieldRow form={form} field={field} />
                {field.key === BOXES_PER_CARD_FIELD && lowered ? (
                  <p role="status" className="px-4 pb-3 text-xs leading-snug text-warning-text">
                    {lowered}
                  </p>
                ) : null}
              </div>
            ),
          )}
        </Rows>
      </Card>
      <CardsList cards={cards} />
    </Group>
  );
}

export function KindGpuCard({ kind }: { kind: string }) {
  const { state, instant, writes } = useSettings();
  const id = useId();
  const key = switchKey.kindGpu(kind);
  const saved = gpuWhenNotAsked(kind, kindGpuDefaults(state.document.kinds));
  const pending = instant.pendingValue<GpuPart>(key);
  const value = pending ?? saved;
  const wholeOn = wholeCardsAnywhere(state.document);
  return (
    <Group title="GPU">
      <Card>
        <div className="px-4 py-3" data-setting-row={kindPath(kind, "gpu")}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
            <div className="min-w-0 flex-1">
              <p id={`${id}-label`} className="text-sm text-foreground">
                GPU when not asked for
              </p>
              <p id={`${id}-words`} className={cn("mt-0.5 text-xs leading-snug", value === "whole" && !wholeOn ? "text-warning-text" : "text-subtle-foreground")}>
                {kindGpuWords(kind, value, wholeOn)}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-2" data-draft-path={kindPath(kind, "gpu")}>
              <SavedTick show={instant.isSaved(key)} />
              <MenuSelect
                label="GPU when not asked for"
                value={value}
                options={kindGpuChoices(state.document, value).map((part) => ({ value: part, label: GPU_CHOICE_LABELS[part] }))}
                onChange={(next) => {
                  if (!isGpuPart(next) || next === value || instant.pending !== null) return;
                  void instant.run(writes.kindGpu(state, kind, next, `The GPU ${kind} boxes get when not asked for`));
                }}
              />
            </span>
          </div>
          <RowNote note={instant.note(key)} className="pt-1" />
        </div>
      </Card>
    </Group>
  );
}
