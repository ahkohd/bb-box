import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import type { Document, ProjectImage } from "./data";
import { kindName, plural } from "./model";
import { useNav, type OptionPage } from "./nav";
import { imagesFor, LostReply, useStore } from "./store";
import { useDraft, useInstant, type Draft } from "./drafts";
import { same } from "./paths";
import { ReloadNote } from "./overview";
import { Badge, Card, ConflictNote, Confirm, FOCUS_RING, Icon, PageHeader, RestoredNote, Rows, SaveBar, SaveRule, SavedTick, Section, SecretInput, SettingRow, useRowIds } from "./ui";

export function OptionPageView({ id }: { id: OptionPage }) {
  if (id === "boxes") return <BoxesOptions />;
  if (id === "images") return <ImagesOptions />;
  if (id === "devices") return <DevicesOptions />;
  if (id === "network") return <NetworkOptions />;
  if (id === "monitor") return <MonitorOptions />;
  return <ConfigurationOptions />;
}

function Refusal({ instant }: { instant: ReturnType<typeof useInstant> }) {
  return instant.refused ? (
    <p role="alert" className="text-xs text-destructive-text">
      {instant.refused.message}
    </p>
  ) : null;
}

function NumberField({ draft, path, label, suffix, disabled }: { draft: Draft; path: string; label: string; suffix?: string; disabled?: boolean }) {
  const ids = useRowIds();
  const value = draft.value(path);
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Input id={ids?.controlId} aria-describedby={ids?.describedBy || undefined} aria-invalid={ids?.invalid || undefined} aria-label={label} disabled={disabled} className={cn("h-8 w-20 text-right text-xs tabular-nums", draft.edited(path) && "border-warning/60")} inputMode="numeric" value={value === undefined || value === null ? "" : String(value)} onChange={(event) => draft.set(path, event.target.value.trim() && Number.isFinite(Number(event.target.value)) ? Number(event.target.value) : event.target.value)} />
      {suffix}
    </span>
  );
}

function DraftRow({ draft, path, label, help, children }: { draft: Draft; path: string; label: string; help?: string; children: React.ReactNode }) {
  const conflict = draft.conflictAt(path);
  return (
    <SettingRow id={path} label={label} help={help} problem={draft.problemAt(path)} focus={draft.focusPath === path} onFocused={draft.clearFocus} chips={draft.edited(path) && !conflict ? <Badge tone="warn">Changed</Badge> : null} conflict={conflict ? <ConflictNote saved={conflict.saved} onUseSaved={() => draft.useSaved(path)} onKeepMine={() => draft.keepMine(path)} /> : null}>
      {children}
    </SettingRow>
  );
}

function BoxesOptions() {
  const store = useStore();
  const instant = useInstant();
  const { general } = store.doc;
  const onKinds = Object.entries(store.doc.kinds).filter(([, kind]) => kind.enabled).map(([id]) => id);
  const draft = useDraft({ part: "general/boxes", what: "Boxes" });
  const set = (key: string, path: string, value: unknown, what: string) => void instant.run(key, [[path, value]], what);
  const pending = (key: string, stored: unknown) => (instant.pendingValue(key) !== undefined ? instant.pendingValue(key) : stored);
  return (
    <div className="space-y-6">
      <PageHeader title="Boxes" description="What a thread gets, and what every box has." note={<SaveRule />} />
      <RestoredNote draft={draft} />
      <Refusal instant={instant} />
      <Section title="For each thread">
        <Card>
          <Rows>
            <SettingRow id="general/defaultKind" label="Default kind" help="What a thread gets when it does not say. Only kinds that are on can be the default.">
              <SavedTick show={instant.saved === "defaultKind"} />
              <Select value={String(pending("defaultKind", general.defaultKind))} onValueChange={(defaultKind) => set("defaultKind", "general/defaultKind", defaultKind, "The default kind")}>
                <SelectTrigger className="h-8 w-full text-xs sm:w-64" aria-label="Default kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {onKinds.map((id) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {kindName(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <DraftRow draft={draft} path="general/boxesPerThread" label="Boxes per thread" help="The most one thread may hold at once. 0 means no limit.">
              <NumberField draft={draft} path="general/boxesPerThread" label="Boxes per thread" />
            </DraftRow>
            <SettingRow id="general/enrol" label="Boxes join BB as machines" help="Threads and terminals can then use a box, with the thread's credentials.">
              <SavedTick show={instant.saved === "enrol"} />
              <Switch aria-label="Boxes join BB as machines" checked={pending("enrol", general.enrol) as boolean} disabled={instant.pending === "enrol"} onCheckedChange={(enrol) => set("enrol", "general/enrol", enrol, "Joining BB")} />
            </SettingRow>
            <SettingRow id="general/video" label="Linux desktops as video" help="CPU-drawn X11 desktops stream as video, smooth on a slow connection. A viewer can switch to VNC in its menu.">
              <SavedTick show={instant.saved === "video"} />
              <Switch aria-label="Linux desktops as video" checked={pending("video", general.video) as boolean} disabled={instant.pending === "video"} onCheckedChange={(video) => set("video", "general/video", video, "Video")} />
            </SettingRow>
          </Rows>
        </Card>
      </Section>
      <FilesSection />
      <SaveBar draft={draft} />
    </div>
  );
}

