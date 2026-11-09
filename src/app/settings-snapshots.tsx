import type { ReactNode } from "react";
import { SNAPSHOT_LIMITS, snapshotConfig, type BackendConfig } from "../core/document.ts";
import { moneyWords } from "../core/snapshot-cost.ts";
import { UNDOS_PER_BOX, priceWords, roomThresholds } from "../core/snapshot.ts";
import type { BackendState, ConfigState } from "../plugin/configuration.ts";
import { useSettings } from "./settings-context.tsx";
import { DraftNumberRow, unplacedProblems } from "./settings-draft-fields.tsx";
import { SNAPSHOTS_PART } from "./settings-drafts.ts";
import { BackendChips, Card, Chevron, Group, ProviderGlyph, RowButton, Rows } from "./settings-parts.tsx";
import { ceilingPath, snapshotPath } from "./settings-paths.ts";
import { RestoredNote, SaveBar, useDraft, type Draft } from "./settings-saving.tsx";
import { backendLabel, kindName } from "./settings-status.ts";
import { PRODUCT } from "./product.ts";

const SNAPSHOTS_CHECK = ".snapshots";
export const AGENTS_RESTORE_LABEL = "Agents may restore their own boxes";
export const AGENTS_MEMORY_LABEL = "Agents may restore memory snapshots";

export function paidBackends(state: ConfigState): { readonly config: BackendConfig; readonly live: BackendState }[] {
  return state.document.backends.flatMap((config) => {
    const live = state.backends.find((backend) => backend.id === config.id);
    return live?.snapshots?.paid ? [{ config, live }] : [];
  });
}

export function snapshotsSummary(state: ConfigState): string {
  const config = snapshotConfig(state.document);
  return [`${config.perBox} per box`, `kept ${config.keepDays} ${config.keepDays === 1 ? "day" : "days"}`, `none taken past ${config.roomPercent}% full`, ...paidWords(state)].join(" · ");
}

function paidWords(state: ConfigState): string[] {
  const paid = paidBackends(state).map(({ live }) => live.snapshots!.paid!);
  if (!paid.length) return [];
  if (paid.some((each) => each.past)) return ["past a paid ceiling"];
  return [paid.length === 1 ? `paid up to ${moneyWords(paid[0]!.ceiling, paid[0]!.currency)} a month` : `paid ceilings on ${paid.length} backends`];
}

export function snapshotsPast(state: ConfigState): boolean {
  return paidBackends(state).some(({ live }) => live.snapshots!.paid!.past);
}

function typedRoom(draft: Draft, path: string, stored: number): number {
  const typed = Number(draft.text(path).trim());
  return Number.isInteger(typed) && typed >= SNAPSHOT_LIMITS.roomPercent.least && typed <= SNAPSHOT_LIMITS.roomPercent.most ? typed : stored;
}

function roomWords(roomPercent: number): string {
  const past = roomThresholds(roomPercent);
  return `Snapshots on thin storage grow as a box changes, and a full pool stops every box on it. A new snapshot is refused past this, or past ${past.metadata}% of a thin pool's metadata. Past ${past.sweep}%, ${PRODUCT} deletes agents' snapshots on that storage that nobody kept, oldest first. ${SNAPSHOT_LIMITS.roomPercent.least} to ${SNAPSHOT_LIMITS.roomPercent.most}.`;
}

