import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { driverOf, type BackendConfig, type DriverView, type FieldView, type Health, type HostConfig } from "./data";
import { HealthCard } from "./health";
import { backendState, backendTitle, kindName, plural, qualifierOf } from "./model";
import { useNav } from "./nav";
import { useStore } from "./store";
import { isSecretEdit, useDraft, useInstant, type Draft } from "./drafts";
import { isSecretState, writePath, type Path } from "./paths";
import { Badge, Card, Checkbox, ConflictNote, FieldInput, Icon, PageHeader, ProviderGlyph, RestoredNote, Rows, SaveBar, SaveRule, SavedTick, Section, SettingRow, Confirm, FOCUS_RING } from "./ui";

export const REPOSITORY = "https://github.com/moonstead/bb-box/blob/main";

export const GROUPS: readonly { readonly id: string; readonly title: string; readonly description?: string; readonly folded?: boolean }[] = [
  { id: "connection", title: "Connection" },
  { id: "credentials", title: "Credentials", description: "Kept secret: BB Box never shows them again, only whether each is set." },
  { id: "boxes", title: "Boxes", description: "What new boxes start from, and what they may do." },
  { id: "ios-hosts", title: "Shared iOS hosts", description: "ios boxes as macOS users on a shared Mac or VM, ready in seconds.", folded: true },
  { id: "advanced", title: "Advanced", folded: true },
];

export function groupOf(field: FieldView): string {
  if (field.key.startsWith("ios-hosts-")) return "ios-hosts";
  return field.group;
}

export function offable(field: FieldView): boolean {
  return field.group === "boxes" && field.type === "string" && /Empty(,| turns| offers)/.test(field.description ?? "") && !field.secret;
}

function inheritedValue(field: FieldView, backends: readonly BackendConfig[]): string | undefined {
  if (!field.inherits) return undefined;
  const value = backends.find((backend) => backend.type === field.inherits!.from)?.fields[field.key];
  if (value === undefined || typeof value === "object") return undefined;
  return String(value);
}

export function placeholderOf(field: FieldView, backends: readonly BackendConfig[]): string | undefined {
  const inherited = inheritedValue(field, backends);
  if (inherited) return `From ${field.inherits!.label}: ${inherited}`;
  if (field.default !== undefined && field.default !== "") return `Default: ${String(field.default)}`;
  if (field.key.startsWith("ios-hosts-")) return "Estimated for each Mac";
  return undefined;
}

export function fieldPath(backend: { id: string }, key: string): Path {
  return `backends/${backend.id}/fields/${key}`;
}

export function FieldRow({ draft, backend, field, backends, path = fieldPath(backend, field.key), placeholder }: { draft: Draft; backend: { id: string }; field: FieldView; backends: readonly BackendConfig[]; path?: Path; placeholder?: string }) {
  const value = draft.value(path);
  const stored = draft.stored(path);
  const conflict = draft.conflictAt(path);
  const off = offable(field);
  const isOff = off && value === "";
  const control = <FieldInput field={field} value={value} stored={stored} onChange={(next) => draft.set(path, next === "" && !off ? undefined : next)} placeholder={isOff ? "Off" : (placeholder ?? placeholderOf(field, backends))} disabled={isOff} />;
  return (
    <SettingRow
      id={path}
      label={field.label}
      help={field.description}
      problem={draft.problemAt(path)}
      stacked={field.experimental_multiline}
      focus={draft.focusPath === path}
      onFocused={draft.clearFocus}
      chips={field.inherits && (value === undefined || value === "" || (isSecretState(value) && !value.set)) ? <Badge>from {field.inherits.label}</Badge> : draft.edited(path) && !conflict ? <Badge tone="warn">Changed</Badge> : null}
      conflict={conflict ? <ConflictNote saved={conflict.saved} secret={field.secret} onUseSaved={() => draft.useSaved(path)} onKeepMine={() => draft.keepMine(path)} /> : null}
    >
      {off ? (
        <span className="flex w-full items-center gap-2 sm:w-auto">
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox label={`${field.label}: offer it`} checked={!isOff} onChange={(checked) => draft.set(path, checked ? undefined : "")} />
            Offer
          </label>
          {control}
        </span>
      ) : (
        control
      )}
    </SettingRow>
  );
}

