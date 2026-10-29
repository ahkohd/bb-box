import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { DOCKER_MACHINES, DRIVERS, NEEDS, SETUP_GROUPS, SETUP_WORDS, driverOf, type BackendConfig, type Document } from "./data";
import { candidateBackend, FieldGroups, fieldPath, GonePage, MacsSection, offable, REPOSITORY, useDraftCheck } from "./backend-page";
import { HealthCard } from "./health";
import { availableTypes, kindName } from "./model";
import { useNav } from "./nav";
import { useStore } from "./store";
import { useDraft } from "./drafts";
import { Badge, Card, Chevron, FOCUS_RING, Icon, PageHeader, ProviderGlyph, RestoredNote, Rows, SaveRule } from "./ui";

export function AddBackend() {
  const store = useStore();
  const nav = useNav();
  const [using, setUsing] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const available = new Set(availableTypes(store.doc));
  const machines = DOCKER_MACHINES.filter((machine) => !store.doc.backends.some((backend) => backend.fields.host === `bb:${machine.id}`));
  const ready = machines.filter((machine) => machine.docker && !machine.fault);
  const faulty = machines.filter((machine) => machine.docker && machine.fault);
  const without = machines.filter((machine) => !machine.docker);
  return (
    <div className="space-y-6">
      <PageHeader title="Add a backend" description="Choose where new boxes run. Each backend has its own setup guide; its form follows the guide step by step." />
      {ready.length || faulty.length ? (
        <section className="space-y-2.5" aria-label="Docker on your BB machines">
          <div>
            <h3 className="text-xs font-medium text-foreground">Docker on your BB machines</h3>
            <p className="mt-0.5 text-xs text-subtle-foreground">Ready now. A box there is a privileged container, root on the machine, so none is used until you choose it. BB Box builds its images there first.</p>
          </div>
          <Card>
            <Rows>
              {ready.map((machine) => (
                <div key={machine.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <ProviderGlyph type="docker" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{machine.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot tone="off" />
                      Can host boxes · Docker {machine.docker} · {machine.facts}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={using !== null}
                    onClick={async () => {
                      setUsing(machine.id);
                      const result = await store.useMachine(machine.id);
                      setUsing(null);
                      if (result.ok) nav.landAfterSetup({ page: "backend", id: `docker:${machine.name}` });
                    }}
                  >
                    {using === machine.id ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                    Use {machine.name}
                  </Button>
                </div>
              ))}
              {faulty.map((machine) => (
                <div key={machine.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                  <ProviderGlyph type="docker" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{machine.name}</p>
                    <p className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                      <StatusDot tone="bad" />
                      <span>
                        <span className="text-destructive-text">Cannot host boxes.</span> {machine.fault}
                      </span>
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={checking !== null}
                    onClick={() => {
                      setChecking(machine.id);
                      setTimeout(() => setChecking(null), 1200);
                    }}
                  >
                    {checking === machine.id ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                    Check again
                  </Button>
                </div>
              ))}
            </Rows>
          </Card>
          {without.length ? <p className="px-1 text-xs text-subtle-foreground">{without.map((machine) => machine.name).join(", ")} have no Docker. Install it there and they appear here.</p> : null}
        </section>
      ) : null}
      {SETUP_GROUPS.map((group) => (
        <section key={group.title} className="space-y-2.5" aria-label={group.title}>
          <div>
            <h3 className="text-xs font-medium text-foreground">{group.title}</h3>
            <p className="mt-0.5 text-xs text-subtle-foreground">{group.description}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {group.types.map((type) => {
              const driver = driverOf(type);
              const taken = !available.has(type);
              const existing = store.doc.backends.find((backend) => backend.type === type);
              return (
                <button
                  key={type}
                  type="button"
                  data-row-key={`add-${type}`}
                  onClick={() => (taken && existing ? nav.go({ page: "backend", id: existing.id }) : nav.go({ page: "setup", type }, { row: `add-${type}` }))}
                  className={cn("pressable flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover", FOCUS_RING, "focus-visible:ring-offset-0")}
                >
                  <ProviderGlyph type={type} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                      {driver.label}
                      {taken ? <Badge>Added: open it</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{SETUP_WORDS[type]}</span>
                    <span className="mt-1.5 block text-2xs leading-snug text-subtle-foreground">You need: {NEEDS[type]}</span>
                  </span>
                  <Chevron />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Step({ number, title, description, children }: { number: number; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" aria-label={`Step ${number}: ${title}`}>
      <span aria-hidden className="mt-px flex size-5 items-center justify-center rounded-full border border-border text-2xs text-muted-foreground tabular-nums">
        {number}
      </span>
      <div className="min-w-0 space-y-2.5">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

export function SetupBackend({ type }: { type: string }) {
  if (!DRIVERS.some((driver) => driver.type === type)) return <GonePage what="This kind of backend" />;
  return <SetupForm type={type} />;
}

function SetupForm({ type }: { type: string }) {
  const store = useStore();
  const nav = useNav();
  const driver = driverOf(type);
  const [id] = useState(() => (store.doc.backends.some((backend) => backend.id === type) ? `${type}:2` : type));
  const empty: BackendConfig = { id, type, enabled: false, fields: {}, hosts: [] };
  const draft = useDraft({ part: `setup/${type}`, what: `the ${driver.label} setup`, label: (path) => driver.fields.find((field) => path.endsWith(`/${field.key}`))?.label ?? "secret" });
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  const backend = store.doc.backends.find((each) => each.id === id) ?? empty;
  const withNew = (enabled: boolean) => (doc: Document): Document => ({ ...doc, backends: [...doc.backends.filter((each) => each.id !== id), { ...empty, enabled }] });
  const check = useDraftCheck(draft, () => candidateBackend(draft, id, withNew(true)));
  const makes = driver.kinds.filter((kind) => {
    const field = driver.fields.find((each) => offable(each) && each.description?.includes(`${kind} boxes`));
    if (!field) return true;
    const value = draft.value(fieldPath(empty, field.key));
    if (value === "") return false;
    return (value !== undefined && value !== null) || (field.default !== undefined && field.default !== "");
  });
  const save = async (enabled: boolean) => {
    setBusy(enabled ? "on" : "off");
    const saved = await draft.saveWith(withNew(enabled));
    setBusy(null);
    if (saved) nav.landAfterSetup({ page: "backend", id });
  };
  const connection = driver.fields.some((field) => field.group === "connection" || field.group === "credentials") || driver.hostFields.length > 0;
  return (
    <div className="space-y-7">
      <PageHeader glyph={<ProviderGlyph type={type} />} title={`Set up ${driver.label}`} description={driver.description} note={<SaveRule />} />
      <RestoredNote draft={draft} />
      <Step
        number={1}
        title="Prepare"
        description={
          <>
            Follow the{" "}
            <a className="text-muted-foreground underline underline-offset-2 hover:text-foreground" href={`${REPOSITORY}/${driver.setup.guide}`} target="_blank" rel="noreferrer">
              {driver.label} setup guide
            </a>
            . You need: {NEEDS[type]}
            {driver.setup.scripts.length ? " Its scripts run in this order and print the values the next step asks for." : ""}
          </>
        }
      >
        {driver.setup.scripts.length ? (
          <Card>
            <Rows>
              {driver.setup.scripts.map((script, index) => (
                <a key={script} href={`${REPOSITORY}/${script}`} target="_blank" rel="noreferrer" className={cn("flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-state-hover", FOCUS_RING)}>
                  <span className="w-4 text-right text-subtle-foreground tabular-nums">{index + 1}</span>
                  <code className="min-w-0 flex-1 truncate text-foreground">{script.split("/").pop()}</code>
                  <span className="hidden truncate text-subtle-foreground sm:inline">{script.split("/").slice(0, -1).join("/")}</span>
                  <Icon name="ArrowUpRight" className="size-3.5 text-subtle-foreground" aria-hidden />
                </a>
              ))}
            </Rows>
          </Card>
        ) : null}
      </Step>
      {connection ? (
        <Step number={2} title="Connect" description="The values the guide's scripts printed.">
          <FieldGroups draft={draft} backend={backend} driver={driver} backends={store.doc.backends} only={["connection", "credentials"]} />
          <MacsSection draft={draft} backend={backend} driver={driver} saved={false} />
        </Step>
      ) : null}
      <Step number={connection ? 3 : 2} title="Choose what it makes" description={`It will make ${makes.map(kindName).join(", ") || "nothing yet"}. Untick Offer to leave a kind out.`}>
        <FieldGroups draft={draft} backend={backend} driver={driver} backends={store.doc.backends} only={["boxes", "ios-hosts", "advanced"]} />
      </Step>
      <Step number={connection ? 4 : 3} title="Check it" description={`Runs all of ${driver.label}'s checks against this form, as it will be saved, up to 30 s. Nothing is saved.`}>
        <div>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy !== null || check.checking} onClick={() => void check.run()}>
            {check.checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {check.checking ? "Checking…" : "Check"}
          </Button>
        </div>
        {check.stale && !check.checking ? <p className="text-xs text-warning-text">The form changed after you checked it, so that result was cleared. Check again.</p> : null}
        {check.health || check.checking ? <HealthCard health={check.health} checking={check.checking} againstDraft onCheck={() => void check.run()} /> : null}
      </Step>
      <div className="pointer-events-none sticky bottom-3 z-20 flex justify-center">
        <div role="region" aria-label={`Save ${driver.label}`} className="rise-in pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-[0_2px_10px_rgb(0_0_0/0.25)]">
          <span role="status" aria-live="polite" className={cn("min-w-0 flex-1 text-xs leading-snug", draft.bar.kind === "problems" || draft.bar.kind === "error" ? "text-destructive-text" : "text-muted-foreground")}>
            {draft.bar.kind === "problems"
              ? `Not saved: fix the ${draft.bar.count === 1 ? "field" : `${draft.bar.count} fields`} marked, or save it off to finish later.`
              : draft.bar.kind === "error"
                ? draft.bar.message
                : draft.bar.kind === "saving"
                  ? draft.bar.words
                  : "Nothing is saved until you choose. Your form is kept if you leave."}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            disabled={busy !== null}
            onClick={() => {
              draft.discard();
              nav.back();
            }}
          >
            Discard and go back
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy !== null} onClick={() => void save(false)}>
            {busy === "off" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            Save, keep it off
          </Button>
          <Button type="button" size="sm" className="h-7" disabled={busy !== null} onClick={() => void save(true)}>
            {busy === "on" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            Save and turn on
          </Button>
        </div>
      </div>
    </div>
  );
}
