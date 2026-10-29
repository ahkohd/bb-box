import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { driverOf, type BackendConfig, type DriverView, type FieldView, type Health, type HostConfig, type Stored } from "./data";
import { HealthCard } from "./health";
import { backendTitle, kindName, plural, qualifierOf } from "./model";
import { useNav } from "./nav";
import { useStore } from "./store";
import { Badge, Card, FieldInput, Icon, ProviderGlyph, Rows, SaveBar, SavedTick, Section, SettingRow, useEditing, useInstant, type FormValue } from "./ui";

export const REPOSITORY = "https://github.com/moonstead/bb-box/blob/main";

export interface BackendDraft {
  readonly fields: Readonly<Record<string, FormValue>>;
  readonly hosts: readonly HostConfig[];
}

export function draftOf(backend: BackendConfig, driver: DriverView): BackendDraft {
  const fields: Record<string, FormValue> = {};
  for (const field of driver.fields) {
    const value = backend.fields[field.key];
    fields[field.key] = field.secret ? ((value as { set: boolean } | undefined) ?? { set: false }) : ((value as FormValue | undefined) ?? "");
  }
  return { fields, hosts: backend.hosts ?? [] };
}

export function storedFields(draft: BackendDraft, driver: DriverView): Record<string, Stored> {
  const fields: Record<string, Stored> = {};
  for (const field of driver.fields) {
    const value = draft.fields[field.key];
    if (value === null) {
      fields[field.key] = { set: false };
      continue;
    }
    if (value === "" || value === undefined) continue;
    if (field.type === "number" && typeof value === "string" && value.trim() && Number.isFinite(Number(value))) fields[field.key] = Number(value);
    else if (typeof value === "string" && field.secret) fields[field.key] = { set: true };
    else fields[field.key] = value as Stored;
  }
  return fields;
}

export const GROUPS: readonly { readonly id: string; readonly title: string; readonly description?: string }[] = [
  { id: "connection", title: "Connection" },
  { id: "credentials", title: "Credentials", description: "Kept secret: BB Box never shows them again, only whether each is set." },
  { id: "boxes", title: "Boxes", description: "What new boxes start from, and what they may do." },
  { id: "ios-hosts", title: "Shared iOS hosts", description: "ios boxes as macOS users on a shared Mac or VM, ready in seconds." },
  { id: "advanced", title: "Advanced" },
];

export function groupOf(field: FieldView): string {
  if (field.key.startsWith("ios-hosts-")) return "ios-hosts";
  return field.group;
}

function inheritedValue(field: FieldView, backends: readonly BackendConfig[]): string | undefined {
  if (!field.inherits) return undefined;
  const source = backends.find((backend) => backend.type === field.inherits!.from);
  const value = source?.fields[field.key];
  if (value === undefined || typeof value === "object") return undefined;
  return String(value);
}

export function FieldRows({ driver, fields, draft, setField, problemAt, path, backends }: { driver: DriverView; fields: readonly FieldView[]; draft: BackendDraft; setField: (key: string, value: FormValue) => void; problemAt: (path: string) => string | null; path: string; backends: readonly BackendConfig[] }) {
  return (
    <Rows>
      {fields.map((field) => {
        const inherited = inheritedValue(field, backends);
        const value = draft.fields[field.key];
        const empty = value === "" || value === undefined || (typeof value === "object" && value !== null && !value.set);
        return (
          <SettingRow
            key={field.key}
            id={`${path}.${field.key}`}
            problemPath={`${path}.${field.key}`}
            label={field.label}
            description={field.description}
            problem={problemAt(`${path}.${field.key}`)}
            stacked={field.experimental_multiline}
            chips={field.inherits && empty && (inherited || field.secret) ? <Badge>from {field.inherits.label}</Badge> : null}
          >
            <FieldInput field={field} value={value ?? ""} inherited={inherited} invalid={!!problemAt(`${path}.${field.key}`)} onChange={(next) => setField(field.key, next)} />
          </SettingRow>
        );
      })}
    </Rows>
  );
}