function groupSummary(draft: Draft, backend: BackendConfig, fields: readonly FieldView[]): string {
  const set = fields.filter((field) => {
    const value = draft.value(fieldPath(backend, field.key));
    return value !== undefined && value !== "";
  });
  if (fields.some((field) => field.key === "ios-hosts-on")) {
    const on = draft.value(fieldPath(backend, "ios-hosts-on")) ?? fields.find((field) => field.key === "ios-hosts-on")?.default;
    return `${on ? "On" : "Off"} · ${set.length > 1 ? `${set.length - 1} set` : "sizes estimated for each Mac"}`;
  }
  return set.length ? `${plural(set.length, "setting")} changed from the defaults` : "All at their defaults";
}

export function FieldGroups({ draft, backend, driver, backends, only }: { draft: Draft; backend: BackendConfig; driver: DriverView; backends: readonly BackendConfig[]; only?: readonly string[] }) {
  const nav = useNav();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = GROUPS.filter((group) => (only ? only.includes(group.id) : true))
    .map((group) => ({ ...group, fields: driver.fields.filter((field) => groupOf(field) === group.id) }))
    .filter((group) => group.fields.length);
  return (
    <>
      {groups.map((group) => {
        const paths = group.fields.map((field) => fieldPath(backend, field.key));
        const forced = paths.some((path) => draft.problemAt(path) || draft.conflictAt(path) || draft.edited(path) || nav.found === path || draft.focusPath === path);
        const shown = !group.folded || open[group.id] || forced;
        return (
          <Section
            key={group.id}
            title={group.title}
            description={group.folded ? `${group.description ? `${group.description} ` : ""}${groupSummary(draft, backend, group.fields)}.` : group.description}
            action={
              group.folded && !forced ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" aria-expanded={shown} onClick={() => setOpen((current) => ({ ...current, [group.id]: !shown }))}>
                  {shown ? "Hide" : `Show ${plural(group.fields.length, "setting")}`}
                  <Icon name={shown ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
                </Button>
              ) : null
            }
          >
            {shown ? (
              <Card>
                <Rows>
                  {group.fields.map((field) => (
                    <FieldRow key={field.key} draft={draft} backend={backend} field={field} backends={backends} />
                  ))}
                </Rows>
              </Card>
            ) : null}
          </Section>
        );
      })}
    </>
  );
}