function count(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function billedSentence(included: { readonly included: number; readonly used: number }, monthly: string): string {
  const over = Math.max(0, included.used - included.included);
  const holds = `The account holds ${count(included.used, "saved snapshot")} and the plan includes ${included.included}`;
  return over ? `${holds}, so ${over} ${over === 1 ? "is" : "are"} billed: about ${monthly} a month.` : `${holds}, so none are billed.`;
}

function PaidRow({ draft, state, config, live }: { draft: Draft; state: ConfigState; config: BackendConfig; live: BackendState }) {
  const view = live.snapshots!;
  const paid = view.paid!;
  const money = (amount: number) => moneyWords(amount, paid.currency);
  const unknown = paid.unknown ? ` ${count(paid.unknown, "snapshot")} at a price ${PRODUCT} does not know, left out.` : "";
  const description: ReactNode = (
    <>
      {view.price ? `${view.price.known ? `${priceWords(view.price)} for each snapshot.` : `${PRODUCT} does not know its price, so only you take snapshots there.`} ` : ""}
      {paid.billing ? (
        <span data-bill-slot className="block min-h-[3lh]">
          {paid.billing === "billed" && paid.included
            ? billedSentence(paid.included, money(paid.monthly))
            : `${PRODUCT} could not read what ${backendLabel(state, config)} bills just now, so it counts each of the ${count(paid.count, "saved snapshot")} it knows of at full price: about ${money(paid.monthly)} a month, an estimate.`}
        </span>
      ) : (
        <>
          Held now: {count(paid.count, "snapshot")}, about {money(paid.monthly)} a month.{unknown} Spent this month so far, deleted ones included: {money(paid.spent)}.
        </>
      )}
      {paid.past ? <span className="mt-1 block text-warning-text">The rate held is past this ceiling: {PRODUCT} refuses new paid snapshots, undos, Keep and renewals there until you raise it or delete some. It deletes none by itself.</span> : null}
    </>
  );
  return <DraftNumberRow draft={draft} path={ceilingPath(config.id)} label={backendLabel(state, config)} description={description} unit={`${paid.currency === "EUR" ? "EUR" : "$"} a month`} unitWord={`${paid.currency === "EUR" ? "euros" : "dollars"} a month`} decimal />;
}

function offerLines(state: ConfigState, live: BackendState | undefined): string[] {
  if (!live || live.state !== "active") return ["Off, so it takes no snapshots now."];
  const offers = live.snapshots?.offers ?? [];
  if (!offers.length) return ["Takes no snapshots."];
  const named = (id: string) => {
    const info = state.kinds.find((kind) => kind.id === id);
    return info ? kindName(state.kinds, info) : id;
  };
  const words = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return offers.length === 1 && offers[0]!.kinds.length === live.kinds.length ? [words(offers[0]!.words)] : offers.map((offer) => `${offer.kinds.map(named).join(", ")}: ${offer.words}`);
}

function OfferRow({ state, config }: { state: ConfigState; config: BackendConfig }) {
  const { nav } = useSettings();
  const live = state.backends.find((backend) => backend.id === config.id);
  const check = live?.state === "active" ? live.doctor?.report.checks.find((each) => each.id.endsWith(SNAPSHOTS_CHECK)) : undefined;
  const warn = check !== undefined && check.status !== "ok";
  const title = backendLabel(state, config);
  const valueId = `settings-snapshot-offer-${config.id}`;
  const chipsId = `settings-snapshot-offer-chips-${config.id}`;
  return (
    <div className="relative flex items-start gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-state-hover">
      <RowButton rowKey={`snapshot-offer-${config.id}`} label={title} describedBy={`${chipsId} ${valueId}`} onClick={() => nav.go({ page: "backend", id: config.id }, `snapshot-offer-${config.id}`)} />
      <span className="pointer-events-none mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <ProviderGlyph type={config.type} />
      </span>
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
          <span className="min-w-0 truncate" aria-hidden>
            {title}
          </span>
          <span id={chipsId} className="flex items-center gap-1.5 empty:hidden">
            <BackendChips state={state} config={config} />
          </span>
        </span>
        <span id={valueId} className="mt-0.5 block space-y-0.5 text-xs leading-snug text-muted-foreground">
          {offerLines(state, live).map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
          {check ? <span className="block">{check.detail}</span> : null}
          {warn && check.fix ? <span className="block text-warning-text">Fix: {check.fix}</span> : null}
        </span>
      </span>
      <span className="pointer-events-none mt-0.5">
        <Chevron />
      </span>
    </div>
  );
}

export function SnapshotsOptions({ agents, pictures }: { agents: ReactNode; pictures: ReactNode }) {
  const { state } = useSettings();
  const draft = useDraft(SNAPSHOTS_PART, "the snapshot settings");
  const stored = snapshotConfig(state.document);
  const paid = paidBackends(state);
  const roomPath = snapshotPath("roomPercent");
  const placed = [snapshotPath("perBox"), roomPath, snapshotPath("keepDays"), ...paid.map(({ config }) => ceilingPath(config.id))];
  return (
    <div className="space-y-6">
      <RestoredNote draft={draft} />
      <Group title="Each box">
        <Card>
          <Rows>
            <DraftNumberRow
              draft={draft}
              path={snapshotPath("perBox")}
              label="Snapshots per box"
              unit="a box"
              unitWord="snapshots a box"
              description={`Kept ones count. Undos are counted apart: each box has room for ${UNDOS_PER_BOX} besides. Past this, a new snapshot is refused, with what to delete. ${SNAPSHOT_LIMITS.perBox.least} to ${SNAPSHOT_LIMITS.perBox.most}.`}
            />
            <DraftNumberRow draft={draft} path={roomPath} label="Refuse new snapshots when a host's storage is past" unit="% full" unitWord="percent full" description={roomWords(typedRoom(draft, roomPath, stored.roomPercent))} />
          </Rows>
        </Card>
      </Group>
      <Group title="Keep">
        <Card>
          <Rows>
            <DraftNumberRow
              draft={draft}
              path={snapshotPath("keepDays")}
              label="Keep keeps a snapshot for"
              unit="days"
              unitWord="days"
              description={`From the day you keep it, unless you choose a date. A kept snapshot is yours, outlives its box's release, and ${PRODUCT} deletes it after its date. Only you keep one. Keeping it again adds these days to its date. ${SNAPSHOT_LIMITS.keepDays.least} to ${SNAPSHOT_LIMITS.keepDays.most}.`}
            />
          </Rows>
        </Card>
      </Group>
      <Group title="Agents" description="Switches save at once. However they are set, an agent's restore always takes an undo first.">
        <Card>
          <Rows>{agents}</Rows>
        </Card>
      </Group>
      <Group title="Pictures">
        <Card>
          <Rows>{pictures}</Rows>
        </Card>
      </Group>
      <Group
        title="Paid snapshots"
        description={`A ceiling on the monthly rate of what is held, for each provider and account, 5 a month unless you set it: every paid snapshot held, kept or not, times its daily price, times 30; where a provider's plan includes some, as boat.dev's does, only those past them, as it bills. A take, an undo, a Keep or a renewal that would pass it is refused. It is not a cap on the bill, and ${PRODUCT} never deletes snapshots to get under it.`}
      >
        <Card>
          {paid.length ? (
            <Rows>
              {paid.map(({ config, live }) => (
                <PaidRow key={config.id} draft={draft} state={state} config={config} live={live} />
              ))}
            </Rows>
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">None of your backends charges for snapshots.</p>
          )}
        </Card>
      </Group>
      <Group title="What each backend offers" description="What its snapshots hold and cost, and what its last check found of its storage. Each opens the backend's page.">
        <Card>
          {state.document.backends.length ? (
            <Rows>
              {state.document.backends.map((config) => (
                <OfferRow key={config.id} state={state} config={config} />
              ))}
            </Rows>
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">No backends yet.</p>
          )}
        </Card>
      </Group>
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, placed)} />
    </div>
  );
}
