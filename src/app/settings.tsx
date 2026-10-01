// The Backends section of bb-box's settings page: each backend's state and
// what it still needs, its setup guide, and the doctor's checks with their
// fixes. The full page, with the backends' fields, kinds and sizes, follows
// decision 029 and docs/design/settings.md once the core has config.*.

import { experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DoctorCheck, DoctorReport } from "../backends/types.ts";
import type { Contract } from "../plugin/contract.ts";
import type { BackendView, DoctorView } from "../plugin/views.ts";
import { EmptyPanel, message, Meta, relativeTime, StatusDot, useLive, type Tone } from "./common.tsx";

/** Where the setup guides and scripts are read, as pages. */
export const REPOSITORY_URL = "https://github.com/moonstead/bb-box/blob/main";

const CHECK_ICON: Record<DoctorCheck["status"], { icon: string; className: string }> = {
  ok: { icon: "CircleCheck", className: "text-success" },
  warn: { icon: "AlertTriangle", className: "text-warning" },
  fail: { icon: "X", className: "text-destructive" },
  skipped: { icon: "Minus", className: "text-subtle-foreground" },
};

function Check({ check }: { check: DoctorCheck }) {
  const { icon, className } = CHECK_ICON[check.status];
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-xs leading-snug">
      <Icon name={icon} className={cn("mt-0.5 size-4", className)} aria-label={check.status} />
      <div className="min-w-0">
        <span className={cn(check.status === "skipped" ? "text-muted-foreground" : "text-foreground")}>{check.name}</span> <span className="text-muted-foreground">{check.detail}</span>
        {check.fix && check.status !== "ok" ? <div className="text-muted-foreground">Fix: {check.fix}</div> : null}
      </div>
    </li>
  );
}

function Report({ report }: { report: DoctorReport }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {report.checks.map((check) => (
        <Check key={check.id} check={check} />
      ))}
      {report.notes.map((note) => (
        <li key={note} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 text-xs leading-snug">
          <Icon name="Info" className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
          <pre className="min-w-0 whitespace-pre-wrap break-all rounded-md bg-surface-recessed px-2 py-1 font-mono text-2xs text-foreground">{note}</pre>
        </li>
      ))}
    </ul>
  );
}

function stateOf(backend: BackendView, report: DoctorReport | undefined): { tone: Tone; words: string } {
  if (backend.state === "off") return { tone: "off", words: "Off" };
  if (backend.state === "misconfigured") return { tone: "warn", words: "Needs setting up" };
  if (report && !report.ok) return { tone: "warn", words: "Needs attention" };
  return { tone: "ok", words: "Ready" };
}

function BackendRow({ backend, report, checkedAt, now }: { backend: BackendView; report: DoctorReport | undefined; checkedAt: number | null; now: number }) {
  const { tone, words } = stateOf(backend, report);
  const guide = backend.setup.guide ? `${REPOSITORY_URL}/${backend.setup.guide}` : null;
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{backend.label}</p>
          <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
            <StatusDot tone={tone} className="mt-[0.3rem]" />
            <Meta
              items={[
                <span key="state" className={cn(tone === "warn" && "text-warning-text")}>
                  {words}
                </span>,
                backend.state === "misconfigured" ? backend.problems[0] : null,
                report?.summary,
                checkedAt !== null ? `checked ${relativeTime(checkedAt, now)}` : null,
              ]}
            />
          </div>
        </div>
      </div>
      {backend.state === "misconfigured" && backend.problems.length > 1 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-warning-text">
          {backend.problems.slice(1).map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {backend.state !== "active" && guide ? (
        <p className="mt-2 text-xs leading-snug text-muted-foreground">
          Follow the{" "}
          <UrlLink href={guide} className="text-foreground underline underline-offset-2">
            {backend.label} setup guide
          </UrlLink>
          {backend.setup.scripts.length ? (
            <>
              . It runs{" "}
              {backend.setup.scripts.map((script, index) => (
                <span key={script}>
                  {index > 0 ? (index === backend.setup.scripts.length - 1 ? " and " : ", ") : ""}
                  <UrlLink href={`${REPOSITORY_URL}/${script}`} className="text-foreground underline underline-offset-2">
                    {script.split("/").pop()}
                  </UrlLink>
                </span>
              ))}
              , in that order.
            </>
          ) : (
            "."
          )}
        </p>
      ) : null}
      {report ? <Report report={report} /> : null}
    </div>
  );
}

export function SettingsSection() {
  const rpc = useRpc<Contract>();
  const { value: backends, error } = useLive<BackendView[]>("backends", () => rpc.call("backends"), () => true);
  const [doctor, setDoctor] = useState<{ view: DoctorView; at: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    try {
      setDoctor({ view: await rpc.call("doctor"), at: Date.now() });
      setProblem(null);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setChecking(false);
    }
  };
  const now = Date.now();
  const reportOf = (label: string) => doctor?.view.sections.find((section) => section.title === label)?.report;
  const kinds = doctor?.view.sections.find((section) => section.title === "Kinds")?.report;
  return (
    <div className="space-y-3">
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {backends ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="divide-y divide-border">
            {backends.map((backend) => (
              <BackendRow key={backend.type} backend={backend} report={reportOf(backend.label)} checkedAt={doctor?.at ?? null} now={now} />
            ))}
            {kinds ? (
              <div className="py-3 last:pb-0">
                <p className="text-sm font-medium text-foreground">Kinds</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{kinds.summary}</p>
                <Report report={kinds} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={checking || !backends?.length} onClick={() => void check()}>
          {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          {checking ? "Checking…" : "Check the backends"}
        </Button>
        <span className="text-xs text-muted-foreground">Checks each backend's settings, host and templates. It changes nothing.</span>
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-destructive-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
