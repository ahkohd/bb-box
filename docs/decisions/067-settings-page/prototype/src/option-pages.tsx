import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { STANDARD_IMAGES, type Document, type ProjectImage } from "./data";
import { PageHeaderLite } from "./backend-page";
import { kindTitle, plural } from "./model";
import { useNav, type OptionPage } from "./nav";
import { useStore } from "./store";
import { Badge, Card, Icon, Rows, SaveBar, SavedTick, Section, SecretInput, SettingRow, useEditing, useInstant, type FormValue } from "./ui";

export function OptionPageView({ id }: { id: OptionPage }) {
  if (id === "boxes") return <BoxesOptions />;
  if (id === "images") return <ImagesOptions />;
  if (id === "devices") return <DevicesOptions />;
  if (id === "network") return <NetworkOptions />;
  if (id === "monitor") return <MonitorOptions />;
  return <ConfigurationOptions />;
}

function InstantRefusal({ instant }: { instant: ReturnType<typeof useInstant> }) {
  return instant.refused ? (
    <p role="alert" className="text-xs text-destructive-text">
      {instant.refused.message}
    </p>
  ) : null;
}

function BoxesOptions() {
  const store = useStore();
  const instant = useInstant();
  const { general } = store.doc;
  const onKinds = Object.entries(store.doc.kinds).filter(([, kind]) => kind.enabled).map(([id]) => id);
  const editing = useEditing<{ boxesPerThread: string }>({
    stored: { boxesPerThread: String(general.boxesPerThread) },
    part: "general",
    what: "Boxes",
    build: (doc, draft) => ({ ...doc, general: { ...doc.general, boxesPerThread: Number(draft.boxesPerThread.trim() || "0") } }),
  });
  const setGeneral = (key: string, change: Partial<Document["general"]>) => void instant.run(key, "general", (doc) => ({ ...doc, general: { ...doc.general, ...change } }));
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Boxes" description="What a thread gets, and what every box has." />
      <InstantRefusal instant={instant} />
      <Section title="For each thread">
        <Card>
          <Rows>
            <SettingRow id="general.defaultKind" label="Default kind" description="What a thread gets when it does not say.">
              <SavedTick show={instant.saved === "defaultKind"} />
              <Select value={general.defaultKind} onValueChange={(defaultKind) => setGeneral("defaultKind", { defaultKind })}>
                <SelectTrigger className="h-8 w-56 text-xs" aria-label="Default kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {onKinds.map((id) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {kindTitle(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow id="general.boxesPerThread" problemPath="general.boxesPerThread" problem={editing.problemAt("general.boxesPerThread")} label="Boxes per thread" description="The most one thread may hold at once. 0 means no limit.">
              <Input aria-label="Boxes per thread" className="h-8 w-20 text-right text-xs tabular-nums" inputMode="numeric" value={editing.draft.boxesPerThread} onChange={(event) => editing.setDraft({ boxesPerThread: event.target.value })} />
            </SettingRow>
            <SettingRow id="general.enrol" label="Boxes join BB as machines" description="Threads and terminals can then use a box, with the thread's credentials.">
              <SavedTick show={instant.saved === "enrol"} />
              <Switch aria-label="Boxes join BB as machines" checked={general.enrol} disabled={instant.pending === "enrol"} onCheckedChange={(enrol) => setGeneral("enrol", { enrol })} />
            </SettingRow>
            <SettingRow id="general.video" label="Linux desktops as video" description="CPU-drawn X11 desktops stream as video, smooth on a slow connection. A viewer can switch to VNC in its menu.">
              <SavedTick show={instant.saved === "video"} />
              <Switch aria-label="Linux desktops as video" checked={general.video} disabled={instant.pending === "video"} onCheckedChange={(video) => setGeneral("video", { video })} />
            </SettingRow>
          </Rows>
        </Card>
      </Section>
      <FilesSection />
      <SaveBar state={editing.bar} changes={editing.changes} what="Boxes" onSave={editing.save} onDiscard={editing.discard} onKeepMine={editing.keepMine} onUseSaved={editing.discard} />
    </div>
  );
}

