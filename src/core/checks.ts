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
  "images.bb-update": { name: "Refresh after a BB update", from: ["bb-box"], what: "After a BB update, which Linux images have another build of BB's app than BB's server gives, and when their refresh starts. Only while Rebuild images each night is on." },
  "images.<backend>/<ref>": { name: "Rebuild of <backend>/<ref>", from: ["bb-box"], what: "A standard image whose last rebuild failed, or waits for room." },
  "images.bake.<image>.<backend>.<kind>": { name: "Build of <image> for <kind> on <backend>", from: ["bb-box"], what: "A project image whose last build failed. Its boxes run its script as they start meanwhile." },
  "device-hub.<box>": {
    name: "Device Hub in <box>",
    from: ["bb-box"],
    what: "An ios box's macOS host has no Device Hub running (063): it takes the device's pasteboard, and quitting it shuts the device down, so the device server kills it within 5 s of its start. Says how often it has.",
  },
  "device.<box>": { name: "Device server of <box>", from: ["bb-box"], what: "A device box's server (063): the version it runs against the one this bb-box delivers, a delivery waiting for a person or a recording, a version marked bad after it did not answer, and a server its service manager gave up on." },
  "devices.<mac>": {
    name: "iOS devices on <mac>",
    from: ["ssh-pool", "tart", "namespace"],
    what: "What a Mac offers iOS devices, as bb-box last measured it there (065): the iOS Simulator, and a hardware or software H.264 encoder for their video. A Mac that cannot run the Simulator or stream lends no ios slot.",
  },
  "encoder.<mac>": {
    name: "Video encoder on <mac>",
    from: ["bb-box"],
    what: "A Mac's video encoder, shared by every iOS device bb-box streams on it (064): its budget, from the chip or a probe, how much of it the streams use, and which are shown at a lower resolution to keep within it.",
  },
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
  "proxmox.android-kvm": { name: "KVM for Android", from: ["proxmox-qemu"], what: "Where Android templates are listed, the host allows nested virtualization, as the linux-kvm setting says: the Android emulator needs KVM." },
  "proxmox.android-disk": { name: "Disk for Android", from: ["proxmox-qemu"], what: "The storage of each Android template has room beyond the reserve for a refresh's build and trial boxes and an Android box in use." },
  "proxmox.gpu-report": { name: "Host's GPU report", from: ["proxmox-lxc"], what: "The host's report of each GPU's memory, which bb-box-gpu-memory.timer writes in a VM's notes: there, current, and naming each GPU." },
  "gpu.<gpu>": { name: "GPU <gpu>", from: ["proxmox-lxc"], what: "A GPU's free memory, as bb-box last read it in a GPU desktop, against what a GPU desktop needs." },
  "ssh.key": { name: "SSH key", from: ["proxmox-lxc", "proxmox-qemu", "ssh-pool"], what: "bb-box's SSH key reads, and, where bb-box made it, its public key to install." },

  // Docker.
  "docker.cli": { name: "docker CLI", from: ["docker"], what: "The docker CLI runs on BB's server." },
  "docker.daemon": { name: "Docker daemon", from: ["docker"], what: "The Docker host answers, runs Linux containers, and its architecture." },
  "docker.ssh": { name: "SSH connection reuse", from: ["docker"], what: "Over ssh://, whether the docker calls share one SSH connection." },
  "docker.limits": { name: "CPU and memory limits", from: ["docker"], what: "Docker can limit a container's CPU and memory, as each box needs." },
  "docker.cpuset": { name: "Cores a box sees", from: ["docker"], what: "Docker can pin each box to as many CPUs as it has cores, so nproc in a box says its cores." },
  "docker.apparmor": { name: "Programs in boxes under the host's AppArmor", from: ["docker"], what: "A setgid program in a box, as sudo runs, works under the Docker host's AppArmor profiles, which on a host that is itself a container cannot name a box's files." },
  "docker.lxcfs": { name: "Memory and CPUs a box sees", from: ["docker"], what: "The host runs LXCFS, so free, /proc/meminfo and /proc/cpuinfo in a box say its own memory and CPUs, and no running box's LXCFS files have broken." },
  "docker.network": { name: "Network <network>", from: ["docker"], what: "bb-box's network for its boxes, made by bb-box." },
  "docker.privileged": { name: "Docker in boxes", from: ["docker"], what: "Whether boxes are privileged, so they can run Docker inside." },
  "docker.gpus": { name: "GPUs", from: ["docker"], what: "The NVIDIA GPUs Docker lists as CDI devices, for GPU desktops." },
  "docker.capacity": { name: "Room on <host>", from: ["docker"], what: "Room on the host for a Linux box at its default size." },
  "docker.sizes": { name: "Room for each kind", from: ["docker"], what: "The host holds a box of each kind at its default size." },

  // Hetzner Cloud.
  "hetzner.api": { name: "Hetzner Cloud API", from: ["hetzner"], what: "The API answers and the token reads the project." },
  "hetzner.reach": { name: "Reaching hosts", from: ["hetzner"], what: "How bb-box reaches a host's Docker: over the tailnet, or over the internet from the addresses in SSH from." },
  "hetzner.unclaimed": { name: "Servers no host claims", from: ["hetzner"], what: "Servers with this install's label that are not hosts bb-box knows. The sweep adopts a host's server, as after lost storage, and deletes any other 10 minutes after it was made." },
  "hetzner.type": { name: "Server type <type>", from: ["hetzner"], what: "The hosts' server type is sold at the location, with its size and price." },
  "hetzner.image": { name: "Host image", from: ["hetzner"], what: "The snapshot new hosts start from, with Docker, Tailscale and the box images in it: its age, the snapshots kept and their cost, and the last build." },
  "hetzner.arm-type": { name: "Server type <type>", from: ["hetzner"], what: "The Arm hosts' server type, for linux-arm64 boxes, is an Arm type sold at the location, with its size and price." },
  "hetzner.arm-image": { name: "Arm host image", from: ["hetzner"], what: "The snapshot new Arm hosts start from: its age, the snapshots kept and their cost, and the last build." },
  "hetzner.hosts": { name: "Hosts", from: ["hetzner"], what: "Each host bb-box made: its state, age, boxes and cost this month." },
  "hetzner.spend": { name: "This month's spend", from: ["hetzner"], what: "What the hosts cost this month before VAT, against the monthly limit." },
  "hetzner.host.<host>": { name: "Docker on <host>", from: ["hetzner"], what: "A host's Docker, as the Docker backend's checks find it." },
  "image.<image>": { name: "Image <image>", from: ["docker", "microsandbox"], what: "An image a kind runs is on the host, built by bb-box's build script, and not too old." },

  // microsandbox.
  "microsandbox.host": { name: "Host <host>", from: ["microsandbox"], what: "The host answers, runs Linux on x86_64, and its cores, memory and free disk." },
  "microsandbox.msb": { name: "msb", from: ["microsandbox"], what: "bb-box's msb is installed on the host at the release this bb-box pins." },
  "microsandbox.kvm": { name: "KVM", from: ["microsandbox"], what: "The host has /dev/kvm, and BB's user may use it." },
  "microsandbox.disks": { name: "Docker disks", from: ["microsandbox"], what: "The host has mkfs.ext4, with which bb-box makes each box's Docker disk quickly." },
  "microsandbox.lxc": { name: "LXC", from: ["microsandbox"], what: "The host is an LXC container, where msb's snapshots and flat roots fail." },
  "microsandbox.overcommit": { name: "Memory overcommit", from: ["microsandbox"], what: "Above 1, whether it applies on the host: a Mac keeps the memory a box has used, so bb-box counts each box there at its full size." },
  "microsandbox.capacity": { name: "Room on <host>", from: ["microsandbox"], what: "Room on the host for a box at its default size." },
  "microsandbox.sizes": { name: "Room for each kind", from: ["microsandbox"], what: "The host holds a box of each kind at its default size." },

  "tailnet.client": { name: "OAuth client", from: ["bb-box"], what: "Tailscale signs in the OAuth client in the General settings, with which bb-box makes a single-use key for each machine it makes." },
  "tailnet.devices": { name: "Devices", from: ["bb-box"], what: "This install's devices on the tailnet, which bb-box removes when their machine went without logging out, and how many other devices carry the same tags, unnamed: bb-box leaves those alone." },
  "namespace.token": { name: "API token", from: ["namespace"], what: "Namespace's API answers to the token in BB Box's settings." },
  "namespace.machines": { name: "Machines", from: ["namespace"], what: "The Namespace machines bb-box has, each with its age and when it ends, and any no box claims." },
  "namespace.limits": { name: "Workspace limits", from: ["namespace"], what: "The Mac cores and memory the workspace allows at once and has in use, read from Namespace, from which bb-box refuses a Mac up front; a warning when the token may not read them." },
  "namespace.images": { name: "Linux images", from: ["namespace"], what: "bb-box's Linux images in the workspace's registry: when each was built, whether a new one is due, and whether one is being built." },

  // Tart.
  "tart.ssh-key": { name: "SSH key", from: ["tart"], what: "bb-box's SSH key for the Macs reads, and its public key to install." },
  "tart.hosts": { name: "Macs", from: ["tart"], what: "At least one Mac is set up." },
  "host.<mac>": { name: "Mac <mac>", from: ["tart"], what: "The Mac answers over SSH, is Apple silicon, and has Tart." },
  "image.<mac>.<kind>": {
    name: "<kind> image on <mac>",
    from: ["tart"],
    what: "The VM a kind's boxes are cloned from is on the Mac, of the right OS, and not too old. For the iOS image, also that it offers iOS devices, built on the macOS image's current build, with an idb_companion and Xcode an image check has passed together.",
  },
  "qemu.<mac>": { name: "QEMU on <mac>", from: ["tart"], what: "QEMU, the Hypervisor framework and UEFI firmware, for Windows boxes on the Mac." },
  "qemu-video.<mac>": { name: "Windows video on <mac>", from: ["tart"], what: "bb-box's build of bb-box-stream on the Mac, which gives Windows boxes video from QEMU's VNC server (#865)." },
  "capacity.<mac>": { name: "Room on <mac>", from: ["tart"], what: "Room on the Mac for a macOS box at its default size." },
  "sizes.<mac>": { name: "Room for each kind on <mac>", from: ["tart"], what: "The Mac holds a box of each kind at its default size." },
  "ios-hosts.<mac>": {
    name: "Shared iOS hosts on <mac>",
    from: ["tart", "namespace"],
    what: "The shared iOS hosts on the Mac (064), or on Namespace (065): each host's state, its slots held, ready, making and sweeping, its free disk and memory, and each held slot's cores, memory and home; Namespace's host's end and how its video is encoded; or, with none, whether one can start.",
  },

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
  "machine.<machine>.sip": { name: "<machine>: System Integrity Protection", from: ["ssh-pool"], what: "On a Mac, whether System Integrity Protection is on, and so whether bb-box can grant box users' programs macOS permissions (058)." },
  "machine.<machine>.slots": {
    name: "<machine>: iOS slots",
    from: ["ssh-pool"],
    what: "On a Mac whose line lists ios (064): that its iOS slots are set up, whether it lends slots or is lent whole, its slots held, ready, making and sweeping, the iOS runtime and seed they are made with, each held slot's load, and what its last sweeps found and left.",
  },
  "machine.<machine>.homes": { name: "<machine>: people's homes", from: ["ssh-pool"], what: "On a Mac, box users cannot enter any person's home, such as an administrator's with BB's or an agent CLI's credentials." },
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