export function FieldGroups({ driver, draft, setField, problemAt, path, backends, numbered, only }: { driver: DriverView; draft: BackendDraft; setField: (key: string, value: FormValue) => void; problemAt: (path: string) => string | null; path: string; backends: readonly BackendConfig[]; numbered?: boolean; only?: readonly string[] }) {
  const nav = useNav();
  const [advanced, setAdvanced] = useState(false);
  const groups = GROUPS.filter((group) => (only ? only.includes(group.id) : true)).map((group) => ({ ...group, fields: driver.fields.filter((field) => groupOf(field) === group.id) })).filter((group) => group.fields.length);
  return (
    <>
      {groups.map((group) => {
        const folded = group.id === "advanced";
        const hasProblem = group.fields.some((field) => problemAt(`${path}.${field.key}`));
        const foundHere = group.fields.some((field) => nav.found === `${path}.${field.key}`);
        const open = !folded || advanced || hasProblem || foundHere;
        return (
          <Section
            key={group.id}
            title={group.title}
            description={folded ? `${plural(group.fields.length, "setting")} most backends keep at their defaults.` : group.description}
            action={
              folded ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" aria-expanded={open} onClick={() => setAdvanced((current) => !current)}>
                  {open ? "Hide" : "Show"}
                  <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
                </Button>
              ) : null
            }
          >
            {open ? (
              <Card>
                <FieldRows driver={driver} fields={group.fields} draft={draft} setField={setField} problemAt={problemAt} path={path} backends={backends} />
              </Card>
            ) : null}
          </Section>
        );
      })}
    </>
  );
}

export function HostsSection({ driver, draft, setHosts, problemAt, path }: { driver: DriverView; draft: BackendDraft; setHosts: (hosts: HostConfig[]) => void; problemAt: (path: string) => string | null; path: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!driver.hostFields.length) return null;
  const mainFields = driver.hostFields.filter((field) => field.group !== "advanced");
  const overrides = driver.hostFields.filter((field) => field.group === "advanced");
  const update = (index: number, host: HostConfig) => setHosts(draft.hosts.map((each, n) => (n === index ? host : each)));
  return (
    <Section
      title="Macs"
      description="A new box goes to the first Mac in the list with room."
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            setHosts([...draft.hosts, { name: "", enabled: true, fields: {} }]);
            setOpen(draft.hosts.length);
          }}
        >
          <Icon name="Plus" aria-hidden />
          Add Mac
        </Button>
      }
    >
      {problemAt(`${path}.hosts`) ? (
        <p role="alert" data-problem={`${path}.hosts`} className="text-xs text-destructive-text">
          {problemAt(`${path}.hosts`)}
        </p>
      ) : null}
      <Card>
        <Rows>
          {draft.hosts.map((host, index) => (
            <div key={index}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" onClick={() => setOpen((current) => (current === index ? null : index))} aria-expanded={open === index}>
                  <ProviderGlyph type="tart" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">{host.name || "New Mac"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {String(host.fields.user || "user")}@{String(host.fields.address || "address")}
                      {overrides.some((field) => host.fields[field.key] !== undefined && host.fields[field.key] !== "") ? " · own shared iOS host size" : ""}
                    </span>
                  </span>
                  <Icon name={open === index ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />
                </button>
                <Switch aria-label={`${host.name || "New Mac"} on`} checked={host.enabled} onCheckedChange={(enabled) => update(index, { ...host, enabled })} />
              </div>
              {open === index ? (
                <div className="border-t border-border bg-surface-raised">
                  <Rows>
                    <SettingRow label="Name" description="Lower-case letters, digits and hyphens.">
                      <Input aria-label="Mac name" className="h-8 w-64 text-xs" value={host.name} placeholder="for example mac-1" onChange={(event) => update(index, { ...host, name: event.target.value })} />
                    </SettingRow>
                    {[...mainFields, ...overrides].map((field) => (
                      <SettingRow key={field.key} label={field.label} description={field.description} stacked={field.experimental_multiline}>
                        <FieldInput field={field} value={(host.fields[field.key] as FormValue) ?? ""} onChange={(value) => update(index, { ...host, fields: { ...host.fields, [field.key]: value as string } })} />
                      </SettingRow>
                    ))}
                    <div className="flex justify-end px-4 py-2.5">
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setHosts(draft.hosts.filter((_, n) => n !== index))}>
                        <Icon name="Trash2" aria-hidden />
                        Remove {host.name || "this Mac"}
                      </Button>
                    </div>
                  </Rows>
                </div>
              ) : null}
            </div>
          ))}
        </Rows>
      </Card>
    </Section>
  );
}