const fileDrafts = new Map<string, { path: string; content: string; replacing: string | null }>();

function FilesSection() {
  const store = useStore();
  const [editing, setEditingState] = useState(() => fileDrafts.get("files") ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const setEditing = (next: typeof editing) => {
    if (next) fileDrafts.set("files", next);
    else fileDrafts.delete("files");
    setEditingState(next);
  };
  const files = store.doc.general.files;
  const write = async (change: (doc: Document) => Document, secrets: Record<string, string | null>, check: (doc: Document) => boolean, label: string) => {
    setBusy(true);
    setMessage(null);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latest = store.fetch();
        try {
          const result = await store.apply(change(latest), latest.revision, secrets);
          if (result.ok) break;
          if (result.reason === "revision") continue;
          setMessage(result.reason === "problems" ? result.problems.map((problem) => problem.message).join(" ") : `Not saved: ${result.message} Your text is still here.`);
          return false;
        } catch (error) {
          if (!(error instanceof LostReply)) throw error;
          if (!check(store.fetch())) {
            setMessage("Save not confirmed, and the file is not in the configuration. Your text is still here: save again.");
            return false;
          }
          break;
        }
      }
      setSaved(label);
      setTimeout(() => setSaved(null), 1600);
      return true;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Files for every box"
      description="Copied into each Linux and macOS box's home when it is made. Contents are kept secret and never shown again."
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={editing !== null} onClick={() => setEditing({ path: "", content: "", replacing: null })}>
          <Icon name="Plus" aria-hidden />
          Add file
        </Button>
      }
    >
      {files.length || editing ? (
        <Card>
          <Rows>
            {files.map((file) => (
              <div key={file.path} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <code className="min-w-0 flex-1 truncate text-xs text-foreground">~/{file.path}</code>
                <SavedTick show={saved === file.path} />
                <span className="text-xs text-subtle-foreground">{file.content.set ? "Set" : "Not set"}</span>
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={editing !== null} onClick={() => setEditing({ path: file.path, content: "", replacing: file.path })}>
                  Replace…
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setRemoving(file.path)}>
                  Remove…
                </Button>
              </div>
            ))}
            {editing ? (
              <div className="space-y-2 bg-surface-raised px-4 py-3">
                <p className="text-xs font-medium text-foreground">{editing.replacing ? `New content for ~/${editing.replacing}` : "A new file"}</p>
                <Input aria-label="Path under the box user's home" className="h-8 font-mono text-xs" placeholder=".config/tool/settings.json" value={editing.path} disabled={editing.replacing !== null} onChange={(event) => setEditing({ ...editing, path: event.target.value })} />
                <Textarea aria-label="The file's content" className="min-h-24 font-mono text-xs" placeholder="Paste the file's text. It is never shown again." value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} />
                {message ? (
                  <p role="alert" className="text-xs text-destructive-text">
                    {message}
                  </p>
                ) : null}
                <p className="text-2xs text-subtle-foreground">Boxes made from now on get it; boxes already made keep what they have.</p>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    disabled={busy || !editing.path.trim() || !editing.content}
                    onClick={async () => {
                      const path = editing.path.trim();
                      const before = files.find((file) => file.path === path)?.content.version;
                      const ok = await write(
                        (doc) => ({ ...doc, general: { ...doc.general, files: editing.replacing ? doc.general.files : [...doc.general.files, { path, content: { set: true, version: "pending" } }] } }),
                        { [`general/files/${path}`]: editing.content },
                        (doc) => doc.general.files.some((file) => file.path === path && file.content.set && file.content.version !== before),
                        path,
                      );
                      if (ok) setEditing(null);
                    }}
                  >
                    {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
                    Save file
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </Rows>
        </Card>
      ) : null}
      {message && !editing ? (
        <p role="alert" className="text-xs text-destructive-text">
          {message}
        </p>
      ) : null}
      <Confirm
        open={removing !== null}
        title={`Remove ~/${removing}?`}
        description={
          <>
            <p>Boxes made from now on no longer get it. Boxes already made keep their copy.</p>
            <p>Its content is deleted from BB Box and cannot be shown or got back; to use it again, paste it again.</p>
          </>
        }
        action="Remove file"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const path = removing;
          setRemoving(null);
          void write((doc) => ({ ...doc, general: { ...doc.general, files: doc.general.files.filter((file) => file.path !== path) } }), {}, (doc) => !doc.general.files.some((file) => file.path === path), path ?? "");
        }}
      />
    </Section>
  );
}