export function MacsSection({ draft, backend, driver, saved }: { draft: Draft; backend: BackendConfig; driver: DriverView; saved: boolean }) {
  const store = useStore();
  const instant = useInstant();
  const nav = useNav();
  const [open, setOpen] = useState<string | null>(() => (backend.hosts ?? []).find((host) => nav.found?.includes(`/hosts/${host.name}/`))?.name ?? null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!driver.hostFields.length) return null;
  const savedHosts = store.doc.backends.find((each) => each.id === backend.id)?.hosts ?? [];
  const stagedNew: HostConfig[] = [];
  for (let index = 1; index < 6; index += 1) {
    const value = draft.value(`backends/${backend.id}/hosts/new-mac-${index}`);
    if (value && typeof value === "object" && "name" in (value as object)) stagedNew.push(value as HostConfig);
  }
  const hosts = [...savedHosts.map((host) => ({ host, fresh: false })), ...stagedNew.map((host) => ({ host, fresh: true }))];
  const main = driver.hostFields.filter((field) => field.group !== "advanced");
  const own = driver.hostFields.filter((field) => field.group === "advanced");
  const tartValue = (key: string) => draft.value(fieldPath(backend, key));
  return (
    <Section
      title="Macs"
      description="A new box goes to the first Mac in the list with room. A Mac's switch acts at once; its fields wait for Save."
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            const index = stagedNew.length + 1;
            const name = `new-mac-${index}`;
            draft.set(`backends/${backend.id}/hosts/${name}`, { name, enabled: true, fields: {} });
            setOpen(name);
          }}
        >
          <Icon name="Plus" aria-hidden />
          Add Mac
        </Button>
      }
    >
      {draft.problemAt(`backends/${backend.id}/hosts`) ? (
        <p role="alert" className="text-xs text-destructive-text">
          {draft.problemAt(`backends/${backend.id}/hosts`)}
        </p>
      ) : null}
      <Card>
        <Rows>
          {hosts.map(({ host, fresh }) => {
            const removed = !fresh && draft.value(`backends/${backend.id}/hosts/${host.name}`) === null;
            const hostPath = (key: string) => (fresh ? `backends/${backend.id}/hosts/${host.name}` : `backends/${backend.id}/hosts/${host.name}/fields/${key}`);
            const read = (key: string) => (fresh ? ((draft.value(hostPath(key)) as HostConfig).fields[key] ?? "") : draft.value(hostPath(key)));
            const write = (key: string, value: unknown) => {
              if (!fresh) return draft.set(hostPath(key), value);
              const current = draft.value(hostPath(key)) as HostConfig;
              draft.set(hostPath(key), { ...current, fields: { ...current.fields, [key]: value ?? "" } });
            };
            const pendingValue = instant.pendingValue(host.name);
            return (
              <div key={host.name} className={cn(removed && "opacity-60")}>
                <div className="flex items-center gap-3 pr-4">
                  <button type="button" className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-4 text-left", FOCUS_RING)} onClick={() => setOpen((current) => (current === host.name ? null : host.name))} aria-expanded={open === host.name}>
                    <ProviderGlyph type="tart" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                        {fresh ? "New Mac" : host.name}
                        {fresh ? <Badge tone="warn">Added when you save</Badge> : null}
                        {removed ? <Badge tone="warn">Removed when you save</Badge> : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {String(read("user") || "user")}@{String(read("address") || "address")}
                        {own.some((field) => { const value = read(field.key); return value !== undefined && value !== ""; }) ? " · its own shared iOS host size" : ""}
                      </span>
                    </span>
                    <Icon name={open === host.name ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />
                  </button>
                  {fresh ? (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox label="New Mac takes boxes" checked={(draft.value(hostPath("")) as HostConfig).enabled} onChange={(enabled) => draft.set(hostPath(""), { ...(draft.value(hostPath("")) as HostConfig), enabled })} />
                      Takes boxes
                    </label>
                  ) : (
                    <>
                      <SavedTick show={instant.saved === host.name} />
                      <Switch aria-label={`Mac ${host.name}: takes new boxes`} checked={pendingValue !== undefined ? (pendingValue as boolean) : host.enabled} disabled={!saved || removed || instant.pending === host.name} onCheckedChange={(enabled) => void instant.run(host.name, [[`backends/${backend.id}/hosts/${host.name}/enabled`, enabled]], `Mac ${host.name}`)} />
                    </>
                  )}
                </div>
                {instant.refused?.key === host.name ? <p className="px-4 pb-2 text-xs text-destructive-text">{instant.refused.message}</p> : null}
                {open === host.name && !removed ? (
                  <div className="border-t border-border bg-surface-raised">
                    <Rows>
                      {fresh ? (
                        <SettingRow label="Name" help="Lower-case letters, digits and hyphens. It cannot be changed once the Mac has boxes." problem={draft.problemAt(`backends/${backend.id}/hosts/${host.name}/name`)}>
                          <Input aria-label="New Mac's name" className="h-8 w-full text-xs sm:w-72" placeholder="for example mac-2" onChange={(event) => draft.set(hostPath(""), { ...(draft.value(hostPath("")) as HostConfig), name: event.target.value })} />
                        </SettingRow>
                      ) : null}
                      {main.map((field) => (
                        <SettingRow key={field.key} id={hostPath(field.key)} label={field.label} help={field.description} stacked={field.experimental_multiline} problem={draft.problemAt(`backends/${backend.id}/hosts/${host.name}/fields/${field.key}`)} conflict={!fresh && draft.conflictAt(hostPath(field.key)) ? <ConflictNote saved={draft.conflictAt(hostPath(field.key))!.saved} onUseSaved={() => draft.useSaved(hostPath(field.key))} onKeepMine={() => draft.keepMine(hostPath(field.key))} /> : null}>
                          <FieldInput field={field} value={read(field.key)} stored={undefined} onChange={(value) => write(field.key, value === "" ? undefined : value)} />
                        </SettingRow>
                      ))}
                      <div className="px-4 pb-1 pt-3">
                        <p className="text-xs font-medium text-foreground">Its own shared iOS host size</p>
                        <p className="text-xs text-subtle-foreground">Empty takes Tart's setting above, or bb-box's estimate for this Mac. A change reaches the next shared host made on it; one running now keeps its size.</p>
                      </div>
                      {own.map((field) => {
                        const backendKey = field.key;
                        const fromTart = tartValue(backendKey);
                        const effective = fromTart !== undefined && fromTart !== "" ? `Tart's setting: ${String(fromTart)}` : field.key === "ios-hosts-memory-gib" ? "Estimate for this Mac: 17 GiB" : field.key === "ios-hosts-cores" ? "Estimate for this Mac: 10 cores" : "Estimate for this Mac: 6 slots";
                        return (
                          <SettingRow key={field.key} id={hostPath(field.key)} label={field.label} problem={draft.problemAt(`backends/${backend.id}/hosts/${host.name}/fields/${field.key}`)} focus={draft.focusPath === `backends/${backend.id}/hosts/${host.name}/fields/${field.key}`} onFocused={draft.clearFocus}>
                            <FieldInput field={field} value={read(field.key)} stored={undefined} placeholder={effective} onChange={(value) => write(field.key, value === "" ? undefined : value)} />
                          </SettingRow>
                        );
                      })}
                      <div className="flex justify-end px-4 py-2.5">
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => (fresh ? draft.useSaved(hostPath("")) : setRemoving(host.name))}>
                          <Icon name="Trash2" aria-hidden />
                          {fresh ? "Don't add it" : `Remove ${host.name}…`}
                        </Button>
                      </div>
                    </Rows>
                  </div>
                ) : null}
              </div>
            );
          })}
        </Rows>
      </Card>
      <Confirm
        open={removing !== null}
        title={`Remove ${removing} from Tart when you save?`}
        description={
          <>
            <p>New boxes stop going to {removing}. Its shared iOS host is deleted when its last box goes, and its warm VMs are released.</p>
            <p>Boxes on it keep working until they are released. BB Box refuses to remove a Mac while boxes are on it: turn its switch off and release them first.</p>
          </>
        }
        action="Remove when I save"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          draft.set(`backends/${backend.id}/hosts/${removing}`, null);
          setRemoving(null);
        }}
      />
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
            <button key={kind} type="button" className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "kind", id: kind })}>
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
    {
      label: "Kept warm",
      value: warm.length ? (
        <span className="flex flex-col items-end gap-0.5">
          {warm.map(([kind, count]) => {
            const short = live?.warmShort?.find((each) => each.kind === kind);
            return (
              <span key={kind} className={cn(short && "text-warning-text")}>
                {short ? `${short.ready} of ${count} ${kindName(kind)} ready: no room` : `${count} ${kindName(kind)}`}
              </span>
            );
          })}
        </span>
      ) : (
        "None. Set on each kind's page."
      ),
    },
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
  if (!backend) {
    return (
      <div className="space-y-3">
        <PageHeader title="This backend is gone" description="It was removed, here or elsewhere. Its settings are no longer in the configuration." />
      </div>
    );
  }
  return <BackendEditor key={id} backend={backend} />;
}

