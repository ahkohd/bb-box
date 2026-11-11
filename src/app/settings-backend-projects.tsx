import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { Card, Group, RowControl, RowNote, Rows, SavedTick } from "./settings-parts.tsx";
import { backendProjectsPath } from "./settings-paths.ts";

interface ProjectChoice {
  readonly id: string;
  readonly name: string;
}

type ProjectsRead = { readonly state: "reading" } | { readonly state: "read"; readonly projects: readonly ProjectChoice[] } | { readonly state: "unread" };

export const PROJECTS_DESCRIPTION = "Every project uses it while none is chosen. Choose projects to keep it for them: only their threads see it, and they use it before the backends every project shares.";

export function keptForWords(projects: readonly string[]): string {
  if (!projects.length) return "every project";
  return projects.length === 1 ? "1 project" : `${projects.length} projects`;
}

function useBbProjects(): ProjectsRead {
  const rpc = useRpc<Contract>();
  const [read, setRead] = useState<ProjectsRead>({ state: "reading" });
  useEffect(() => {
    let current = true;
    rpc.call("projects", null).then(
      (projects) => current && setRead({ state: "read", projects: [...projects].sort((a, b) => a.name.localeCompare(b.name)) }),
      () => current && setRead({ state: "unread" }),
    );
    return () => {
      current = false;
    };
  }, [rpc]);
  return read;
}

export function BackendProjects({ config, label }: { config: BackendConfig; label: string }) {
  const { state, instant, writes } = useSettings();
  const read = useBbProjects();
  const key = switchKey.backendProjects(config.id);
  const kept = instant.pendingValue<readonly string[]>(key) ?? config.projects ?? [];
  const known = read.state === "read" ? read.projects : [];
  const gone = read.state === "read" ? kept.filter((id) => !known.some((project) => project.id === id)) : [];
  const servesNone = read.state === "read" && kept.length > 0 && gone.length === kept.length;
  const choose = (id: string, on: boolean, name: string) => {
    const next = on ? [...kept, id] : kept.filter((each) => each !== id);
    void instant.run(writes.backendProjects(state, config, next, on ? `${label} kept for ${name}` : `${label} no longer kept for ${name}`, keptForWords));
  };
  return (
    <Group title="Projects" description={PROJECTS_DESCRIPTION} action={<SavedTick show={instant.isSaved(key)} />}>
      <Card>
        <Rows>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-xs" data-draft-path={backendProjectsPath(config.id)}>
            <span className="text-muted-foreground">Used by</span>
            <span className={servesNone ? "text-warning-text" : "text-foreground"}>{servesNone ? "No project: none of its projects is still in BB" : kept.length ? `${keptForWords(kept)} only` : "Every project"}</span>
          </div>
          {read.state === "reading" ? <p className="px-4 py-2.5 text-xs text-muted-foreground">Reading BB's projects…</p> : null}
          {read.state === "unread" ? <p className="px-4 py-2.5 text-xs text-muted-foreground">BB did not list its projects. Open this page again in a minute, or use bb box backend set {config.id} --projects.</p> : null}
          {known.map((project) => (
            <label key={project.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs text-foreground">
              <span className="min-w-0 break-words">{project.name}</span>
              <RowControl>
                <Switch aria-label={`Keep ${label} for ${project.name}`} checked={kept.includes(project.id)} aria-disabled={instant.pending !== null || undefined} onCheckedChange={(on) => choose(project.id, on, project.name)} />
              </RowControl>
            </label>
          ))}
          {gone.map((id) => (
            <label key={id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs text-muted-foreground">
              <span className="min-w-0 break-words">A project no longer in BB</span>
              <RowControl>
                <Switch aria-label={`Stop keeping ${label} for a project no longer in BB`} checked aria-disabled={instant.pending !== null || undefined} onCheckedChange={(on) => choose(id, on, "a project no longer in BB")} />
              </RowControl>
            </label>
          ))}
        </Rows>
      </Card>
      <RowNote note={instant.note(key)} />
    </Group>
  );
}
