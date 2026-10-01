// "Docker on BB machines" in BB Box's settings (042): each connected,
// persistent BB machine bb-box did not make, with Docker as it answers
// through bb-box's relay, and a switch that makes it a Docker host. A box is
// a privileged container, root on the machine, and takes its memory, so no
// machine is used until a person turns it on.

import { experimental_Icon as Icon, experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { Contract } from "../plugin/contract.ts";
import type { DockerHostView } from "../plugin/docker-hosts.ts";
import { EmptyPanel, message, Meta, StatusDot, useLive, type Tone } from "./common.tsx";
import { Section } from "./settings-fields.tsx";

/** "Docker 29.8.1", then the machine's cores and memory, as one line. */
export function dockerFacts(host: DockerHostView): string[] {
  if (!host.docker) return [];
  const { version, cpus, memoryMiB, arch } = host.docker;
  return [`Docker ${version}`, `${cpus} ${cpus === 1 ? "core" : "cores"}`, `${Math.round(memoryMiB / 1024)} GiB memory`, ...(arch === "x86_64" ? [] : [`${arch}, so boxes run under emulation`])];
}

/** What the row says of the machine's use as a Docker host. */
export function hostState(host: DockerHostView): { tone: Tone; text: string } {
  const boxes = host.backend?.boxes ?? 0;
  const held = boxes ? `, ${boxes} ${boxes === 1 ? "box" : "boxes"} on it` : "";
  if (!host.connected) return { tone: "warn", text: `Offline in BB${held}` };
  if (host.backend?.enabled) return { tone: "ok", text: `Hosts boxes${held}` };
  if (host.backend) return { tone: "off", text: `Off: takes no new boxes${held}` };
  return { tone: host.docker ? "off" : "bad", text: host.docker ? "Can host boxes" : "Cannot host boxes" };
}

export function DockerHostsSection() {
  const rpc = useRpc<Contract>();
  const pluginId = experimental_usePluginId();
  // Each look opens the machines' relays, so only a change here reloads it.
  const { value: hosts, error, refresh } = useLive<DockerHostView[]>("docker-hosts", async () => (await rpc.call("docker.hosts")).hosts, () => false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = async (host: DockerHostView, enabled: boolean) => {
    setBusy(host.hostId);
    setNotice(null);
    try {
      const { result } = await rpc.call("docker.host.set", { hostId: host.hostId, enabled });
      if (!result.ok) setNotice(result.reason === "revision" ? "Someone saved the configuration first. Try again." : result.problems.map((problem) => problem.message).join(" "));
      await refresh();
    } catch (caught) {
      setNotice(message(caught));
    } finally {
      setBusy(null);
    }
  };

  const description = "Your own BB machines that run Docker, such as a PC with WSL. A box there is a privileged container, root on the machine, so none is used until you turn it on.";
  if (error) {
    return (
      <Section title="Docker on BB machines" description={description} plain>
        <EmptyPanel role="alert">{error}</EmptyPanel>
      </Section>
    );
  }
  if (!hosts) return null;
  if (!hosts.length) {
    return (
      <Section title="Docker on BB machines" description={description} plain>
        <EmptyPanel>No BB machine of yours can host boxes: bb-box lists connected, persistent machines that it did not make.</EmptyPanel>
      </Section>
    );
  }
  return (
    <Section title="Docker on BB machines" description={description}>
      {notice ? (
        <p role="alert" className="mb-2 text-xs leading-snug text-destructive-text">
          {notice}
        </p>
      ) : null}
      {hosts.map((host) => {
        const state = hostState(host);
        const on = host.backend?.enabled ?? false;
        return (
          <div key={host.hostId} data-resource-row className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3 first:pt-0 last:pb-0">
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              <Icon name={`${pluginId}/server`} className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{host.name}</span>
              <div className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
                <StatusDot tone={state.tone} className="mt-[0.3rem]" />
                <Meta items={[state.text, ...dockerFacts(host)]} />
              </div>
              {host.problem && host.connected ? <p className="mt-0.5 text-xs leading-snug text-destructive-text">{host.problem}</p> : null}
            </div>
            <Switch
              aria-label={`Host boxes on ${host.name}`}
              checked={on}
              disabled={busy !== null || (!on && !host.docker)}
              onCheckedChange={(enabled) => void set(host, enabled)}
            />
          </div>
        );
      })}
    </Section>
  );
}