function BackendEditor({ backend }: { backend: BackendConfig }) {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const driver = driverOf(backend.type);
  const live = store.live[backend.id];
  const title = backendTitle(backend, live);
  const secretPaths = new Set(driver.fields.filter((field) => field.secret).map((field) => fieldPath(backend, field.key)));
  const draft = useDraft({ part: `backends/${backend.id}`, what: title, secretPaths, label: (path) => driver.fields.find((field) => path.endsWith(`/${field.key}`))?.label ?? "secret" });
  const [draftHealth, setDraftHealth] = useState<{ revision: number; changes: number; health: Health } | null>(null);
  const [checkingDraft, setCheckingDraft] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const qualifier = qualifierOf(backend, live);
  const boxes = live?.boxes ?? 0;
  const state = backendState(store.doc, backend, live);
  const checkDraft = async () => {
    setCheckingDraft(true);
    let candidate = store.fetch();
    for (const path of driver.fields.map((field) => fieldPath(backend, field.key))) if (draft.edited(path) && !isSecretEdit(draft.value(path))) candidate = writePath(candidate, path, draft.value(path));
    const health = await store.checkDraft(candidate.backends.find((each) => each.id === backend.id)!);
    setDraftHealth({ revision: store.doc.revision, changes: draft.changes, health });
    setCheckingDraft(false);
  };
  const secrets = driver.fields.filter((field) => field.secret && isSecretState(backend.fields[field.key]) && (backend.fields[field.key] as { set: boolean }).set).map((field) => field.label);
  const pendingValue = instant.pendingValue("enabled");
  return (
    <div className="space-y-6">
      <PageHeader
        glyph={<ProviderGlyph type={backend.type} className="size-4.5" />}
        title={backend.label ?? driver.label}
        chips={
          <>
            {qualifier ? <Badge>{qualifier}</Badge> : null}
            {live?.bbMachine ? <Badge>BB machine</Badge> : null}
          </>
        }
        description={driver.description}
        aside={
          <>
            <SavedTick show={instant.saved === "enabled"} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Takes new boxes
              <Switch aria-label={`${title}: takes new boxes`} checked={pendingValue !== undefined ? (pendingValue as boolean) : backend.enabled} disabled={instant.pending === "enabled"} onCheckedChange={(enabled) => void instant.run("enabled", [[`backends/${backend.id}/enabled`, enabled]], title)} />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-7 p-0 text-muted-foreground hover:text-foreground" aria-label={`More for ${title}`}>
                  <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max min-w-52">
                <DropdownMenuItem onSelect={() => setRenaming(backend.label ?? "")}>
                  <Icon name="Settings" aria-hidden />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(JSON.stringify(store.doc.backends.find((each) => each.id === backend.id), null, 2))}>
                  <Icon name="Copy" aria-hidden />
                  Copy saved settings as JSON
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => window.open(`${REPOSITORY}/${driver.setup.guide}`, "_blank")}>
                  <Icon name="ExternalLink" aria-hidden />
                  Open the setup guide
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={boxes > 0} onSelect={() => setConfirmRemove(true)}>
                  <Icon name="Trash2" aria-hidden />
                  {boxes ? `Remove: release its ${plural(boxes, "box", "boxes")} first` : "Remove backend…"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        note={
          <div className="space-y-1">
            {instant.refused ? (
              <p role="alert" className="text-xs text-destructive-text">
                {instant.refused.message}
              </p>
            ) : null}
            <p className="text-xs text-subtle-foreground">Saved changes reach new boxes; boxes already made keep theirs.</p>
            <SaveRule />
          </div>
        }
      />
      <RestoredNote draft={draft} />
      <HealthCard
        state={state}
        health={draftHealth && draftHealth.revision === store.doc.revision && draftHealth.changes === draft.changes ? draftHealth.health : (live?.health ?? null)}
        checking={checkingDraft || !!live?.checking}
        againstDraft={!!draftHealth && draftHealth.revision === store.doc.revision && draftHealth.changes === draft.changes && draft.changes > 0}
        off={!backend.enabled}
        onCheck={() => (draft.changes ? void checkDraft() : void store.check(backend.id))}
        checkLabel={draft.changes ? "Check with my changes" : undefined}
      />
      <Facts backend={backend} />
      <FieldGroups draft={draft} backend={backend} driver={driver} backends={store.doc.backends} />
      <MacsSection draft={draft} backend={backend} driver={driver} saved />
      <GuideLine driver={driver} />
      <SaveBar draft={draft} onCheck={() => void checkDraft()} checking={checkingDraft} />
      <Confirm
        open={confirmRemove}
        title={`Remove ${title}?`}
        description={
          <>
            <p>Its settings are deleted{secrets.length ? `, with its ${secrets.join(" and ")}, which BB Box cannot show or get back` : ""}. Its warm boxes are released.</p>
            <p>Threads can no longer get boxes from it. To use it again you set it up again. There is no undo.</p>
          </>
        }
        action="Remove backend"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          const latest = store.fetch();
          void store.apply({ ...latest, backends: latest.backends.filter((each) => each.id !== backend.id) }, latest.revision).then((result) => {
            if (result.ok) nav.toOverview();
          });
        }}
      />
      <AlertDialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename {title}</AlertDialogTitle>
            <AlertDialogDescription>The name BB Box shows for it. Its ID, {backend.id}, stays as it is, so nothing that uses it changes.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input aria-label="Name" className="h-8 text-sm" value={renaming ?? ""} placeholder={driver.label} onChange={(event) => setRenaming(event.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const label = renaming?.trim() ?? "";
                setRenaming(null);
                void instant.run("rename", [[`backends/${backend.id}/label`, label || undefined]], title);
              }}
            >
              Save name
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