export function GuideLine({ driver }: { driver: DriverView }) {
  if (!driver.setup.guide) return null;
  return (
    <p className="text-xs leading-snug text-subtle-foreground">
      <a className="text-muted-foreground underline underline-offset-2 hover:text-foreground" href={`${REPOSITORY}/${driver.setup.guide}`} target="_blank" rel="noreferrer">
        {driver.label} setup guide
      </a>
      {driver.setup.scripts.length ? (
        <>
          {" · "}
          {driver.setup.scripts.map((script, index) => (
            <span key={script}>
              {index ? ", " : ""}
              <a className="hover:text-foreground hover:underline" href={`${REPOSITORY}/${script}`} target="_blank" rel="noreferrer">
                {script.split("/").pop()}
              </a>
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}

function Facts({ backend }: { backend: BackendConfig }) {
  const store = useStore();
  const nav = useNav();
  const live = store.live[backend.id];
  const offers = live?.offers ?? [];
  const warm = Object.entries(backend.warm ?? {}).filter(([, count]) => count > 0);
  const rows: { label: string; value: ReactNode }[] = [
    { label: "Boxes now", value: live?.boxes ? plural(live.boxes, "box", "boxes") : "None" },
    {
      label: "Makes",
      value: offers.length ? (
        <span className="flex flex-wrap justify-end gap-1">
          {offers.map((kind) => (
            <button key={kind} type="button" className="cursor-pointer" onClick={() => nav.go({ page: "kind", id: kind })}>
              <Badge className="hover:text-foreground">{kindName(kind)}</Badge>
            </button>
          ))}
        </span>
      ) : backend.enabled ? (
        <span className="text-warning-text">Nothing until it works again</span>
      ) : (
        "Nothing while it is off"
      ),
    },
    { label: "Kept warm", value: warm.length ? warm.map(([kind, count]) => `${count} ${kindName(kind)}`).join(" · ") : "None. Set on each kind's page." },
  ];
  if (live?.bbMachine) rows.unshift({ label: "BB machine", value: `${live.bbMachine.name} · ${live.bbMachine.connected ? live.bbMachine.facts : "offline in BB"}` });
  return (
    <Card>
      <Rows>
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-4 px-4 py-2.5 text-xs">
            <span className="shrink-0 text-muted-foreground">{row.label}</span>
            <span className="min-w-0 text-right text-foreground">{row.value}</span>
          </div>
        ))}
      </Rows>
    </Card>
  );
}

export function BackendPage({ id }: { id: string }) {
  const store = useStore();
  const backend = store.doc.backends.find((each) => each.id === id);
  if (!backend) return <p className="text-sm text-muted-foreground">This backend was removed.</p>;
  return <BackendEditor key={`${id}`} backend={backend} />;
}

function BackendEditor({ backend }: { backend: BackendConfig }) {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const driver = driverOf(backend.type);
  const live = store.live[backend.id];
  const path = `backends.${backend.id}`;
  const title = backendTitle(backend, live);
  const editing = useEditing<BackendDraft>({
    stored: draftOf(backend, driver),
    part: path,
    what: title,
    build: (doc, draft) => ({ ...doc, backends: doc.backends.map((each) => (each.id === backend.id ? { ...each, fields: storedFields(draft, driver), hosts: driver.hostFields.length ? draft.hosts : undefined } : each)) }),
  });
  const [draftHealth, setDraftHealth] = useState<Health | null>(null);
  const [checkingDraft, setCheckingDraft] = useState(false);
  const setField = (key: string, value: FormValue) => {
    setDraftHealth(null);
    editing.setDraft((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
  };
  const qualifier = qualifierOf(backend, live);
  const boxes = live?.boxes ?? 0;
  const checkDraft = async () => {
    setCheckingDraft(true);
    const health = await store.checkDraft({ ...backend, fields: storedFields(editing.draft, driver), hosts: editing.draft.hosts });
    setDraftHealth(health);
    setCheckingDraft(false);
  };
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <PageHeaderLite
              glyph={<ProviderGlyph type={backend.type} className="size-4.5" />}
              title={driver.label}
              chips={
                <>
                  {qualifier ? <Badge>{qualifier}</Badge> : null}
                  {live?.bbMachine ? <Badge>BB machine</Badge> : null}
                </>
              }
              description={driver.description}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-7">
            <SavedTick show={instant.saved === "enabled"} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {backend.enabled ? "On" : "Off"}
              <Switch aria-label={`${title} on`} checked={backend.enabled} disabled={instant.pending === "enabled"} onCheckedChange={(enabled) => void instant.run("enabled", path, (doc) => ({ ...doc, backends: doc.backends.map((each) => (each.id === backend.id ? { ...each, enabled } : each)) }))} />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`${title} actions`}>
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-44">
                <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(JSON.stringify({ ...backend, fields: storedFields(editing.draft, driver) }, null, 2))}>
                  <Icon name="Copy" aria-hidden />
                  Copy as JSON
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => window.alert("Opens a small dialog with the backend's display name. Its ID stays as it is.")}>
                  <Icon name="Settings" aria-hidden />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => window.open(`${REPOSITORY}/${driver.setup.guide}`, "_blank")}>
                  <Icon name="ExternalLink" aria-hidden />
                  Open the setup guide
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={boxes > 0}
                  onSelect={() => {
                    void store.save(path, (doc) => ({ ...doc, backends: doc.backends.filter((each) => each.id !== backend.id) }), { force: true }).then(() => nav.go({ page: "overview" }));
                  }}
                >
                  <Icon name="Trash2" aria-hidden />
                  {boxes ? `Remove: release its ${plural(boxes, "box", "boxes")} first` : "Remove backend"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {instant.refused ? <p className="text-xs text-destructive-text">{instant.refused.message}</p> : null}
      </div>

      <HealthCard health={draftHealth ?? live?.health ?? null} checking={checkingDraft || !!live?.checking} againstDraft={!!draftHealth} off={!backend.enabled} onCheck={() => (editing.changes ? void checkDraft() : void store.check(backend.id))} />

      <Facts backend={backend} />

      <FieldGroups driver={driver} draft={editing.draft} setField={setField} problemAt={editing.problemAt} path={path} backends={store.doc.backends} />

      <HostsSection driver={driver} draft={editing.draft} setHosts={(hosts) => editing.setDraft((current) => ({ ...current, hosts }))} problemAt={editing.problemAt} path={path} />

      <GuideLine driver={driver} />

      <SaveBar
        state={editing.bar}
        changes={editing.changes}
        what={title}
        onSave={editing.save}
        onDiscard={() => {
          setDraftHealth(null);
          editing.discard();
        }}
        onCheck={() => void checkDraft()}
        checking={checkingDraft}
        onKeepMine={editing.keepMine}
        onUseSaved={() => editing.useSaved(draftOf(store.doc.backends.find((each) => each.id === backend.id) ?? backend, driver))}
      />
    </div>
  );
}

export function PageHeaderLite({ glyph, title, chips, description }: { glyph?: ReactNode; title: string; chips?: ReactNode; description?: ReactNode }) {
  const nav = useNav();
  return (
    <div className="space-y-3">
      <button type="button" onClick={nav.back} className="-ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
        BB Box settings
      </button>
      <div className="flex items-start gap-3">
        {glyph ? <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-raised")}>{glyph}</span> : null}
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-1.5 text-base font-medium leading-tight text-foreground">
            {title}
            {chips}
          </h2>
          {description ? <p className="mt-1 text-xs leading-snug text-subtle-foreground">{description}</p> : null}
        </div>
      </div>
    </div>
  );
}
