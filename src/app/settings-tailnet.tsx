import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DEFAULT_TAILNET_TAGS, type TailnetMode } from "../core/tailnet-settings.ts";
import type { ConfigState } from "../plugin/configuration.ts";
import { Badge } from "./common.tsx";
import { describedBy, DraftRow, SecretControl, unplacedProblems } from "./settings-draft-fields.tsx";
import { NETWORK_PART } from "./settings-drafts.ts";
import { Card, Group, Rows } from "./settings-parts.tsx";
import { isSecretState } from "./config.ts";
import { plain, problemPath, TAILNET_SECRET_LABELS, tailnetPath, type Path, type PlainValue } from "./settings-paths.ts";
import { RestoredNote, SaveBar, saveOnEnter, useDraft, type Draft } from "./settings-saving.tsx";

const MODE_WORDS: Readonly<Record<TailnetMode, string>> = {
  off: "No: BB is reached without one",
  oauth: "Yes, with a Tailscale OAuth client",
};

const SECRET_HELP: Readonly<Record<"clientId" | "clientSecret", string>> = {
  clientId: "From Tailscale's admin console, under Settings, Trust credentials, as the tailnet guide shows.",
  clientSecret: "Tailscale shows it once, beside the client's ID. BB Box never shows it again, only whether it is set.",
};

const TAILNET_PATHS: readonly Path[] = (["mode", "tags", "clientId", "clientSecret"] as const).map(tailnetPath);

function modeWords(value: PlainValue): string {
  return value === "off" || value === "oauth" ? MODE_WORDS[value] : String(value);
}

function storedProblem(state: ConfigState, path: Path): string | null {
  return state.problems.find((problem) => problem.path.startsWith("general.tailnet") && problemPath(problem.path, {}) === path)?.message ?? null;
}

function problemOf(draft: Draft, state: ConfigState, path: Path): string | null {
  return draft.problem(path) ?? (draft.edit(path) ? null : storedProblem(state, path));
}

function chooseMode(draft: Draft, mode: TailnetMode): void {
  draft.set(tailnetPath("mode"), plain(mode));
  if (mode === "off") for (const key of ["tags", "clientId", "clientSecret"] as const) draft.forget(tailnetPath(key));
}

function ModeRow({ draft, state }: { draft: Draft; state: ConfigState }) {
  const id = useId();
  const path = tailnetPath("mode");
  const mode = draft.current(path) === "oauth" ? "oauth" : "off";
  const problem = problemOf(draft, state, path);
  const deletesCredentials = mode === "off" && draft.stored(path) === "oauth";
  const modes: readonly TailnetMode[] = ["off", "oauth"];
  return (
    <DraftRow
      draft={draft}
      path={path}
      id={id}
      label="Join machines to the tailnet"
      description={
        <>
          Cloud machines, such as Namespace's Macs and Hetzner's servers, need it when BB is on a Tailscale tailnet.
          {deletesCredentials ? <span className="mt-0.5 block text-warning-text">Saving No deletes the saved OAuth client ID and secret.</span> : null}
        </>
      }
      problem={problem}
      shown={modeWords}
      wide
    >
      <span id={id} role="radiogroup" aria-label="Join machines to the tailnet" aria-describedby={describedBy(`${id}-help`, problem && `${id}-problem`)} className="flex flex-col gap-1.5 text-xs text-foreground sm:items-start">
        {modes.map((choice) => (
          <label key={choice} className="flex cursor-pointer items-center gap-2">
            <input
              id={`${id}-${choice}`}
              type="radio"
              name={`${id}-mode`}
              value={choice}
              data-draft-path={choice === mode ? path : undefined}
              checked={choice === mode}
              onChange={() => chooseMode(draft, choice)}
              onKeyDown={saveOnEnter(draft)}
              className="size-3.5 shrink-0 cursor-pointer accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {MODE_WORDS[choice]}
          </label>
        ))}
      </span>
    </DraftRow>
  );
}

function TagsRow({ draft, state }: { draft: Draft; state: ConfigState }) {
  const id = useId();
  const path = tailnetPath("tags");
  const problem = problemOf(draft, state, path);
  const conflict = draft.conflict(path);
  const fallback = DEFAULT_TAILNET_TAGS.join(", ");
  return (
    <DraftRow draft={draft} path={path} id={id} label="Tags" description="Machines join with these tags, separated by commas. The OAuth client must own them." problem={problem} wide>
      <span className="flex w-full flex-col gap-1 sm:items-end">
        <Input
          id={id}
          data-draft-path={path}
          aria-describedby={describedBy(`${id}-help`, `${id}-effective`, problem && `${id}-problem`, conflict && `${id}-conflict`)}
          aria-invalid={problem ? true : undefined}
          className={cn("h-8 w-full text-xs", problem && "border-destructive")}
          autoComplete="off"
          spellCheck={false}
          placeholder={fallback}
          value={draft.text(path)}
          onChange={(event) => draft.set(path, plain(event.target.value))}
          onKeyDown={saveOnEnter(draft)}
        />
        <span id={`${id}-effective`} className="text-2xs leading-snug text-subtle-foreground sm:text-right">
          Empty: <span className="text-muted-foreground">{fallback}</span>, the default
        </span>
      </span>
    </DraftRow>
  );
}

function SecretRow({ draft, state, secret }: { draft: Draft; state: ConfigState; secret: "clientId" | "clientSecret" }) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const path = tailnetPath(secret);
  const label = TAILNET_SECRET_LABELS[secret];
  const stored = state.document.general.tailnet?.[secret];
  const set = isSecretState(stored) && stored.set;
  const problem = problemOf(draft, state, path);
  const conflict = draft.conflict(path);
  return (
    <DraftRow
      draft={draft}
      path={path}
      id={`${id}-control`}
      label={label}
      description={SECRET_HELP[secret]}
      chips={<Badge tone={!set && problem ? "warn" : "muted"}>{set ? "Set" : "Not set"}</Badge>}
      problem={problem}
      onTheirs={() => setReplacing(false)}
      wide
    >
      <SecretControl
        draft={draft}
        path={path}
        label={label}
        set={set}
        controlId={`${id}-control`}
        describedBy={describedBy(`${id}-control-help`, problem && `${id}-control-problem`, conflict && `${id}-control-conflict`)}
        invalid={problem !== null}
        conflicted={conflict !== null}
        clearable={false}
        replacing={replacing}
        onReplacing={setReplacing}
      />
    </DraftRow>
  );
}

export function NetworkOptions() {
  const draft = useDraft(NETWORK_PART, "the tailnet");
  const oauth = draft.current(tailnetPath("mode")) === "oauth";
  return (
    <div className="space-y-6">
      <RestoredNote draft={draft} />
      <Group title="Tailnet" description="When BB is on a Tailscale tailnet, machines BB Box makes join it, each with a single-use key BB Box makes. These settings are saved together.">
        <Card>
          <Rows>
            <ModeRow draft={draft} state={draft.latest} />
            {oauth ? (
              <>
                <TagsRow draft={draft} state={draft.latest} />
                {(["clientId", "clientSecret"] as const).map((secret) => (
                  <SecretRow key={secret} draft={draft} state={draft.latest} secret={secret} />
                ))}
              </>
            ) : null}
          </Rows>
        </Card>
      </Group>
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, TAILNET_PATHS)} />
    </div>
  );
}
