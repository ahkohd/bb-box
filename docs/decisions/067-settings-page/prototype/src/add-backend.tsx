import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DOCKER_MACHINES, DRIVERS, NEEDS, SETUP_GROUPS, SETUP_WORDS, driverOf, type BackendConfig, type Health } from "./data";
import { draftOf, FieldGroups, HostsSection, PageHeaderLite, REPOSITORY, storedFields, type BackendDraft } from "./backend-page";
import { HealthCard } from "./health";
import { availableTypes, kindTitle } from "./model";
import { useNav } from "./nav";
import { useStore, type Problem } from "./store";
import { Badge, Card, Chevron, Icon, ProviderGlyph, Rows, type FormValue } from "./ui";

export function AddBackend() {
  const store = useStore();
  const nav = useNav();
  const [using, setUsing] = useState<string | null>(null);
  const available = new Set(availableTypes(store.doc));
  const machines = DOCKER_MACHINES.filter((machine) => !store.doc.backends.some((backend) => backend.fields.host === `bb:${machine.id}`));
  const withDocker = machines.filter((machine) => machine.docker);
  const without = machines.filter((machine) => !machine.docker);
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Add a backend" description="Choose where new boxes run. Each backend has its own setup guide; the form follows it step by step." />
      {withDocker.length ? (
        <section className="space-y-2.5">
          <div>
            <h3 className="text-xs font-medium text-foreground">Docker on your BB machines</h3>
            <p className="mt-0.5 text-xs text-subtle-foreground">Ready now. A box there is a privileged container, root on the machine, so none is used until you choose it.</p>
          </div>
          <Card>
            <Rows>
              {withDocker.map((machine) => (
                <div key={machine.id} className="flex items-center gap-3 px-4 py-2.5">
                  <ProviderGlyph type="docker" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{machine.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Docker {machine.docker} · {machine.facts}
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
                      if (result.ok) nav.go({ page: "backend", id: `docker:${machine.name}` });
                    }}
                  >
                    {using === machine.id ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                    Use {machine.name}
                  </Button>
                </div>
              ))}
            </Rows>
          </Card>
          {without.length ? <p className="px-1 text-xs text-subtle-foreground">{without.map((machine) => machine.name).join(", ")} have no Docker. Install it there and they appear here.</p> : null}
        </section>
      ) : null}
      {SETUP_GROUPS.map((group) => (
        <section key={group.title} className="space-y-2.5">
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
                  onClick={() => (taken && existing ? nav.go({ page: "backend", id: existing.id }) : nav.go({ page: "setup", type }))}
                  className="pressable flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover"
                >
                  <ProviderGlyph type={type} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {driver.label}
                      {taken ? <Badge>Added</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{SETUP_WORDS[type]}</span>
                    <span className="mt-1.5 block text-2xs leading-snug text-subtle-foreground">{NEEDS[type]}</span>
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
    <section className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <span className="mt-px flex size-5 items-center justify-center rounded-full border border-border text-2xs text-muted-foreground tabular-nums">{number}</span>
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
  const store = useStore();
  const nav = useNav();
  const driver = driverOf(type);
  const id = store.doc.backends.some((backend) => backend.id === type) ? `${type}:2` : type;
  const empty: BackendConfig = { id, type, enabled: false, fields: {}, hosts: [] };
  const [draft, setDraft] = useState<BackendDraft>(() => draftOf(empty, driver));
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [busy, setBusy] = useState<"on" | "off" | "check" | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = `backends.${id}`;
  const problemAt = (at: string) => problems.find((problem) => problem.path === at)?.message ?? null;
  const setField = (key: string, value: FormValue) => {
    setHealth(null);
    setDraft((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
  };
  const config = (enabled: boolean): BackendConfig => ({ ...empty, enabled, fields: storedFields(draft, driver), hosts: draft.hosts });
  const makes = DRIVERS.find((each) => each.type === type)!.kinds.filter((kind) => {
    const key = driver.fields.find((field) => field.group === "boxes" && field.description?.includes(`${kind} boxes`))?.key;
    if (!key) return true;
    const value = draft.fields[key];
    const fallback = driver.fields.find((field) => field.key === key)?.default;
    return (value !== "" && value !== undefined) || (fallback !== "" && fallback !== undefined);
  });
  const save = async (enabled: boolean) => {
    setBusy(enabled ? "on" : "off");
    setNotice(null);
    const result = await store.addBackend(config(enabled));
    setBusy(null);
    if (result.ok) {
      nav.go({ page: "backend", id });
      return;
    }
    if (result.reason === "problems") {
      setProblems(result.problems);
      setNotice(enabled ? "Not saved: it cannot be on with the fields marked. Save it off to finish later." : "Not saved: fix the fields marked.");
      document.querySelector(`[data-problem="${result.problems[0]?.path}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    setNotice(result.reason === "error" ? result.message : "Someone saved the configuration first. Your form is kept; save again.");
  };
  const connectionGroups = driver.fields.some((field) => field.group === "connection" || field.group === "credentials");
  return (
    <div className="space-y-7">
      <PageHeaderLite glyph={<ProviderGlyph type={type} />} title={`Set up ${driver.label}`} description={driver.description} />
      <Step
        number={1}
        title="Prepare"
        description={
          <>
            Follow the{" "}
            <a className="text-muted-foreground underline underline-offset-2 hover:text-foreground" href={`${REPOSITORY}/${driver.setup.guide}`} target="_blank" rel="noreferrer">
              {driver.label} setup guide
            </a>
            . Run its scripts in this order; they print the values the next step asks for.
          </>
        }
      >
        {driver.setup.scripts.length ? (
          <Card>
            <Rows>
              {driver.setup.scripts.map((script, index) => (
                <a key={script} href={`${REPOSITORY}/${script}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-state-hover">
                  <span className="w-4 text-right text-subtle-foreground tabular-nums">{index + 1}</span>
                  <code className="min-w-0 flex-1 truncate text-foreground">{script.split("/").pop()}</code>
                  <span className="truncate text-subtle-foreground">{script.split("/").slice(0, -1).join("/")}</span>
                  <Icon name="ArrowUpRight" className="size-3.5 text-subtle-foreground" aria-hidden />
                </a>
              ))}
            </Rows>
          </Card>
        ) : null}
      </Step>
      {connectionGroups ? (
        <Step number={2} title="Connect" description="The values the guide's scripts printed. Check tries them before anything is saved.">
          <FieldGroups driver={driver} draft={draft} setField={setField} problemAt={problemAt} path={path} backends={store.doc.backends} only={["connection", "credentials"]} />
          <HostsSection driver={driver} draft={draft} setHosts={(hosts) => setDraft((current) => ({ ...current, hosts }))} problemAt={problemAt} path={path} />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("check");
                setHealth(await store.checkDraft(config(true)));
                setBusy(null);
              }}
            >
              {busy === "check" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {busy === "check" ? "Checking…" : "Check the connection"}
            </Button>
          </div>
          {health || busy === "check" ? <HealthCard health={health} checking={busy === "check"} againstDraft onCheck={async () => setHealth(await store.checkDraft(config(true)))} /> : null}
        </Step>
      ) : null}
      <Step number={connectionGroups ? 3 : 2} title="Choose what it makes" description={`It will make: ${makes.map(kindTitle).join(", ") || "nothing yet"}. Empty a field to leave a kind out.`}>
        <FieldGroups driver={driver} draft={draft} setField={setField} problemAt={problemAt} path={path} backends={store.doc.backends} only={["boxes", "ios-hosts", "advanced"]} />
      </Step>
      <div className={cn("sticky bottom-4 z-20 flex justify-center")}>
        <div className="rise-in flex flex-wrap items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 shadow-[0_2px_8px_rgb(0_0_0/0.3)]">
          {notice ? (
            <span role="alert" className="max-w-sm text-xs text-destructive-text">
              {notice}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Nothing is saved until you choose.</span>
          )}
          <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy !== null} onClick={nav.back}>
            Cancel
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy !== null} onClick={() => void save(false)}>
            {busy === "off" ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            Save, keep off
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
