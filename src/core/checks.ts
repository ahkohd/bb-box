// Every check bb box doctor can report, by its ID (#500). A DoctorCheck's ID
// must match one of these, so a new check does not compile until it is here,
// and the reference (docs/reference/checks.md) is made from this list. A part
// in angle brackets, such as <vmid>, stands for any text.

export interface CheckInfo {
  /** The check's name, as the doctor shows it; angle brackets as in the ID. */
  readonly name: string;
  /** Who reports it: a backend type, or "bb-box" for the plugin itself. */
  readonly from: readonly string[];
  /** What it checks, in a sentence or two, for people. */
  readonly what: string;
}

export const CHECKS = {
  // bb-box itself.
  doctor: { name: "Checks", from: ["bb-box"], what: "A backend's checks did not finish within their time limit." },
  "config.<path>": { name: "Settings", from: ["bb-box"], what: "A part of bb-box's configuration that needs fixing, by its path, such as general.defaultKind." },
  "offers.<kind>": { name: "Offers of <kind>", from: ["bb-box"], what: "Where several backends offer a kind: they agree on what the kind promises, and each has the features it requires." },
  "overlap.<backend>.<backend>": { name: "<backend> and <backend>", from: ["bb-box"], what: "Two backends whose boxes could take the same guest IDs or addresses." },
  "warm.<kinds>": { name: "Warm pool of <kinds>", from: ["bb-box"], what: "A warm pool that has fewer ready boxes than its count asks for, and no room for another." },
  "sizes.<kind>.<preset>": { name: "Box sizes", from: ["bb-box"], what: "A Linux preset with less than 2 GiB memory, so its boxes can run out of memory as they become BB machines." },
  "box-files": { name: "Files for every box", from: ["bb-box"], what: "The files bb-box writes into each box as it joins BB, and whether the last write worked." },
  "images.nightly": { name: "Nightly rebuilds", from: ["bb-box"], what: "When bb box images refresh last ended. It warns when no run ended for 8 days." },
  "images.<backend>/<ref>": { name: "Rebuild of <backend>/<ref>", from: ["bb-box"], what: "A standard image whose last rebuild failed, or waits for room." },
  "images.bake.<image>.<backend>.<kind>": { name: "Build of <image> for <kind> on <backend>", from: ["bb-box"], what: "A project image whose last build failed. Its boxes run its script as they start meanwhile." },
  "spares.image.<image>.<backend>.<kind>": { name: "Spare of <image> for <kind> on <backend>", from: ["bb-box"], what: "A project image's spare whose build failed to start a box, so bb-box makes none of that build for a day. Its boxes start from the build meanwhile." },

  // Proxmox LXC and Proxmox QEMU.
  "proxmox.api": { name: "Proxmox API", from: ["proxmox-lxc", "proxmox-qemu"], what: "The API answers at its URL, with a certificate bb-box trusts, and the token works." },
  "proxmox.node": { name: "Node", from: ["proxmox-lxc", "proxmox-qemu"], what: "The node exists and is online." },
  "proxmox.memory": { name: "Node memory", from: ["proxmox-lxc", "proxmox-qemu"], what: "How much of the node's memory is free beyond the reserve." },
  "proxmox.pool": { name: "Resource pool", from: ["proxmox-lxc", "proxmox-qemu"], what: "The resource pool exists and the token may use it." },
  "proxmox.bridge": { name: "Network bridge", from: ["proxmox-lxc", "proxmox-qemu"], what: "The bridge exists on the node." },
  "proxmox.vmids": { name: "VMID range", from: ["proxmox-lxc", "proxmox-qemu"], what: "The VMID range is free of guests bb-box did not make." },
  "proxmox.sizes": { name: "Room for each kind", from: ["proxmox-lxc", "proxmox-qemu"], what: "The node holds a box of each kind at its default size." },
  "template.<vmid>": { name: "<flavour> template <vmid>", from: ["proxmox-lxc", "proxmox-qemu"], what: "A template is there, is a template, and has what its kind needs." },
  "template.<vmid>.image": { name: "Image of <flavour> template <vmid>", from: ["proxmox-lxc", "proxmox-qemu"], what: "The template's image record: its age, pins and tools, against this bb-box's." },
  "ssh.key": { name: "SSH key", from: ["proxmox-lxc", "proxmox-qemu", "ssh-pool"], what: "bb-box's SSH key reads, and, where bb-box made it, its public key to install." },

  // Docker.
  "docker.cli": { name: "docker CLI", from: ["docker"], what: "The docker CLI runs on BB's server." },
  "docker.daemon": { name: "Docker daemon", from: ["docker"], what: "The Docker host answers, runs Linux containers, and its architecture." },
  "docker.ssh": { name: "SSH connection reuse", from: ["docker"], what: "Over ssh://, whether the docker calls share one SSH connection." },
  "docker.limits": { name: "CPU and memory limits", from: ["docker"], what: "Docker can limit a container's CPU and memory, as each box needs." },
  "docker.network": { name: "Network <network>", from: ["docker"], what: "bb-box's network for its boxes, made by bb-box." },
  "docker.privileged": { name: "Docker in boxes", from: ["docker"], what: "Whether boxes are privileged, so they can run Docker inside." },
  "docker.gpus": { name: "GPUs", from: ["docker"], what: "The NVIDIA GPUs Docker lists as CDI devices, for GPU desktops." },
  "docker.capacity": { name: "Room on <host>", from: ["docker"], what: "Room on the host for a Linux box at its default size." },
  "docker.sizes": { name: "Room for each kind", from: ["docker"], what: "The host holds a box of each kind at its default size." },
  "image.<image>": { name: "Image <image>", from: ["docker"], what: "An image a kind runs is on the host, built by bb-box's build script, and not too old." },

  // Tart.
  "tart.ssh-key": { name: "SSH key", from: ["tart"], what: "bb-box's SSH key for the Macs reads, and its public key to install." },
  "tart.hosts": { name: "Macs", from: ["tart"], what: "At least one Mac is set up." },
  "host.<mac>": { name: "Mac <mac>", from: ["tart"], what: "The Mac answers over SSH, is Apple silicon, and has Tart." },
  "image.<mac>.<kind>": { name: "<kind> image on <mac>", from: ["tart"], what: "The VM a kind's boxes are cloned from is on the Mac, of the right OS, and not too old." },
  "qemu.<mac>": { name: "QEMU on <mac>", from: ["tart"], what: "QEMU, the Hypervisor framework and UEFI firmware, for Windows boxes on the Mac." },
  "capacity.<mac>": { name: "Room on <mac>", from: ["tart"], what: "Room on the Mac for a macOS box at its default size." },
  "sizes.<mac>": { name: "Room for each kind on <mac>", from: ["tart"], what: "The Mac holds a box of each kind at its default size." },

  // SSH host pool.
  machines: { name: "Machines", from: ["ssh-pool"], what: "At least one machine is listed." },
  docker: { name: "Docker", from: ["ssh-pool"], what: "Whether the pool's Linux machines lend Docker to their boxes." },
  xcode: { name: "Xcode", from: ["ssh-pool"], what: "Whether the pool's Macs have Xcode." },
  "machine.<machine>.ssh": { name: "<machine>: SSH", from: ["ssh-pool"], what: "The machine answers over SSH with its pinned host key." },
  "machine.<machine>.sizes": { name: "<machine>: room for each kind", from: ["ssh-pool"], what: "The machine holds a box of each of its kinds at the default size." },
  "machine.<machine>.helper": { name: "<machine>: helper", from: ["ssh-pool"], what: "bb-box's helper is installed on the machine, at this bb-box's version." },
  "machine.<machine>.arch": { name: "<machine>: architecture", from: ["ssh-pool"], what: "The machine's architecture is the one its kinds need." },
  "machine.<machine>.tools": { name: "<machine>: tools", from: ["ssh-pool"], what: "The tools its kinds need are on the machine." },
  "machine.<machine>.docker": { name: "<machine>: Docker", from: ["ssh-pool"], what: "Docker runs on the machine, for its boxes." },
  "machine.<machine>.state": { name: "<machine>: state", from: ["ssh-pool"], what: "Whether the machine is free, lent, being reset or out of service." },
  "machine.<machine>.filevault": { name: "<machine>: FileVault", from: ["ssh-pool"], what: "On a Mac, FileVault is off, so it signs a box user in after a restart." },
  "machine.<machine>.signin": { name: "<machine>: sign-in", from: ["ssh-pool"], what: "On a Mac, the next box user is signed in at the console." },
  "machine.<machine>.fulldisk": { name: "<machine>: Full Disk Access", from: ["ssh-pool"], what: "On a Mac, the helper has Full Disk Access, which a reset needs." },
  "machine.<machine>.xcode": { name: "<machine>: Xcode", from: ["ssh-pool"], what: "On a Mac, Xcode and its iOS runtime." },
  "machine.<machine>.screensharing": { name: "<machine>: Screen Sharing", from: ["ssh-pool"], what: "On a Mac with desktops, Screen Sharing is on." },
  "machine.<machine>.grants": { name: "<machine>: Cua Driver's grants", from: ["ssh-pool"], what: "On a Mac with desktops, Cua Driver has Accessibility and Screen Recording." },
  "machine.<machine>.input": { name: "<machine>: viewer's input", from: ["ssh-pool"], what: "On a Mac with desktops, a viewer's keys and clicks reach the desktop." },
} as const satisfies Readonly<Record<string, CheckInfo>>;

/** An ID pattern as a type: each <part> stands for any text. */
type Pattern<S extends string> = S extends `${infer A}<${string}>${infer B}` ? `${A}${string}${Pattern<B>}` : S;
export type CheckId = Pattern<keyof typeof CHECKS & string>;

/** The catalog entry an ID is of, or null: the most specific pattern that matches. */
export function checkOf(id: string): { readonly pattern: string; readonly info: CheckInfo } | null {
  const matches = Object.entries(CHECKS as Readonly<Record<string, CheckInfo>>).filter(([pattern]) => checkPattern(pattern).test(id));
  matches.sort(([a], [b]) => b.replace(/<[^>]*>/g, "").length - a.replace(/<[^>]*>/g, "").length);
  const [found] = matches;
  return found ? { pattern: found[0], info: found[1] } : null;
}

/** A pattern as a regular expression, each <part> any text. */
export function checkPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split(/<[^>]*>/).map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join(".+")}$`);
}
