// A provider's name for people: "Proxmox LXC on pve1", "Docker on devpc",
// "Tart on 2 Macs", "SSH host pool", "Namespace (team-b)" (044). The pane
// shows it, box_list prints it, and `on` takes it, so one function makes it.

export interface ProviderWords {
  /** The driver's label, as settings names the backend: "Proxmox LXC", "Tart". */
  readonly label: string;
  /** Where its boxes run, by name; empty for a pool, a local Docker daemon and a cloud account. */
  readonly hosts: readonly string[];
  /** The backend's ID, for "Macs" against "hosts" and for the name of a second backend of a type that names no host. */
  readonly id: string;
}

/** The driver's label without its aside: "Tart (VMs on a Mac)" reads "Tart". */
export function shortLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "");
}

export function backendIdName(id: string): string | null {
  const at = id.indexOf(":");
  return at < 0 ? null : id.slice(at + 1) || null;
}

/** The provider's name: its label, and its host or how many hosts it spans, or its name for a second backend with no host. */
export function providerName({ label, hosts, id }: ProviderWords): string {
  const name = shortLabel(label);
  if (hosts.length === 1) return `${name} on ${hosts[0]}`;
  if (hosts.length > 1) return `${name} on ${hosts.length} ${id.split(":")[0] === "tart" ? "Macs" : "hosts"}`;
  const own = backendIdName(id);
  return own ? `${name} (${own})` : name;
}

/** The names `on` may use for a provider, folded for a comparison without case: its name, its backend ID, and its one host. */
export function providerKeys(words: ProviderWords): string[] {
  const keys = [providerName(words), words.id];
  if (words.hosts.length === 1) keys.push(words.hosts[0]!);
  return keys.map(foldName);
}

/** Lower case, with the spaces around and within tidied, so "Docker on devpc" matches "docker on  devpc". */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
