// A provider's name for people: "Proxmox LXC on pve1", "Docker on devpc",
// "Tart on 2 Macs", "SSH host pool" (044). The pane shows it, box_list
// prints it, and `on` takes it, so one function makes it.

export interface ProviderWords {
  /** The driver's label, as settings names the backend: "Proxmox LXC", "Tart". */
  readonly label: string;
  /** Where its boxes run, by name; empty for a pool and a local Docker daemon. */
  readonly hosts: readonly string[];
  /** The driver's type, for "Macs" against "hosts". */
  readonly type: string;
}

/** The driver's label without its aside: "Tart (VMs on a Mac)" reads "Tart". */
export function shortLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "");
}

/** The provider's name: its label, and its host or how many hosts it spans. */
export function providerName({ label, hosts, type }: ProviderWords): string {
  const name = shortLabel(label);
  if (hosts.length === 1) return `${name} on ${hosts[0]}`;
  if (hosts.length > 1) return `${name} on ${hosts.length} ${type === "tart" ? "Macs" : "hosts"}`;
  return name;
}

/** The names `on` may use for a provider, folded for a comparison without case: its name, its backend ID, and its one host. */
export function providerKeys(id: string, words: ProviderWords): string[] {
  const keys = [providerName(words), id];
  if (words.hosts.length === 1) keys.push(words.hosts[0]!);
  return keys.map(foldName);
}

/** Lower case, with the spaces around and within tidied, so "Docker on devpc" matches "docker on  devpc". */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