function FilesSection() {
  const store = useStore();
  const instant = useInstant();
  const [adding, setAdding] = useState<{ path: string; content: string; replacing: string | null } | null>(null);
  const files = store.doc.general.files;
  const commit = (next: Document["general"]["files"], key: string) => void instant.run(key, "general", (doc) => ({ ...doc, general: { ...doc.general, files: next } })).then(() => setAdding(null));
  return (
    <Section
      title="Files for every box"
      description="Copied into each Linux and macOS box's home. Their contents are kept secret."
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={adding !== null} onClick={() => setAdding({ path: "", content: "", replacing: null })}>
          <Icon name="Plus" aria-hidden />
          Add file
        </Button>
      }
    >
      {files.length || adding ? (
        <Card>
          <Rows>
            {files.map((file) => (
              <div key={file.path} id="general.files" className="flex items-center gap-3 px-4 py-2.5">
                <code className="min-w-0 flex-1 truncate text-xs text-foreground">~/{file.path}</code>
                <SavedTick show={instant.saved === file.path} />
                <span className="text-xs text-subtle-foreground">{file.set ? "Set" : "Not set"}</span>
                <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setAdding({ path: file.path, content: "", replacing: file.path })}>
                  Replace
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => commit(files.filter((each) => each.path !== file.path), file.path)}>
                  Remove
                </Button>
              </div>
            ))}
            {adding ? (
              <div className="space-y-2 bg-surface-raised px-4 py-3">
                <Input aria-label="Path under the box user's home" className="h-8 font-mono text-xs" placeholder=".config/tool/settings.json" value={adding.path} disabled={adding.replacing !== null} onChange={(event) => setAdding({ ...adding, path: event.target.value })} />
                <Textarea aria-label="The file's content" className="min-h-24 font-mono text-xs" placeholder="Paste the file's text. It is never shown again." value={adding.content} onChange={(event) => setAdding({ ...adding, content: event.target.value })} />
                <div className="flex items-center gap-1.5">
                  <Button type="button" size="sm" className="h-7" disabled={!adding.path.trim() || !adding.content || instant.pending !== null} onClick={() => commit(adding.replacing ? files.map((each) => (each.path === adding.replacing ? { ...each, set: true } : each)) : [...files, { path: adding.path.trim(), set: true }], adding.path.trim())}>
                    {instant.pending ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                    Save file
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setAdding(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </Rows>
        </Card>
      ) : null}
      <InstantRefusal instant={instant} />
    </Section>
  );
}

function ImagesOptions() {
  const store = useStore();
  const instant = useInstant();
  const [rebuilding, setRebuilding] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const due = STANDARD_IMAGES.filter((image) => image.due);
  const rebuild = () => {
    setRebuilding(0);
    let at = 0;
    const timer = setInterval(() => {
      at += 1;
      setRebuilding(at);
      if (at > due.length) {
        clearInterval(timer);
        setTimeout(() => setRebuilding(null), 1200);
      }
    }, 1500);
  };
  const setImage = (image: ProjectImage, change: Partial<ProjectImage> | null) =>
    void instant.run(image.name, "images", (doc) => ({ ...doc, images: change ? doc.images.map((each) => (each.name === image.name ? { ...each, ...change } : each)) : doc.images.filter((each) => each.name !== image.name) }));
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Images" description="What new boxes start from: BB Box's standard images, and your projects' own." />
      <InstantRefusal instant={instant} />
      <Section title="Standard images" description={`${plural(due.length, "image")} due, of ${STANDARD_IMAGES.length}.`} action={<Button type="button" variant="outline" size="sm" className="h-7" disabled={rebuilding !== null || !due.length} onClick={rebuild}>{rebuilding !== null ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}{rebuilding !== null ? "Rebuilding…" : "Rebuild what is due"}</Button>}>
        <Card>
          <Rows>
            <SettingRow id="general.nightlyImages" label="Rebuild each night" description="At 03:00 on BB's server, BB Box rebuilds the images that are due. After a BB update it refreshes the Linux images within the hour.">
              <SavedTick show={instant.saved === "nightly"} />
              <Switch aria-label="Rebuild each night" checked={store.doc.general.nightlyImages} disabled={instant.pending === "nightly"} onCheckedChange={(nightlyImages) => void instant.run("nightly", "general", (doc) => ({ ...doc, general: { ...doc.general, nightlyImages } }))} />
            </SettingRow>
            {STANDARD_IMAGES.map((image) => {
              const index = due.indexOf(image);
              const state = rebuilding === null || index < 0 ? null : index < rebuilding ? "Rebuilt just now" : index === rebuilding ? "Rebuilding · step 3 of 9" : "Next";
              return (
                <div key={image.name} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{image.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot tone={state === "Rebuilding · step 3 of 9" ? "busy" : image.due && state !== "Rebuilt just now" ? "warn" : "ok"} />
                      {image.backend} · {state ?? (image.due ? `Due: ${image.due}` : image.last)}
                    </p>
                  </div>
                  <span className="text-xs text-subtle-foreground tabular-nums">{state === "Rebuilt just now" ? "now" : image.age}</span>
                </div>
              );
            })}
          </Rows>
        </Card>
      </Section>
      <Section title="Project images" description="A script run on a standard image for a project's boxes. Agents add them with bb box image set, from the project's .bb/box-setup.sh.">
        {store.doc.images.length ? (
          <Card>
            <Rows>
              {store.doc.images.map((image) => (
                <div key={image.name}>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" onClick={() => setOpen((current) => (current === image.name ? null : image.name))} aria-expanded={open === image.name}>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm text-foreground">
                          {image.name}
                          {image.projects.map((project) => (
                            <Badge key={project}>{project}</Badge>
                          ))}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {image.kinds.map(kindTitle).join(" and ")} · from {image.source} · set {image.updated}
                        </span>
                      </span>
                      <Icon name={open === image.name ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />
                    </button>
                    <SavedTick show={instant.saved === image.name} />
                    <Select value={image.bake} onValueChange={(bake) => setImage(image, { bake: bake as ProjectImage["bake"] })}>
                      <SelectTrigger className="h-7 w-40 text-xs" aria-label={`When ${image.name} is built ahead`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto" className="text-xs">
                          Built when used often
                        </SelectItem>
                        <SelectItem value="always" className="text-xs">
                          Always built ahead
                        </SelectItem>
                        <SelectItem value="never" className="text-xs">
                          Run at each start
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {open === image.name ? (
                    <div className="space-y-2 border-t border-border bg-surface-raised px-4 py-3">
                      <pre className="max-h-48 overflow-auto rounded-md bg-surface-recessed px-3 py-2 font-mono text-2xs leading-relaxed text-foreground">{image.script}</pre>
                      <div className="flex justify-end">
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setImage(image, null)}>
                          <Icon name="Trash2" aria-hidden />
                          Remove {image.name}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </Rows>
          </Card>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-6 py-5 text-center text-xs text-subtle-foreground">No project image yet.</div>
        )}
      </Section>
    </div>
  );
}

function DevicesOptions() {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const { general } = store.doc;
  const setGeneral = (key: string, change: Partial<Document["general"]>) => void instant.run(key, "general", (doc) => ({ ...doc, general: { ...doc.general, ...change } }));
  const sharing = store.doc.backends.filter((backend) => ["tart", "ssh-pool", "namespace"].includes(backend.type));
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Devices" description="iOS Simulator and Android emulator boxes: how their screens stream." />
      <InstantRefusal instant={instant} />
      <Section title="Streaming">
        <Card>
          <Rows>
            <SettingRow id="general.iosEncoder" label="iOS video encoding" description="Automatic uses a Mac's hardware encoder, and software where it has none or it fails.">
              <SavedTick show={instant.saved === "iosEncoder"} />
              <Select value={general.iosEncoder} onValueChange={(iosEncoder) => setGeneral("iosEncoder", { iosEncoder: iosEncoder as Document["general"]["iosEncoder"] })}>
                <SelectTrigger className="h-8 w-40 text-xs" aria-label="iOS video encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="text-xs">
                    Automatic
                  </SelectItem>
                  <SelectItem value="hardware" className="text-xs">
                    Hardware only
                  </SelectItem>
                  <SelectItem value="software" className="text-xs">
                    Software only
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow id="general.encoderLedger" label="Share each Mac's encoder fairly" description="The person in control of a device streams at full size first; recordings, other viewers and agents get what is left. Off, every shared iOS stream is capped at two thirds.">
              <SavedTick show={instant.saved === "encoderLedger"} />
              <Switch aria-label="Share each Mac's encoder fairly" checked={general.encoderLedger} disabled={instant.pending === "encoderLedger"} onCheckedChange={(encoderLedger) => setGeneral("encoderLedger", { encoderLedger })} />
            </SettingRow>
          </Rows>
        </Card>
      </Section>
      <Section title="Set elsewhere">
        <Card>
          <Rows>
            {sharing.map((backend) => (
              <button key={backend.id} type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-state-hover" onClick={() => nav.go({ page: "backend", id: backend.id }, `backends.${backend.id}.ios-hosts-most`)}>
                <span className="min-w-0 flex-1 text-sm text-foreground">Shared iOS hosts on {backend.type === "ssh-pool" ? "the SSH host pool" : backend.type === "tart" ? "Tart" : "Namespace"}</span>
                <Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />
              </button>
            ))}
            {["ios", "android"].map((id) => (
              <button key={id} type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-state-hover" onClick={() => nav.go({ page: "kind", id }, `kinds.${id}.spares`)}>
                <span className="min-w-0 flex-1 text-sm text-foreground">Spare {kindTitle(id)} boxes</span>
                <span className="text-xs text-muted-foreground">{store.doc.kinds[id]?.spares ? plural(store.doc.kinds[id]!.spares, "spare") : "None"}</span>
                <Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />
              </button>
            ))}
          </Rows>
        </Card>
      </Section>
      <Section title="For testing">
        <Card>
          <SettingRow id="general.testDevice" label="Test device" description="Linux and macOS boxes offer a test card in place of a phone, to check the device path without a simulator or emulator.">
            <SavedTick show={instant.saved === "testDevice"} />
            <Switch aria-label="Test device" checked={general.testDevice} disabled={instant.pending === "testDevice"} onCheckedChange={(testDevice) => setGeneral("testDevice", { testDevice })} />
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}

function NetworkOptions() {
  const store = useStore();
  const { tailnet } = store.doc.general;
  const editing = useEditing<{ mode: "off" | "oauth"; tags: string; clientId: FormValue; clientSecret: FormValue }>({
    stored: { mode: tailnet.mode, tags: tailnet.tags, clientId: { set: tailnet.clientId }, clientSecret: { set: tailnet.clientSecret } },
    part: "general",
    what: "Network",
    build: (doc, draft) => ({ ...doc, general: { ...doc.general, tailnet: { mode: draft.mode, tags: draft.tags, clientId: draft.clientId !== null && (typeof draft.clientId === "string" ? !!draft.clientId : (draft.clientId as { set: boolean }).set), clientSecret: draft.clientSecret !== null && (typeof draft.clientSecret === "string" ? !!draft.clientSecret : (draft.clientSecret as { set: boolean }).set) } } }),
  });
  const { draft, setDraft } = editing;
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Network" description="How machines BB Box makes reach BB." />
      <Section title="Tailnet" description="When BB is on a Tailscale tailnet, machines BB Box makes, such as cloud Macs, join it with a single-use key.">
        <Card>
          <Rows>
            <SettingRow id="general.tailnet" label="Join machines to the tailnet">
              <Select value={draft.mode} onValueChange={(mode) => setDraft((current) => ({ ...current, mode: mode as "off" | "oauth" }))}>
                <SelectTrigger className="h-8 w-64 text-xs" aria-label="Join machines to the tailnet">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off" className="text-xs">
                    No: BB is reached without one
                  </SelectItem>
                  <SelectItem value="oauth" className="text-xs">
                    Yes, with a Tailscale OAuth client
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            {draft.mode === "oauth" ? (
              <>
                <SettingRow label="Tags" description="The machines join with these tags. The OAuth client must own them.">
                  <Input aria-label="Tags" className="h-8 w-64 text-xs" value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} />
                </SettingRow>
                <SettingRow label="OAuth client ID" chips={<Badge>secret</Badge>}>
                  <SecretInput label="OAuth client ID" value={draft.clientId} onChange={(clientId) => setDraft((current) => ({ ...current, clientId }))} />
                </SettingRow>
                <SettingRow label="OAuth client secret" chips={<Badge>secret</Badge>}>
                  <SecretInput label="OAuth client secret" value={draft.clientSecret} onChange={(clientSecret) => setDraft((current) => ({ ...current, clientSecret }))} />
                </SettingRow>
              </>
            ) : null}
          </Rows>
        </Card>
      </Section>
      <SaveBar state={editing.bar} changes={editing.changes} what="Network" onSave={editing.save} onDiscard={editing.discard} onKeepMine={editing.keepMine} onUseSaved={editing.discard} />
    </div>
  );
}

function MonitorOptions() {
  const store = useStore();
  const instant = useInstant();
  const { monitor } = store.doc;
  const editing = useEditing<{ seconds: string }>({
    stored: { seconds: String(monitor.refreshIntervalSeconds) },
    part: "monitor",
    what: "Monitor",
    build: (doc, draft) => ({ ...doc, monitor: { ...doc.monitor, refreshIntervalSeconds: Number(draft.seconds.trim()) } }),
  });
  const setMonitor = (key: string, change: Partial<Document["monitor"]>) => void instant.run(key, "monitor", (doc) => ({ ...doc, monitor: { ...doc.monitor, ...change } }));
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Monitor" description="Machine status in BB's sidebar footer, for BB's server, your machines and every box." />
      <InstantRefusal instant={instant} />
      <Card>
        <Rows>
          <SettingRow id="monitor.enabled" label="Machine status" description="Off, nothing of the Monitor runs. The sidebar's entry comes or goes when BB next loads the page.">
            <SavedTick show={instant.saved === "enabled"} />
            <Switch aria-label="Machine status" checked={monitor.enabled} disabled={instant.pending === "enabled"} onCheckedChange={(enabled) => setMonitor("enabled", { enabled })} />
          </SettingRow>
          <SettingRow id="monitor.refreshIntervalSeconds" problemPath="monitor.refreshIntervalSeconds" problem={editing.problemAt("monitor.refreshIntervalSeconds")} label="Refresh every" description="Seconds between readings while machine status is open, 2 to 60.">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Input aria-label="Refresh every, in seconds" disabled={!monitor.enabled} className="h-8 w-16 text-right text-xs tabular-nums" inputMode="numeric" value={editing.draft.seconds} onChange={(event) => editing.setDraft({ seconds: event.target.value })} />s
            </span>
          </SettingRow>
          <SettingRow id="monitor.backgroundMonitoring" label="Background monitoring" description="Checks BB's server's CPU and memory every 30 s while nobody looks, and keeps logs for bb box monitor logs.">
            <SavedTick show={instant.saved === "background"} />
            <Switch aria-label="Background monitoring" checked={monitor.backgroundMonitoring} disabled={!monitor.enabled || instant.pending === "background"} onCheckedChange={(backgroundMonitoring) => setMonitor("background", { backgroundMonitoring })} />
          </SettingRow>
          <SettingRow id="monitor.pressureNotifications" label="Pressure notifications" description={monitor.backgroundMonitoring ? "A notice in BB when CPU or memory stays high for a minute, and when it recovers." : "Needs background monitoring."}>
            <SavedTick show={instant.saved === "pressure"} />
            <Switch aria-label="Pressure notifications" checked={monitor.pressureNotifications} disabled={!monitor.enabled || !monitor.backgroundMonitoring || instant.pending === "pressure"} onCheckedChange={(pressureNotifications) => setMonitor("pressure", { pressureNotifications })} />
          </SettingRow>
        </Rows>
      </Card>
      <SaveBar state={editing.bar} changes={editing.changes} what="Monitor" onSave={editing.save} onDiscard={editing.discard} onKeepMine={editing.keepMine} onUseSaved={() => editing.useSaved({ seconds: String(store.doc.monitor.refreshIntervalSeconds) })} />
    </div>
  );
}

function ConfigurationOptions() {
  const store = useStore();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeaderLite title="Configuration" description="Everything on these pages is one checked file. Every save makes a new revision." />
      <Card>
        <Rows>
          <SettingRow label={`Revision ${store.doc.revision}`} description="A save made from an older revision is refused, so two people never overwrite each other unseen.">
            <span />
          </SettingRow>
          <SettingRow id="configuration.export" label="Export" description="The whole configuration as JSON, with no secret in it. Keep it to set BB Box up again.">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                void navigator.clipboard?.writeText(JSON.stringify(store.doc, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              <Icon name={copied ? "Check" : "Copy"} aria-hidden />
              {copied ? "Copied" : "Copy as JSON"}
            </Button>
          </SettingRow>
          <SettingRow id="configuration.import" label="Import" description="Apply a JSON file as the whole configuration. BB Box checks it first and lists what it changes before anything is saved.">
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => window.alert("Opens a file, checks it with config.check, lists what it changes, then asks before it applies.")}>
              <Icon name="Upload" aria-hidden />
              Choose file…
            </Button>
          </SettingRow>
          <SettingRow label="Settings moved from BB" description="BB Box kept a copy of BB's own settings for it when it moved them here. Remove it once you no longer need it.">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => window.alert("Removes the copy, as bb box config migrated --remove does.")}>
              Remove copy
            </Button>
          </SettingRow>
        </Rows>
      </Card>
      <Section title="From a terminal">
        <Card className="px-4 py-3">
          <ul className={cn("space-y-1.5 font-mono text-2xs leading-relaxed text-foreground")}>
            <li>bb box config show --json <span className="font-sans text-subtle-foreground">· print it</span></li>
            <li>bb box config check file.json --test <span className="font-sans text-subtle-foreground">· check a file and its backends</span></li>
            <li>bb box config apply file.json <span className="font-sans text-subtle-foreground">· save it</span></li>
            <li>bb box doctor <span className="font-sans text-subtle-foreground">· check every backend</span></li>
          </ul>
        </Card>
      </Section>
    </div>
  );
}
