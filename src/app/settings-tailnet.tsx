import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import type { Problem } from "../core/document.ts";
import type { TailnetMode, TailnetSetting } from "../core/tailnet-settings.ts";
import { Section } from "./settings-fields.tsx";

export type TailnetDraft = {
  readonly mode: TailnetMode;
  readonly tags?: readonly string[];
  readonly clientId?: { readonly set: boolean } | string;
  readonly clientSecret?: { readonly set: boolean } | string;
};

const DEFAULT_TAGS = "tag:bb-box";

function isSet(value: TailnetSetting["clientId"]): boolean {
  return !!value?.set;
}

function tagsFrom(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function SecretRow({ label, set, value, onChange }: { label: string; set: boolean; value: string; onChange: (value: string) => void }) {
  const [replacing, setReplacing] = useState(!set);
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <label className="text-xs text-foreground" htmlFor={`tailnet-${label}`}>
        {label}
      </label>
      {replacing ? (
        <Input
          id={`tailnet-${label}`}
          type="password"
          autoComplete="new-password"
          aria-label={label}
          className="h-8 w-64 text-xs"
          value={value}
          placeholder={set ? "Paste the new value" : "Paste the value"}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-subtle-foreground">Set</span>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
      )}
    </div>
  );
}

export function TailnetSection({ tailnet, problems, save }: { tailnet: TailnetSetting | undefined; problems: readonly Problem[]; save: (tailnet: TailnetDraft | undefined) => Promise<boolean> }) {
  const [mode, setMode] = useState<TailnetMode>(tailnet?.mode ?? "off");
  const [tags, setTags] = useState((tailnet?.tags ?? []).join(", ") || DEFAULT_TAGS);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    setBusy(true);
    try {
      const draft: TailnetDraft | undefined =
        mode === "off"
          ? undefined
          : {
              mode,
              ...(tags.trim() && tags.trim() !== DEFAULT_TAGS ? { tags: tagsFrom(tags) } : {}),
              clientId: clientId ? clientId : { set: isSet(tailnet?.clientId) },
              clientSecret: clientSecret ? clientSecret : { set: isSet(tailnet?.clientSecret) },
            };
      if (await save(draft)) {
        setClientId("");
        setClientSecret("");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Tailnet" description="How machines BB Box makes, such as cloud Macs, reach BB when BB is on a Tailscale tailnet: each joins with a single-use key BB Box makes.">
      <>
        <div className="flex items-center justify-between gap-3 py-2 first:pt-0">
          <span className="text-xs text-foreground">Join machines to the tailnet</span>
          <Select value={mode} onValueChange={(value) => setMode(value as TailnetMode)}>
            <SelectTrigger className="h-8 w-64 text-xs" aria-label="Tailnet">
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
        </div>
        {mode === "oauth" ? (
          <>
            <div className="flex items-center justify-between gap-3 py-2">
              <label className="text-xs text-foreground" htmlFor="tailnet-tags">
                Tags
              </label>
              <Input id="tailnet-tags" aria-label="Tags" className="h-8 w-64 text-xs" value={tags} onChange={(event) => setTags(event.target.value)} />
            </div>
            <SecretRow label="OAuth client ID" set={isSet(tailnet?.clientId)} value={clientId} onChange={setClientId} />
            <SecretRow label="OAuth client secret" set={isSet(tailnet?.clientSecret)} value={clientSecret} onChange={setClientSecret} />
          </>
        ) : null}
        {problems.map((problem) => (
          <p key={problem.path} className="py-1 text-xs text-destructive">
            {problem.message}
          </p>
        ))}
        <div className="flex justify-end pt-2">
          <Button type="button" size="sm" className="h-8" aria-label="Save the tailnet" disabled={busy} onClick={() => void commit()}>
            Save
          </Button>
        </div>
      </>
    </Section>
  );
}