const RUN_WORDS: Record<string, string> = { refreshed: "Rebuilt", failed: "Failed", waiting: "Waited for room", skipped: "Skipped", "not started": "Not started" };

function ImagesOptions() {
  const store = useStore();
  const instant = useInstant();
  const [run, setRun] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectImage | null>(null);
  const [imageSaved, setImageSaved] = useState<string | null>(null);
  const images = imagesFor(store.scenario);
  const due = images.filter((image) => image.due);
  const rebuild = () => {
    setRun(0);
    let at = 0;
    const timer = setInterval(() => {
      at += 1;
      setRun(at);
      if (at > due.length) clearInterval(timer);
    }, 1500);
  };
  const runState = (index: number) => {
    if (run === null || index < 0) return null;
    if (index < run) return index === 1 ? "Waits: docker-1 has no room now; tonight's run tries again" : "Rebuilt just now, and its trial box passed";
    if (index === run) return "Rebuilding · step 3 of 9";
    return "Next";
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Images" description="What new boxes start from: BB Box's standard images, and your projects' own." />
      <Refusal instant={instant} />
      <Section title="Standard images" description={`${plural(due.length, "image")} due, of ${images.length}. Last night's run: ${images.filter((image) => image.lastState === "refreshed").length} rebuilt, ${images.filter((image) => image.lastState === "waiting").length} waited for room, ${images.filter((image) => image.lastState === "failed").length} failed, ${images.filter((image) => image.lastState === "skipped").length} skipped.`}>
        <Card>
          <Rows>
            <SettingRow id="general/nightlyImages" label="Rebuild each night" help="At 03:00 on BB's server, BB Box rebuilds the images that are due, and replaces each only when its trial box passes. After a BB update it refreshes the Linux images within the hour.">
              <SavedTick show={instant.saved === "nightly"} />
              <Switch aria-label="Rebuild each night" checked={(instant.pendingValue("nightly") ?? store.doc.general.nightlyImages) as boolean} disabled={instant.pending === "nightly"} onCheckedChange={(nightlyImages) => void instant.run("nightly", [["general/nightlyImages", nightlyImages]], "The nightly rebuild")} />
            </SettingRow>
            {images.map((image) => {
              const state = runState(due.indexOf(image));
              const tone = state?.startsWith("Rebuilding") ? "busy" : state?.startsWith("Waits") ? "warn" : state?.startsWith("Rebuilt") ? "ok" : image.lastState === "failed" ? "bad" : image.due ? "warn" : "ok";
              return (
                <div key={image.name} className="flex flex-wrap items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{image.name}</p>
                    <p className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                      <StatusDot tone={tone} />
                      <span className={cn(tone === "bad" && "text-destructive-text")}>
                        {image.backend} · {state ?? (image.due ? `Due: ${image.due}. ${image.last}` : image.last)}
                      </span>
                    </p>
                  </div>
                  <span className="text-xs text-subtle-foreground tabular-nums">{image.age} old</span>
                </div>
              );
            })}
          </Rows>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="h-7" disabled={(run !== null && run <= due.length) || !due.length} onClick={rebuild}>
            {run !== null && run <= due.length ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="Refresh" aria-hidden />}
            {run !== null && run <= due.length ? `Rebuilding ${Math.min(run + 1, due.length)} of ${due.length}…` : "Rebuild what is due"}
          </Button>
          <span className="text-xs text-subtle-foreground">{run !== null && run > due.length ? "Done: 1 rebuilt, 1 waits for room." : "One at a time; it goes on if you leave this page."}</span>
        </div>
      </Section>
      <Section title="Project images" description="A script run on a standard image, for one project's boxes. Agents set them with bb box image set, from the project's .bb/box-setup.sh.">
        {store.doc.images.length ? (
          <Card>
            <Rows>
              {store.doc.images.map((image) => (
                <div key={image.name}>
                  <div className="flex flex-wrap items-center gap-3 pr-4">
                    <button type="button" className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-4 text-left", FOCUS_RING)} onClick={() => setOpen((current) => (current === image.name ? null : image.name))} aria-expanded={open === image.name}>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                          {image.name}
                          {image.projects.map((project) => (
                            <Badge key={project}>{project}</Badge>
                          ))}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {image.kinds.map(kindName).join(" and ")} · {image.builds}
                        </span>
                      </span>
                      <Icon name={open === image.name ? "ChevronDown" : "ChevronRight"} className="size-4 text-subtle-foreground" aria-hidden />
                    </button>
                    <SavedTick show={imageSaved === image.name} />
                    <Select
                      value={image.bake}
                      onValueChange={(bake) =>
                        void applyImages(store, (images) => images.map((each) => (each.name === image.name ? { ...each, bake: bake as ProjectImage["bake"] } : each))).then(() => {
                          setImageSaved(image.name);
                          setTimeout(() => setImageSaved(null), 1600);
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-44 text-xs" aria-label={`When ${image.name} is built ahead`}>
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
                          Run at each box's start
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {open === image.name ? (
                    <div className="space-y-2 border-t border-border bg-surface-raised px-4 py-3">
                      <p className="text-xs text-muted-foreground">From {image.source}, set {image.updated}.</p>
                      <p className="text-2xs font-medium text-subtle-foreground">Script, run as root</p>
                      <pre className="max-h-48 overflow-auto rounded-md bg-surface-recessed px-3 py-2 font-mono text-2xs leading-relaxed text-foreground">{image.script}</pre>
                      <p className="text-2xs font-medium text-subtle-foreground">Check, run as the box user; the image fails when it fails</p>
                      <pre className="overflow-auto rounded-md bg-surface-recessed px-3 py-2 font-mono text-2xs leading-relaxed text-foreground">{image.check}</pre>
                      <div className="flex justify-end">
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setRemoving(image)}>
                          <Icon name="Trash2" aria-hidden />
                          Remove {image.name}…
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
      <Confirm
        open={removing !== null}
        title={`Remove the project image ${removing?.name}?`}
        description={
          <>
            <p>New boxes of {removing?.kinds.map(kindName).join(" and ")} in {removing?.projects.join(", ")} start from the standard image again, without its script. Its built images are deleted.</p>
            <p>Boxes already made keep what they have. An agent can set it again from the project's files.</p>
          </>
        }
        action="Remove image"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const name = removing?.name;
          setRemoving(null);
          void applyImages(store, (images) => images.filter((each) => each.name !== name));
        }}
      />
    </div>
  );
}

async function applyImages(store: ReturnType<typeof useStore>, change: (images: readonly ProjectImage[]) => readonly ProjectImage[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = store.fetch();
    try {
      const result = await store.apply({ ...latest, images: change(latest.images) }, latest.revision);
      if (result.ok || result.reason !== "revision") return;
    } catch (error) {
      if (error instanceof LostReply) return;
      throw error;
    }
  }
}

function DevicesOptions() {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const { general } = store.doc;
  const pending = (key: string, stored: unknown) => (instant.pendingValue(key) !== undefined ? instant.pendingValue(key) : stored);
  const sharing = store.doc.backends.filter((backend) => ["tart", "ssh-pool", "namespace"].includes(backend.type));
  return (
    <div className="space-y-6">
      <PageHeader title="Devices" description="iOS Simulator and Android emulator boxes: how their screens stream." />
      <Refusal instant={instant} />
      <Section title="Streaming">
        <Card>
          <Rows>
            <SettingRow id="general/iosEncoder" label="iOS video encoding" help="Automatic uses a Mac's hardware encoder, and software where it has none or it fails. A box takes a change when its device server is next delivered.">
              <SavedTick show={instant.saved === "iosEncoder"} />
              <Select value={String(pending("iosEncoder", general.iosEncoder))} onValueChange={(iosEncoder) => void instant.run("iosEncoder", [["general/iosEncoder", iosEncoder]], "iOS video encoding")}>
                <SelectTrigger className="h-8 w-full text-xs sm:w-44" aria-label="iOS video encoding">
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
            <SettingRow id="general/encoderLedger" label="Share each Mac's encoder fairly" help="The person in control of a device streams at full size first; recordings, other viewers and agents get what is left. Off, every shared iOS stream is capped at two thirds.">
              <SavedTick show={instant.saved === "encoderLedger"} />
              <Switch aria-label="Share each Mac's encoder fairly" checked={pending("encoderLedger", general.encoderLedger) as boolean} disabled={instant.pending === "encoderLedger"} onCheckedChange={(encoderLedger) => void instant.run("encoderLedger", [["general/encoderLedger", encoderLedger]], "Encoder sharing")} />
            </SettingRow>
          </Rows>
        </Card>
      </Section>
      <Section title="Set on other pages">
        <Card>
          <Rows>
            {sharing.map((backend) => (
              <button key={backend.id} type="button" className={cn("flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-state-hover", FOCUS_RING)} onClick={() => nav.go({ page: "backend", id: backend.id }, { found: `backends/${backend.id}/fields/${backend.type === "tart" || backend.type === "namespace" ? "ios-hosts-on" : "ios-hosts-most"}` })}>
                <span className="min-w-0 flex-1 text-sm text-foreground">Shared iOS hosts on {backend.type === "ssh-pool" ? "the SSH host pool" : backend.type === "tart" ? "Tart" : "Namespace"}</span>
                <Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />
              </button>
            ))}
            {["ios", "android"].map((id) => (
              <button key={id} type="button" className={cn("flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-state-hover", FOCUS_RING)} onClick={() => nav.go({ page: "kind", id }, { found: `kinds/${id}/spares` })}>
                <span className="min-w-0 flex-1 text-sm text-foreground">Spare {kindName(id)} boxes</span>
                <span className="text-xs text-muted-foreground">{store.doc.kinds[id]?.spares ? plural(store.doc.kinds[id]!.spares, "spare") : "None, as by default"}</span>
                <Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />
              </button>
            ))}
          </Rows>
        </Card>
      </Section>
      <Section title="For testing">
        <Card>
          <SettingRow id="general/testDevice" label="Test device" help="Linux and macOS boxes offer a test card in place of a phone, to check the device path without a simulator or emulator.">
            <SavedTick show={instant.saved === "testDevice"} />
            <Switch aria-label="Test device" checked={pending("testDevice", general.testDevice) as boolean} disabled={instant.pending === "testDevice"} onCheckedChange={(testDevice) => void instant.run("testDevice", [["general/testDevice", testDevice]], "The test device")} />
          </SettingRow>
        </Card>
      </Section>
    </div>
  );
}

function NetworkOptions() {
  const draft = useDraft({ part: "general/tailnet", what: "the tailnet", secretPaths: new Set(["general/tailnet/clientId", "general/tailnet/clientSecret"]), label: (path) => (path.endsWith("clientId") ? "OAuth client ID" : "OAuth client secret") });
  const mode = draft.value("general/tailnet/mode");
  return (
    <div className="space-y-6">
      <PageHeader title="Network" description="How machines BB Box makes reach BB." note={<SaveRule />} />
      <RestoredNote draft={draft} />
      <Section title="Tailnet" description="When BB is on a Tailscale tailnet, machines BB Box makes, such as cloud Macs, join it with a single-use key. These settings are saved together.">
        <Card>
          <Rows>
            <DraftRow draft={draft} path="general/tailnet/mode" label="Join machines to the tailnet">
              <span role="radiogroup" aria-label="Join machines to the tailnet" className="flex flex-col gap-1.5 text-xs text-foreground">
                <label className="flex items-center gap-2">
                  <input type="radio" name="tailnet-mode" checked={mode === "off"} onChange={() => draft.set("general/tailnet/mode", "off")} className="size-3.5 accent-foreground" />
                  No: BB is reached without one
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="tailnet-mode" checked={mode === "oauth"} onChange={() => draft.set("general/tailnet/mode", "oauth")} className="size-3.5 accent-foreground" />
                  Yes, with a Tailscale OAuth client
                </label>
              </span>
            </DraftRow>
            {mode === "oauth" ? (
              <>
                <DraftRow draft={draft} path="general/tailnet/tags" label="Tags" help="The machines join with these tags. The OAuth client must own them.">
                  <Input aria-label="Tags" className="h-8 w-full text-xs sm:w-72" value={String(draft.value("general/tailnet/tags") ?? "")} onChange={(event) => draft.set("general/tailnet/tags", event.target.value)} />
                </DraftRow>
                {(["clientId", "clientSecret"] as const).map((key) => {
                  const path = `general/tailnet/${key}`;
                  const conflict = draft.conflictAt(path);
                  return (
                    <SettingRow key={key} id={path} label={key === "clientId" ? "OAuth client ID" : "OAuth client secret"} chips={<Badge>secret</Badge>} problem={draft.problemAt(path)} focus={draft.focusPath === path} onFocused={draft.clearFocus} conflict={conflict ? <ConflictNote secret saved={conflict.saved} onUseSaved={() => draft.useSaved(path)} onKeepMine={() => draft.keepMine(path)} /> : null}>
                      <SecretInput label={key === "clientId" ? "OAuth client ID" : "OAuth client secret"} value={draft.value(path)} stored={draft.stored(path)} onChange={(value) => draft.set(path, value)} />
                    </SettingRow>
                  );
                })}
              </>
            ) : null}
          </Rows>
        </Card>
      </Section>
      <SaveBar draft={draft} />
    </div>
  );
}

function MonitorOptions() {
  const store = useStore();
  const instant = useInstant();
  const { monitor } = store.doc;
  const draft = useDraft({ part: "monitor", what: "the Monitor" });
  const pending = (key: string, stored: unknown) => (instant.pendingValue(key) !== undefined ? instant.pendingValue(key) : stored);
  const on = pending("enabled", monitor.enabled) as boolean;
  return (
    <div className="space-y-6">
      <PageHeader title="Monitor" description="Machine status in BB's sidebar footer, for BB's server, your machines and every box." note={<SaveRule />} />
      <RestoredNote draft={draft} />
      <Refusal instant={instant} />
      <Card>
        <Rows>
          <SettingRow id="monitor/enabled" label="Machine status" help="Off, nothing of the Monitor runs: no sampling, background monitoring or Mac sensors helper.">
            <SavedTick show={instant.saved === "enabled"} />
            <Switch aria-label="Machine status" checked={on} disabled={instant.pending === "enabled"} onCheckedChange={(enabled) => void instant.run("enabled", [["monitor/enabled", enabled]], "The Monitor")} />
          </SettingRow>
          <DraftRow draft={draft} path="monitor/refreshIntervalSeconds" label="Refresh every" help="Seconds between readings while machine status is open, 2 to 60.">
            <NumberField draft={draft} path="monitor/refreshIntervalSeconds" label="Refresh every, in seconds" suffix="s" disabled={!on} />
          </DraftRow>
          <SettingRow id="monitor/backgroundMonitoring" label="Background monitoring" help="Checks BB's server's CPU and memory every 30 s while nobody looks, and keeps logs for bb box monitor logs.">
            <SavedTick show={instant.saved === "background"} />
            <Switch aria-label="Background monitoring" checked={pending("background", monitor.backgroundMonitoring) as boolean} disabled={!on || instant.pending === "background"} onCheckedChange={(value) => void instant.run("background", [["monitor/backgroundMonitoring", value]], "Background monitoring")} />
          </SettingRow>
          <SettingRow id="monitor/pressureNotifications" label="Pressure notifications" help={monitor.backgroundMonitoring ? "A notice in BB when CPU or memory stays high for a minute, and when it recovers." : "Needs background monitoring."}>
            <SavedTick show={instant.saved === "pressure"} />
            <Switch aria-label="Pressure notifications" checked={pending("pressure", monitor.pressureNotifications) as boolean} disabled={!on || !monitor.backgroundMonitoring || instant.pending === "pressure"} onCheckedChange={(value) => void instant.run("pressure", [["monitor/pressureNotifications", value]], "Pressure notifications")} />
          </SettingRow>
        </Rows>
      </Card>
      {store.monitorChanged ? <ReloadNote /> : null}
      <SaveBar draft={draft} />
    </div>
  );
}

function diffPaths(from: unknown, to: unknown, prefix = ""): string[] {
  if (same(from, to)) return [];
  if (typeof from !== "object" || typeof to !== "object" || from === null || to === null || Array.isArray(from) || Array.isArray(to)) return [prefix || "the whole file"];
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...keys].filter((key) => key !== "revision").flatMap((key) => diffPaths((from as Record<string, unknown>)[key], (to as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
}

function ConfigurationOptions() {
  const store = useStore();
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState<{ text: string; parsed: Document | null; error: string | null; changes: string[]; revision: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [removeCopy, setRemoveCopy] = useState(false);
  const check = (text: string) => {
    try {
      const parsed = JSON.parse(text) as Document;
      const latest = store.fetch();
      const backends = parsed.backends?.map((backend) => backend.id) ?? [];
      setImporting({ text, parsed, error: null, changes: diffPaths(latest, { ...latest, ...parsed, backends: parsed.backends ?? latest.backends }).map((path) => path.replace(/^backends\.(\d+)/, (_, index) => `backend ${backends[Number(index)] ?? index}`)), revision: latest.revision });
    } catch {
      setImporting({ text, parsed: null, error: "This is not a configuration file: it is not valid JSON.", changes: [], revision: store.doc.revision });
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Configuration" description="Everything on these pages is one checked file. Every save makes a new revision." />
      <Card>
        <Rows>
          <SettingRow label={`Revision ${store.doc.revision}`} help="Each save names the revision it was made from. When someone saved first, the page checks your changes against theirs: changes to other settings are kept and yours go on top; a setting changed both ways asks you which to keep.">
            <span />
          </SettingRow>
          <SettingRow id="configuration/export" label="Export" help="The whole configuration as JSON, with no secret in it. To set BB Box up again from it, paste the tokens, keys and file contents again: the export says which.">
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
          <SettingRow id="configuration/import" label="Import" help="Apply a JSON file as the whole configuration. BB Box checks it and lists what it changes before anything is saved.">
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setImporting({ text: JSON.stringify({ ...store.doc, monitor: { ...store.doc.monitor, refreshIntervalSeconds: 15 } }, null, 2), parsed: null, error: null, changes: [], revision: store.doc.revision })}>
              <Icon name="Upload" aria-hidden />
              Paste a file…
            </Button>
          </SettingRow>
          {store.doc.migrated ? (
            <SettingRow label="Settings moved from BB" help={`BB Box kept a copy of BB's own settings for it when it moved them here on ${store.doc.migrated}. Remove it once you no longer need it.`}>
              <Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setRemoveCopy(true)}>
                Remove copy…
              </Button>
            </SettingRow>
          ) : null}
        </Rows>
      </Card>
      {importing ? (
        <Card className="space-y-2 px-4 py-3">
          <p className="text-xs font-medium text-foreground">Import a configuration</p>
          <Textarea aria-label="Configuration JSON" className="min-h-40 font-mono text-2xs" value={importing.text} onChange={(event) => setImporting({ ...importing, text: event.target.value, parsed: null, changes: [] })} />
          {importing.error ? (
            <p role="alert" className="text-xs text-destructive-text">
              {importing.error}
            </p>
          ) : null}
          {importing.parsed ? (
            <div className="text-xs" role="status">
              {importing.changes.length ? (
                <>
                  <p className="text-foreground">It changes {plural(importing.changes.length, "setting")} against revision {importing.revision}:</p>
                  <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                    {importing.changes.slice(0, 12).map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted-foreground">It changes nothing.</p>
              )}
            </div>
          ) : null}
          {result ? <p role="status" className="text-xs text-foreground">{result}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => check(importing.text)}>
              Check it
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7"
              disabled={!importing.parsed || !importing.changes.length}
              onClick={async () => {
                if (store.fetch().revision !== importing.revision) {
                  setResult("The configuration changed since you checked the file. Check it again to see what it changes now.");
                  setImporting({ ...importing, parsed: null, changes: [] });
                  return;
                }
                const latest = store.fetch();
                const outcome = await store.apply({ ...latest, ...importing.parsed!, revision: latest.revision }, importing.revision).catch(() => null);
                setResult(outcome?.ok ? `Imported: revision ${outcome.revision}.` : outcome && !outcome.ok && outcome.reason === "problems" ? `Not imported: ${outcome.problems[0]?.message}` : "Import not confirmed. Check the revision above, then try again.");
                if (outcome?.ok) setImporting(null);
              }}
            >
              Apply {importing.changes.length ? plural(importing.changes.length, "change") : ""}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setImporting(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
      <Section title="From a terminal">
        <Card className="px-4 py-3">
          <ul className="space-y-1.5 font-mono text-2xs leading-relaxed text-foreground">
            <li>
              bb box config show --json <span className="font-sans text-subtle-foreground">· print it</span>
            </li>
            <li>
              bb box config check file.json --test <span className="font-sans text-subtle-foreground">· check a file and its backends</span>
            </li>
            <li>
              bb box config apply file.json <span className="font-sans text-subtle-foreground">· save it</span>
            </li>
            <li>
              bb box doctor <span className="font-sans text-subtle-foreground">· check every backend</span>
            </li>
          </ul>
        </Card>
      </Section>
      <Confirm open={removeCopy} title="Remove the copy of BB's earlier settings?" description={<p>BB Box no longer needs it: everything in it moved into this configuration. Once removed it cannot be got back.</p>} action="Remove copy" onCancel={() => setRemoveCopy(false)} onConfirm={() => { setRemoveCopy(false); const latest = store.fetch(); void store.apply({ ...latest, migrated: null }, latest.revision).catch(() => null); }} />
    </div>
  );
}
