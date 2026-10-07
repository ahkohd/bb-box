// The agent a thread on a box runs (#561). BB runs a thread with one of its
// providers' CLIs on the thread's machine. box_thread spawns its child
// without its parent, so BB would give the child the project's remembered
// provider, which the box may not have. On a Windows box with none of BB's
// CLIs, BB then picked another it did not have either, and the child failed.
// So bb-box asks BB which CLIs the box's machine has: it starts the child on
// its parent's provider and model when the box has them, leaves BB's default
// otherwise, and refuses at once when the box has none.

import { BoxError } from "../core/boxes.ts";

/** What BB says of one provider's CLI on a machine. */
interface ProviderCli {
  readonly displayName: string;
  readonly executableName: string;
  readonly installed: boolean;
}

/** The parts of BB's SDK the choice uses. */
export interface AgentSdk {
  readonly hosts: { providerCliStatus(args: { hostId: string }): Promise<Record<string, ProviderCli>> };
  readonly threads: {
    get(args: { threadId: string }): Promise<{ providerId: string }>;
    defaultExecutionOptions(args: { threadId: string }): Promise<{ model: string } | null>;
  };
  readonly providers: { models(args: { hostId: string; providerId: string }): Promise<{ models: readonly { id: string; model: string }[] }> };
}

/** What box_thread's spawn takes: nothing, for BB's default. */
export interface AgentChoice {
  readonly providerId?: string;
  readonly model?: string;
}

/**
 * The provider and model for a child of thread `threadId` on machine
 * `hostId`, box `box`'s. Throws when the box has none of BB's CLIs. A
 * question BB cannot answer, as an older BB's, leaves BB's default.
 */
export async function agentFor(sdk: AgentSdk, threadId: string, hostId: string, box: string, logError: (operation: string, error: unknown) => void): Promise<AgentChoice> {
  const clis = await sdk.hosts.providerCliStatus({ hostId }).catch((error: unknown) => (logError("list a box's agent CLIs", error), null));
  const known = Object.entries(clis ?? {});
  if (known.length === 0) return {};
  if (!known.some(([, cli]) => cli.installed)) {
    const missing = known.map(([, cli]) => `${cli.displayName} (${cli.executableName})`).join(", ");
    throw new BoxError("unsupported", `A thread cannot run on box ${box}: it has none of the agent CLIs BB runs threads with: ${missing}. Install one there, then start the thread again.`);
  }
  const providerId = (await sdk.threads.get({ threadId }).catch(() => null))?.providerId;
  if (!providerId || !clis![providerId]?.installed) return {};
  const model = (await sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null))?.model;
  if (!model) return { providerId };
  const models = (await sdk.providers.models({ hostId, providerId }).catch(() => null))?.models ?? [];
  // A model the box's CLI does not list would fail there: BB gives the child that CLI's default then.
  return models.some((listed) => listed.id === model || listed.model === model) ? { providerId, model } : { providerId };
}
