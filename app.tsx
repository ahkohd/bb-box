// bb-box's panels: a thread's boxes, and the backends on the settings page.
// They read everything through the RPC contract and refetch when the server
// says something changed.

import { definePluginApp, experimental_Icon as Icon, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BoxResult, Contract, PanelState } from "./src/plugin/contract.ts";
import type { BackendView, BoxView, DoctorView } from "./src/plugin/views.ts";

const BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50";
const DANGER = `${BUTTON} text-destructive`;

const STATE_LABELS: Record<BoxView["state"], string> = {
  acquiring: "Acquiring",
  starting: "Starting",
  ready: "Ready",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  gone: "Gone",
  releasing: "Releasing",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** State from the server, refetched on each change signal and after a reconnect. */
function useLive<T>(load: () => Promise<T>, relevant: (payload: unknown) => boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setValue(await load());
      setError(null);
    } catch (caught) {
      setError(message(caught));
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime("changed", (payload) => {
    if (relevant(payload)) void refresh();
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") void refresh();
    previous.current = connection;
  }, [connection, refresh]);
  return { value, error, refresh };
}

function StateBadge({ state }: { state: BoxView["state"] }) {
  const tone =
    state === "ready"
      ? "border-border text-foreground"
      : state === "failed" || state === "gone"
        ? "border-destructive text-destructive"
        : "border-border text-muted-foreground";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>{STATE_LABELS[state]}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

function BoxCard({ box, act }: { box: BoxView; act: (method: "release" | "stop" | "start" | "refresh", box: BoxView) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = async (method: "release" | "stop" | "start" | "refresh") => {
    setBusy(true);
    try {
      await act(method, box);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const settling = box.state === "acquiring" || box.state === "starting" || box.state === "stopping" || box.state === "releasing";
  const enrol =
    box.enrol.state === "enrolled"
      ? "Enrolled"
      : box.enrol.state === "enrolling"
        ? "Enrolling"
        : box.enrol.state === "failed"
          ? `Failed: ${box.enrol.error ?? "no reason given"}`
          : "Not enrolled";
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Icon name={box.desktop ? "Monitor" : "Box"} className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground">{box.name}</span>
        <StateBadge state={box.state} />
        <span className="ml-auto text-xs text-muted-foreground">{box.kindLabel}</span>
      </div>
      {box.error ? <p className="text-xs text-destructive">{box.error}</p> : null}
      <div className="space-y-1">
        <Row label="Kind">
          {box.kind} from {box.backendLabel}
        </Row>
        <Row label="System">
          {box.os} {box.arch}
          {box.gpu ? ", GPU" : ""}
          {box.extras.length ? `, with ${box.extras.join(", ")}` : ""}
        </Row>
        {box.address ? <Row label="Address">{box.address}</Row> : null}
        {box.facts.map((fact) => (
          <Row key={fact.label} label={fact.label}>
            {fact.value}
          </Row>
        ))}
        <Row label="BB machine">{enrol}</Row>
        {box.timings.total !== undefined ? <Row label="Ready in">{seconds(box.timings.total)}</Row> : null}
      </div>
      {box.desktop ? (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-center text-xs text-muted-foreground">
          The desktop viewer comes in a later version of bb-box.
          <br />
          Agents can already open windows with box_run and desktop set.
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {box.canStopStart && box.state === "ready" ? (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void run("stop")}>
            Stop
          </button>
        ) : null}
        {box.canStopStart && box.state === "stopped" ? (
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void run("start")}>
            Start
          </button>
        ) : null}
        <button type="button" className={BUTTON} disabled={busy || settling} onClick={() => void run("refresh")}>
          Check
        </button>
        {confirming ? (
          <>
            <button type="button" className={DANGER} disabled={busy} onClick={() => void run("release")}>
              Release and delete its disk
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className={DANGER} disabled={busy || box.state === "releasing"} onClick={() => setConfirming(true)}>
            Release
          </button>
        )}
      </div>
    </div>
  );
}

function BoxesPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const load = useCallback(() => rpc.call("state", { threadId }), [rpc, threadId]);
  const relevant = useCallback(
    (payload: unknown) => {
      const changed = (payload as { threadId?: unknown } | null)?.threadId;
      return changed === null || changed === undefined || changed === threadId;
    },
    [threadId],
  );
  const { value: state, error, refresh } = useLive<PanelState>(load, relevant);
  const [kind, setKind] = useState("");
  const [acting, setActing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const kinds = state?.kinds ?? [];
  const chosen = kinds.some((candidate) => candidate.id === kind) ? kind : (kinds[0]?.id ?? "");

  const settle = async (result: Promise<BoxResult>) => {
    try {
      const { error: failed } = await result;
      setProblem(failed);
    } catch (caught) {
      setProblem(message(caught));
    }
    await refresh();
  };
  const acquire = async () => {
    setActing(true);
    await settle(rpc.call("acquire", { threadId, kind: chosen }));
    setActing(false);
  };
  const act = (method: "release" | "stop" | "start" | "refresh", box: BoxView) => settle(rpc.call(method, { threadId, box: box.id }));

  return (
    <div className="space-y-4">
      {kinds.length ? (
        <div className="flex items-center gap-2">
          <select
            aria-label="Kind of box"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={chosen}
            onChange={(event) => setKind(event.target.value)}
          >
            {kinds.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} ({candidate.size})
              </option>
            ))}
          </select>
          <button type="button" className={BUTTON} disabled={acting || !chosen} onClick={() => void acquire()}>
            <Icon name="Plus" className="size-3" aria-hidden />
            New box
          </button>
        </div>
      ) : state ? (
        <p className="text-sm text-muted-foreground">No backend is on, so there are no boxes to make. Set one up in bb-box's settings.</p>
      ) : null}
      {kinds.find((candidate) => candidate.id === chosen)?.description ? (
        <p className="text-xs text-muted-foreground">{kinds.find((candidate) => candidate.id === chosen)!.description}</p>
      ) : null}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {!state && !error ? <p className="text-sm text-muted-foreground">Loading boxes...</p> : null}
      {state && !state.boxes.length ? (
        <p className="text-sm text-muted-foreground">This thread has no boxes. Make one here, or ask the agent to use box_acquire.</p>
      ) : null}
      {state?.boxes.map((box) => <BoxCard key={box.id} box={box} act={act} />)}
    </div>
  );
}

function BackendCard({ backend }: { backend: BackendView }) {
  const state = backend.state === "active" ? "On" : backend.state === "off" ? "Off" : "Needs its settings fixed";
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{backend.label}</span>
        <span className={`text-xs ${backend.state === "misconfigured" ? "text-destructive" : "text-muted-foreground"}`}>{state}</span>
      </div>
      {backend.problems.length ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
          {backend.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {backend.state !== "active" && backend.setup.guide ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            To set it up, follow <code className="text-foreground">{backend.setup.guide}</code> in bb-box's source. It runs these scripts, in order:
          </p>
          <ol className="list-decimal pl-5">
            {backend.setup.scripts.map((script) => (
              <li key={script}>
                <code className="text-foreground">{script}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function Doctor({ view }: { view: DoctorView }) {
  if (!view.sections.length) return <p className="text-xs text-muted-foreground">No backend is on, so there is nothing to check.</p>;
  return (
    <div className="space-y-3">
      {view.sections.map(({ title, report }) => (
        <div key={title} className="space-y-1">
          <p className="text-sm text-foreground">
            {title}: {report.summary}
          </p>
          <ul className="space-y-1 text-xs">
            {report.checks.map((check) => (
              <li key={check.id} className={check.status === "fail" ? "text-destructive" : check.status === "warn" ? "text-foreground" : "text-muted-foreground"}>
                [{check.status}] {check.name}: {check.detail}
                {check.fix && check.status !== "ok" ? <span className="block pl-4">Fix: {check.fix}</span> : null}
              </li>
            ))}
            {report.notes.map((note) => (
              <li key={note} className="text-muted-foreground">
                Note: {note}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SettingsSection() {
  const rpc = useRpc<Contract>();
  const load = useCallback(() => rpc.call("backends"), [rpc]);
  const always = useCallback(() => true, []);
  const { value: backends, error } = useLive<BackendView[]>(load, always);
  const [doctor, setDoctor] = useState<DoctorView | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    try {
      setDoctor(await rpc.call("doctor"));
      setProblem(null);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="space-y-3">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {backends?.map((backend) => <BackendCard key={backend.type} backend={backend} />)}
      <div className="flex items-center gap-2">
        <button type="button" className={BUTTON} disabled={checking} onClick={() => void check()}>
          {checking ? "Checking..." : "Check the backends"}
        </button>
        <span className="text-xs text-muted-foreground">Checks the settings, the host and the templates. It changes nothing.</span>
      </div>
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      {doctor ? <Doctor view={doctor} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "boxes",
    title: "Boxes",
    icon: "Box",
    component: BoxesPanel,
  });
  app.slots.settingsSection({
    id: "backends",
    title: "Backends",
    description: "Where boxes come from, and what each backend still needs.",
    component: SettingsSection,
  });
});
