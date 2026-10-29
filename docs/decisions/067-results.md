# 067 results

What was built and checked for each unit of
[067](067-settings-page.md). Each unit keeps to its own section.

## Unit 4: the drivers' help text

Built on 29 October 2026, for the owner's approval. Words only: no
behaviour and no layout changed.

### What changed

- Every backend field's help now starts with a sentence of its own that
  says what the field is for. The page can show that sentence and keep the
  rest behind More, as section 3 of 067 asks. The rest keeps the format,
  the examples, what empty means and the setup scripts.
- Kinds are named as people read them, such as "Linux desktops on a GPU"
  or "iOS Simulator boxes", not by their IDs. The [kinds
  reference](../reference/kinds.md) maps names to IDs.
- Stale words went: Tart's "ios boxes are not offered yet"; Hetzner's
  desktop image saying "when GPU desktops are on", as Hetzner has no GPU
  desktops; and Proxmox QEMU's line "Windows desktops as VMs", as it also
  makes Linux boxes and Android emulators.
- "Unset" became "Empty", as the page has it.
- Five labels: four SSH host pool labels said "ios" and "sweeps", and one
  Tart label said "sweeps". They now say "iOS" and "resets", like
  Namespace's.
- Three driver lines and two kind descriptions were long or stale, and
  were rewritten the same way (below).
- `helpParts` in `src/backends/types.ts` splits a help text into its first
  sentence and the rest: up to the first full stop, question mark or
  exclamation mark followed by a space. Unit 3's More should use it, so the
  test and the page agree on what "the first sentence" is.
- The reference, `docs/reference/configuration.md` and `kinds.md`, is
  regenerated. It still shows each help text in full.

### Measured

Over all 129 help texts: the 123 backend fields and Tart's 6 fields for
each Mac. Measured by a script over the drivers' descriptors, before and
after, splitting at the same rule as `helpParts`.

| | Before | After |
| --- | --- | --- |
| Help texts changed | | 104 of 129 |
| Longest first sentence | 226 characters | 107 characters |
| Median first sentence | 80 characters | 62 characters |
| First sentences over 120 characters | 19 | 0 |
| First sentences over 100 characters | 44 | 2 |
| Text a page shows with help one step in (first sentences only) | 17,934 characters, as today's page shows every help text in full | 7,665 characters |
| Full help, with what is behind More | 17,934 characters | 19,407 characters |

The full help grew by 8%, because most fields gained an opening sentence
on what they are for. What is behind More is the old text, kept so that no
field loses what a person needs to fill it in.

### Nothing needed went; where words moved

- Defaults: "Off by default" (Tart's shared iOS hosts and video) and
  "Empty, the default" (Tart's iOS image) went from the help. The page
  shows each default beside its field, as 067 section 3 says ("Empty: 4096,
  the default"), and the reference has a Default column.
- Namespace's API token: "It is kept as a secret and never shown" went. The
  page marks it as a secret.
- microsandbox's host: "in a folder of its own" went. "bb-box installs its
  own msb there" stays.
- Kind IDs in help went, for names. A box asked for as `linux-kvm` is still
  named, as an agent asks for it by that word.
- Everything else moved behind More: units, ranges, examples, what empty
  means, the setup scripts and the measured video numbers.

### Driver lines and kind descriptions

| Where | Before | After |
| --- | --- | --- |
| Proxmox QEMU's line | Windows desktops as VMs on a Proxmox VE host. | Windows desktops, Linux boxes and Android emulators, as VMs on a Proxmox VE host. |
| Hetzner Cloud's line | Linux boxes on x86 or Arm, with or without a desktop, as containers on Docker hosts that bb-box makes in a Hetzner Cloud project as boxes need them, and deletes once they are idle. | Linux boxes on x86 or Arm, with or without a desktop, on Hetzner Cloud hosts bb-box makes as boxes need them. Each box is a container on a Docker host, and a host is deleted once it is idle. |
| Namespace's line | Macs and Linux machines rented by the minute from Namespace, one machine for each box, ended when the box is released or at the plan's longest life. | Macs and Linux machines rented by the minute from Namespace, one for each box. A machine ends when its box is released, or at the plan's longest life. |
| The iOS Simulator kind | An iOS Simulator device, an iPhone or iPad, on a macOS VM, or in a slot on a shared Mac or VM: for installing, running and testing iOS apps, shared with a person in the panel. | An iPhone or iPad in the iOS Simulator, for installing, running and testing iOS apps. It runs on a macOS VM, or in a slot on a shared Mac or VM, and is shared with a person in the panel. |
| The Android emulator kind | An Android emulator device, a phone, foldable or tablet, on a Linux VM: for installing, running and testing Android apps, shared with a person in the panel. | A phone, foldable or tablet in the Android emulator, for installing, running and testing Android apps. It runs on a Linux VM, and is shared with a person in the panel. |

Agents read the kind descriptions too, in `box_list` and `bb box kinds`;
they keep every fact.

### Every changed help text

"After: shown" is the first sentence, which the page shows. "After: behind
More" is the rest. A label that changed says what it was.

#### Proxmox LXC

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| API URL | For example https://192.0.2.10:8006/api2/json, as the setup guide's token file gives it. | The Proxmox API's address, from the setup guide's token file. | For example https://192.0.2.10:8006/api2/json. |
| TLS fingerprint | The SHA-256 fingerprint of the Proxmox API's certificate, from the setup guide's token file. bb-box then trusts that certificate alone. Leave empty to check the certificate against its CA. | Pins the Proxmox API's certificate, so bb-box trusts that certificate alone. | Paste its SHA-256 fingerprint from the setup guide's token file. Leave it empty to check the certificate against its CA instead. |
| CA certificate | PEM certificate of the CA that signed the Proxmox API's certificate, when there is no TLS fingerprint. Leave empty for a publicly trusted one. | The CA that signed the Proxmox API's certificate, for when there is no TLS fingerprint. | Paste it as a PEM certificate. Leave it empty when the API's certificate is publicly trusted. |
| API token ID | For example bbbox@pve!plugin. The setup guide lists the privileges it needs. | The Proxmox API token bb-box signs in with, such as bbbox@pve!plugin. | The setup guide lists the privileges it needs. |
| SSH private key | The unencrypted OpenSSH private key the templates were built with (the setup guide's BBBOX_SSH_KEY). Leave empty and bb-box makes one and shows its public key, which the templates must then accept. | The SSH key bb-box reaches boxes with. | Paste the unencrypted OpenSSH private key the templates were built with, the setup guide's BBBOX_SSH_KEY. Leave it empty and bb-box makes one and shows its public key, which the templates must then accept. |
| Resource pool | Boxes are made in this pool. The token needs rights on it. | The Proxmox resource pool boxes are made in. | The token needs rights on it. |
| Linux templates | VMIDs of the CT templates linux boxes are linked clones of, separated by spaces or commas. Empty turns them off. | The CT templates Linux boxes are linked clones of. | List their VMIDs, separated by spaces or commas. Empty turns Linux boxes off. |
| GPU desktop templates | One line per GPU desktop template that linux-desktop boxes are linked clones of: its VMID, a space and the ID of the GPU it carries, such as the UUID nvidia-smi -L shows. Empty turns them off. | The CT templates Linux desktops on a GPU are linked clones of, each with the GPU it carries. | One line per template: its VMID, a space and the GPU's ID, such as the UUID nvidia-smi -L shows. Empty turns these desktops off. |
| CPU desktop templates | VMIDs of the CPU-only desktop templates linux-desktop-cpu boxes are linked clones of, separated by spaces or commas. Empty turns them off. | The CT templates Linux desktops drawn by the CPU are linked clones of. | List their VMIDs, separated by spaces or commas. Empty turns these desktops off. |
| CPU Wayland desktop templates | VMIDs of the CPU-only Wayland desktop templates linux-desktop-wayland-cpu boxes are linked clones of, separated by spaces or commas. Empty turns them off. | The CT templates Linux desktops on Wayland are linked clones of. | List their VMIDs, separated by spaces or commas. Empty turns these desktops off. |
| Desktops per GPU | A new linux-desktop box goes to the GPU with the fewest desktops, and is refused when every GPU runs this many. 0 means no limit. | The most Linux desktops each GPU runs at once. | A new one goes to the GPU with the fewest, and is refused when every GPU runs this many. 0 means no limit. |
| Network bridge | The bridge boxes attach to. | The Proxmox network bridge boxes attach to. |  |
| Subnet | The bridge's subnet in CIDR form. Boxes get static addresses; there is no DHCP. | The bridge's subnet, in CIDR form such as 10.200.0.0/24. | Boxes get static addresses from it; there is no DHCP. |
| Box addresses | The range bb-box hands out. The n-th VMID gets the n-th address. Leave empty to use the whole subnet except the gateway. | The range of addresses boxes get, inside the subnet. | The n-th VMID gets the n-th address. Empty uses the whole subnet except the gateway. |
| First box VMID | Boxes take VMIDs from this range. Keep other guests out of it. | The first VMID boxes take. | Keep other guests out of the range. |
| Last box VMID | The end of the range boxes take VMIDs from. | The last VMID boxes take. |  |
| Memory kept free (MiB) | A new box is refused if the node would have less memory than this left. | Memory the node keeps for itself. | A new box is refused if the node would have less than this left. |
| Disk kept free (GiB) | A new box is refused if the template's storage has less free space than this. | Disk the node keeps free. | A new box is refused if the template's storage has less free space than this. |

#### Proxmox QEMU

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| API URL | For example https://192.0.2.10:8006/api2/json, as the Proxmox LXC setup guide's token file gives it. Leave it, the token, the fingerprint and the CA certificate empty to use Proxmox LXC's. | The Proxmox API's address, from the Proxmox LXC setup guide's token file. | For example https://192.0.2.10:8006/api2/json. Leave it, the token, the fingerprint and the CA certificate empty to use Proxmox LXC's. |
| TLS fingerprint | The SHA-256 fingerprint of the Proxmox API's certificate, from the setup guide's token file. bb-box then trusts that certificate alone. Leave empty to check the certificate against its CA. | Pins the Proxmox API's certificate, so bb-box trusts that certificate alone. | Paste its SHA-256 fingerprint from the setup guide's token file. Leave it empty to check the certificate against its CA instead. |
| CA certificate | PEM certificate of the CA that signed the Proxmox API's certificate, when there is no TLS fingerprint. Leave empty for a publicly trusted one. | The CA that signed the Proxmox API's certificate, for when there is no TLS fingerprint. | Paste it as a PEM certificate. Leave it empty when the API's certificate is publicly trusted. |
| API token ID | For example bbbox@pve!plugin. The setup guide lists the privileges it needs. | The Proxmox API token bb-box signs in with, such as bbbox@pve!plugin. | The setup guide lists the privileges it needs. |
| SSH private key | Paste BBBOX_SSH_KEY, the private key build.sh put in the template, or leave it empty to use Proxmox LXC's. With neither, bb-box makes a key, which the template does not accept until you add its public key. | The SSH key bb-box reaches boxes with. | Paste BBBOX_SSH_KEY, the private key build.sh put in the template, or leave it empty to use Proxmox LXC's. With neither, bb-box makes a key, which the template does not accept until you add its public key. |
| Resource pool | Boxes are made in this pool. The token needs rights on it. | The Proxmox resource pool boxes are made in. | The token needs rights on it. |
| Windows templates | VMIDs of the Windows templates windows-desktop boxes are linked clones of, separated by spaces or commas. setup/proxmox-qemu/build.sh builds one. A new box is cloned from the least used. | The templates Windows desktops are linked clones of. | List their VMIDs, separated by spaces or commas; a new box is cloned from the least used. setup/proxmox-qemu/build.sh builds one. Empty offers no Windows desktops. |
| Linux templates | VMIDs of the Linux templates that linux boxes as VMs are linked clones of, separated by spaces or commas, for a box with its own kernel. setup/proxmox-qemu/build.sh linux builds one. Empty offers no Linux VMs. | The templates Linux boxes as VMs are linked clones of, for a box with its own kernel. | List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh linux builds one. Empty offers no Linux VMs. |
| Linux desktop templates | VMIDs of the Linux desktop templates that linux-desktop-cpu boxes as VMs are linked clones of, separated by spaces or commas, for a desktop with its own kernel. setup/proxmox-qemu/build.sh linux-desktop builds one. Empty offers no Linux desktop VMs. | The templates Linux desktops as VMs are linked clones of, for a desktop with its own kernel. | They are drawn by the CPU. List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh linux-desktop builds one. Empty offers no Linux desktop VMs. |
| Android templates | VMIDs of the Android templates, separated by spaces or commas: the Linux template with the Android SDK, the emulator and a booted device for each model. setup/proxmox-qemu/build.sh android builds one, on a host with nested virtualization, and the nightly job refreshes it monthly. bb-box offers android boxes from it while linux-kvm is on and its record lists its devices. | The templates Android emulator boxes are linked clones of. | Each is the Linux template with the Android SDK, the emulator and a booted device for each model. List their VMIDs, separated by spaces or commas. setup/proxmox-qemu/build.sh android builds one, on a host with nested virtualization, and the nightly job refreshes it monthly. bb-box offers Android boxes while KVM in Linux VM boxes is on and the template's record lists its devices. |
| Windows boxes as BB machines | Windows boxes join BB as machines, so threads and terminals can use them, as Linux and macOS boxes do. Off, they are boxes only. | Windows boxes join BB as machines, so threads and terminals can use them. | Linux and macOS boxes always do. Off, Windows boxes are boxes only. |
| KVM in Linux VM boxes | Linux VM boxes can run VMs of their own through /dev/kvm, and linux-kvm asks for one. Turn it on when the host allows nested virtualization: build.sh linux says whether /dev/kvm works in a clone. | Lets Linux VM boxes run VMs of their own through /dev/kvm. | A box asked for as linux-kvm gets one, and Android emulator boxes need it. Turn it on when the host allows nested virtualization: build.sh linux says whether /dev/kvm works in a clone. |
| Network bridge | The bridge boxes attach to. | The Proxmox network bridge boxes attach to. |  |
| Subnet | The bridge's subnet in CIDR form. Boxes get static addresses; there is no DHCP. | The bridge's subnet, in CIDR form such as 10.200.0.0/24. | Boxes get static addresses from it; there is no DHCP. |
| Box addresses | The range bb-box hands out. The n-th VMID gets the n-th address. Keep it apart from the Proxmox LXC backend's. Leave empty to use the whole subnet except the gateway. | The range of addresses boxes get, inside the subnet. | The n-th VMID gets the n-th address. Keep it apart from Proxmox LXC's. Empty uses the whole subnet except the gateway. |
| First box VMID | Boxes take VMIDs from this range. Keep other guests out of it, the Proxmox LXC backend's too. | The first VMID boxes take. | Keep other guests out of the range, Proxmox LXC's boxes too. |
| Last box VMID | The end of the range boxes take VMIDs from. | The last VMID boxes take. |  |
| Memory kept free (MiB) | A new box is refused if the node would have less memory than this left. | Memory the node keeps for itself. | A new box is refused if the node would have less than this left. |
| Disk kept free (GiB) | A new box is refused if the template's storage has less free space than this. | Disk the node keeps free. | A new box is refused if the template's storage has less free space than this. |

#### SSH host pool

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| Machines | One line per machine: a name, [user@]host[:port], its kinds, and optionally via=<jump host>, reset=machine and labels=<words>. For example "build-1 192.0.2.21 linux" or "mac-mini 192.0.2.30 macos,macos-desktop". ios on a Mac lends iOS slots there, each a macOS user with its own device, for ios boxes asked for with shared: true; ios:<slots> sets how many, where bb-box would estimate them from the Mac. setup/ssh-pool/setup.sh, or setup-mac.sh on a Mac, prints the line for each machine. | Your machines, one line each, with the kinds of box each serves. | A line is a name, [user@]host[:port], its kinds, and optionally via=<jump host>, reset=machine and labels=<words>, such as "build-1 192.0.2.21 linux" or "mac-mini 192.0.2.30 macos,macos-desktop". setup/ssh-pool/setup.sh, or setup-mac.sh on a Mac, prints the line for each machine. The kind ios on a Mac lends iOS slots there, each a macOS user with its own device, for iOS boxes asked for with shared: true; ios:<slots> sets how many, where bb-box would estimate them from the Mac. |
| Host keys | known_hosts lines for every machine and jump host, as setup.sh and setup-mac.sh print them. bb-box connects only to a machine whose key is here. | The SSH host keys of every machine and jump host. | bb-box connects only to a machine whose key is here. Paste the known_hosts lines setup.sh and setup-mac.sh print. |
| SSH private key | An unencrypted OpenSSH private key that the machines' admin user accepts. Leave empty and bb-box makes one and shows its public key, which you then give setup.sh. | The SSH key bb-box logs in to the machines with. | Paste an unencrypted OpenSSH private key that their admin user accepts. Leave it empty and bb-box makes one and shows its public key, which you then give setup.sh. |
| Slots for iOS boxes per Mac (was Slots for ios boxes per Mac) | The most iOS slots a Mac whose line lists ios has making, ready or held at once. It is lent whole only while it lends none. Unset, bb-box estimates it for each Mac: the fewest of its cores over 1.3, its memory over 1.5 GiB after 8 GiB for the Mac, and what its video encoder allows. ios:<slots> on a Mac's line wins. | The most iOS slots each Mac has at once, making, ready or held. | This counts only Macs whose line lists ios, and a Mac is lent whole only while it lends no slot. Empty, bb-box estimates it for each Mac: the fewest of its cores over 1.3, its memory over 1.5 GiB after 8 GiB for the Mac, and what its video encoder allows. ios:<slots> on a Mac's line wins. |
| Ready slots for iOS boxes kept on a Mac (was Ready slots for ios boxes kept on a Mac) | Slots a Mac whose line lists ios keeps ready while it is not lent whole, so the next ios box is ready in seconds. | Slots each Mac keeps ready, so the next iOS box is ready in seconds. | This counts only Macs whose line lists ios, while they are not lent whole. |
| Slots a Mac resets at once (was Slots a Mac sweeps at once) | The most released iOS slots whose files a Mac sweeps in one pass. | The most released iOS slots a Mac resets in one pass, sweeping their files. |  |
| Disk a Mac keeps free (GiB) (was Disk a Mac keeps free of slots (GiB)) | A Mac makes no new iOS slot while it has less free disk than this. | A Mac makes no new iOS slot while it has less free disk than this. |  |

#### Tart

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| SSH private key | The unencrypted OpenSSH private key that each Mac's user and each image's VM user accept. Leave empty and bb-box makes one and shows its public key. | The SSH key bb-box logs in to each Mac and each VM with. | Paste an unencrypted OpenSSH private key that each Mac's user and each image's VM user accept. Leave it empty and bb-box makes one and shows its public key. |
| macOS image | The Tart VM on each Mac that macos boxes, with no desktop shown, are cloned from. Empty turns them off. | The Tart VM on each Mac that macOS boxes, with no desktop shown, are cloned from. | Empty turns them off. |
| macOS desktop image | The Tart VM on each Mac that macos-desktop boxes are cloned from. Empty turns them off. | The Tart VM on each Mac that macOS desktops are cloned from. | Empty turns them off. |
| Linux image (arm64) | The Tart VM on each Mac that linux-arm64 boxes are cloned from, as setup/tart/prepare-linux-image.sh builds it (bb-box-linux). Empty turns them off. | The Tart VM on each Mac that Linux boxes on arm64 are cloned from. | setup/tart/prepare-linux-image.sh builds it, as bb-box-linux. Empty turns them off. |
| Linux desktop image (arm64) | The Tart VM on each Mac that linux-arm64-desktop-cpu boxes are cloned from, as setup/tart/prepare-linux-image.sh --desktop builds it (bb-box-linux-desktop). Empty turns them off. | The Tart VM on each Mac that Linux desktops on arm64 are cloned from. | setup/tart/prepare-linux-image.sh --desktop builds it, as bb-box-linux-desktop. Empty turns them off. |
| Windows image (arm64) | The Windows image on each Mac, in ~/.bb-box/qemu/images, that windows-arm64-desktop boxes are made from, run by QEMU. Empty turns them off. | The image on each Mac that Windows desktops on arm64 are made from, run by QEMU. | It is in ~/.bb-box/qemu/images. Empty turns them off. |
| iOS image | The Tart VM on each Mac that ios boxes are cloned from, as setup/tart/prepare-ios-image.sh builds it on the macOS image (bb-box-ios): idb_companion and a booted-once, slimmed iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5). bb-box checks and refreshes it with the macOS image. Empty, the default, turns it off. ios boxes are not offered yet. | The Tart VM on each Mac that iOS Simulator boxes are cloned from. | setup/tart/prepare-ios-image.sh builds it on the macOS image, as bb-box-ios, with idb_companion and a booted-once, slimmed iPhone 18 Pro, iPhone 17 and iPad Pro 13-inch (M5). bb-box checks and refreshes it with the macOS image. Empty turns iOS boxes off. |
| Shared iOS hosts | ios boxes asked for with shared: true take a slot, a macOS user with its own device, on a VM of the iOS image made as a shared host: made when a box needs one, deleted when its last box is released. Off by default. | Lends iOS boxes as slots on shared hosts, which are VMs of the iOS image. | Each slot is a macOS user with its own device, for an iOS box asked for with shared: true. A host is made when a box needs one, and deleted when its last box is released. |
| Windows boxes as BB machines | Windows boxes join BB as machines, so threads and terminals can use them, as Linux and macOS boxes do. Off, they are boxes only. | Windows boxes join BB as machines, so threads and terminals can use them. | Linux and macOS boxes always do. Off, Windows boxes are boxes only. |
| Video by default for macOS desktops | macOS desktops open as video, from bb-box-stream in the image, not VNC. Off by default: they open as VNC, which is already smooth on a Tart Mac, at 52 to 55 frames a second, and a person can choose video under Display. Video uses much less bandwidth, about 1.2 Mbit/s against 20 while scrolling, but a key shows a little later, about 57 ms against 31. | Opens macOS desktops as video, from bb-box-stream in the image, instead of VNC. | Off, they open as VNC, which is already smooth on a Tart Mac at 52 to 55 frames a second, and a person can choose video under Display. Video uses much less bandwidth, about 1.2 Mbit/s against 20 while scrolling, but a key shows a little later, about 57 ms against 31. |
| VMs per Mac | The most macOS VMs that run on each Mac at once, counting every VM Tart runs there, not only bb-box's. At most 2, which Apple's licence and the Virtualization framework allow. | The most macOS VMs each Mac runs at once, counting every Tart VM there, not only bb-box's. | At most 2, which Apple's licence and the Virtualization framework allow. |
| Memory kept free (MiB) | A new box is refused if the Mac would have less memory than this left for its own use, after its running VMs. | Memory each Mac keeps for its own use. | A new box is refused if the Mac would have less than this left, after its running VMs. |
| Disk kept free (GiB) | A new box is refused if the Mac's disk has less free space than this. | Disk each Mac keeps free. | A new box is refused if the Mac's disk has less free space than this. |
| Hours a macOS warm VM or spare is kept | A suspended macOS warm VM, or a spare that waits suspended, saved longer ago than this is replaced by a fresh one, as an old saved state may not restore. | How long a suspended macOS warm VM or spare is kept before a fresh one replaces it. | An old saved state may not restore. |
| Slots per shared iOS host | The most slots a shared iOS host has making, ready or held at once. Unset, bb-box estimates it for each Mac: the fewest of the host's cores over 1.3, its memory over 1.5 GiB after 8 GiB for the host, and what the Mac's video encoder allows. A Mac's own value wins. | The most slots each shared iOS host has at once, making, ready or held. | Empty, bb-box estimates it for each Mac: the fewest of the host's cores over 1.3, its memory over 1.5 GiB after 8 GiB for the host, and what the Mac's video encoder allows. A Mac's own value wins. |
| Slots a shared iOS host resets at once (was Slots a shared iOS host sweeps at once) | The most released slots whose files a shared iOS host sweeps in one pass. | The most released slots a shared iOS host resets in one pass, sweeping their files. |  |
| Cores of a shared iOS host | The cores of each shared iOS host's VM, shared by its slots. Unset, the Mac's performance cores. A Mac's own value wins. | The cores of each shared iOS host's VM, shared by its slots. | Empty uses the Mac's performance cores. A Mac's own value wins. |
| Memory of a shared iOS host (GiB) | The memory of each shared iOS host's VM, shared by its slots. Unset, 8 GiB for the host and 1.5 GiB for each slot, within the Mac's memory. A Mac's own value wins. | The memory of each shared iOS host's VM, shared by its slots. | Empty uses 8 GiB for the host and 1.5 GiB for each slot, within the Mac's memory. A Mac's own value wins. |
| Slots per shared iOS host (each Mac) | The most slots a shared iOS host on this Mac has, over the backend's setting and bb-box's estimate for the Mac. Empty for those. | The most slots a shared iOS host on this Mac has, in place of the backend's setting. | Empty uses the backend's setting, or else bb-box's estimate for the Mac. |
| Cores of a shared iOS host (each Mac) | The cores of a shared iOS host's VM on this Mac, over the backend's setting and the Mac's performance cores. Empty for those. | The cores of a shared iOS host's VM on this Mac, in place of the backend's setting. | Empty uses the backend's setting, or else the Mac's performance cores. |
| Memory of a shared iOS host (GiB) (each Mac) | The memory of a shared iOS host's VM on this Mac, over the backend's setting and bb-box's estimate. Empty for those. | The memory of a shared iOS host's VM on this Mac, in place of the backend's setting. | Empty uses the backend's setting, or else bb-box's estimate. |

#### Docker

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| Host | Where the Docker daemon is, as unix:///path/to/docker.sock, ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses the docker CLI's own default on BB's server: DOCKER_HOST, its current context, or the local socket. Over SSH, BB's server user must log in without a prompt. | The Docker daemon boxes run on. | Give unix:///path/to/docker.sock, ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Over SSH, BB's server user must log in without a prompt. Empty uses the docker CLI's own default on BB's server: DOCKER_HOST, its current context, or the local socket. |
| Linux image | The image linux boxes run. setup/docker/build.sh builds it. Empty turns them off. | The image Linux boxes run. | setup/docker/build.sh builds it. Empty turns them off. |
| Desktop image | The image linux-desktop-cpu boxes, and linux-desktop boxes when GPU desktops are on, run. setup/docker/build.sh builds it. Empty turns them off. | The image Linux desktops run: those drawn by the CPU, and those on a GPU when GPU desktops are on. | setup/docker/build.sh builds it. Empty turns them off. |
| Wayland desktop image | The image linux-desktop-wayland-cpu boxes run: Sway on Wayland, drawn by the CPU. setup/docker/build.sh builds it. Empty turns them off. | The image Linux desktops on Wayland run: Sway, drawn by the CPU. | setup/docker/build.sh builds it. Empty turns them off. |
| Docker in boxes | Give each box its own Docker daemon, started by its first docker command. Each runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker. | Gives each box its own Docker daemon, started by its first docker command. | Each box then runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker. |
| GPU desktops | Offer linux-desktop boxes on the host's NVIDIA GPUs, which the NVIDIA Container Toolkit lists as CDI devices (nvidia-ctk cdi generate). | Offers Linux desktops on the host's NVIDIA GPUs. | The NVIDIA Container Toolkit must list the GPUs as CDI devices (nvidia-ctk cdi generate). |
| Desktops per GPU | The most linux-desktop boxes that share one GPU. | The most Linux desktops that share one GPU. |  |
| Most boxes | The most bb-box containers on the host at once, running or stopped, counting those of every bb-box install that uses it. | The most bb-box containers on the host at once, running or stopped. | This counts those of every bb-box install that uses the host. |
| Memory kept free (MiB) | A new box is refused if the host would have less memory than this left, after the memory limits of the running boxes. | Memory the host keeps for itself. | A new box is refused if the host would have less than this left, after the memory limits of the running boxes. |

#### microsandbox

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| Host | The host that runs the boxes, a Linux host with KVM or a Mac: ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses BB's server. bb-box installs its own msb there, in a folder of its own. | The host that runs the boxes: a Linux host with KVM, or a Mac. | Give ssh://user@host, or bb:<machine ID> for a BB machine, which bb-box reaches through BB. Empty uses BB's server. bb-box installs its own msb there. |
| Linux image | The image linux boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off. | The image Linux boxes run. | bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off. |
| Desktop image | The image linux-desktop-cpu boxes run. bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off. | The image Linux desktops run, drawn by the CPU. | bb-box imports it from Docker on the host, where setup/docker/build.sh builds it. Empty turns them off. |
| Linux image (arm64) | The image linux-arm64 boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there with setup/docker/build.sh --arch arm64 in a microVM of its own. Empty turns them off. | The image Linux boxes on arm64 run, on an arm64 host such as a Mac. | bb-box imports it from Docker on the host, or builds it there with setup/docker/build.sh --arch arm64 in a microVM of its own. Empty turns them off. |
| Desktop image (arm64) | The image linux-arm64-desktop-cpu boxes run, on an arm64 host such as a Mac. bb-box imports it from Docker on the host, or builds it there in a microVM of its own. Empty turns them off. | The image Linux desktops on arm64 run, on an arm64 host such as a Mac. | bb-box imports it from Docker on the host, or builds it there in a microVM of its own. Empty turns them off. |
| Docker in boxes | Give each box its own Docker daemon, started by its first docker command, with its data on a disk of the box's own. Each box has its own kernel, so this needs no privilege on the host. | Gives each box its own Docker daemon, started by its first docker command. | Its data is on a disk of the box's own. Each box has its own kernel, so this needs no privilege on the host. |
| Network profiles | msb's network profiles for each box, comma-separated: public reaches the internet, private the host's local networks and tailnet, where BB's server often is. | What each box's network reaches, as msb's profiles separated by commas. | The profile public reaches the internet, and private reaches the host's local networks and tailnet, where BB's server often is. |
| Most boxes | The most bb-box microVMs on the host at once, running or stopped, counting those of every bb-box install that uses it. | The most bb-box microVMs on the host at once, running or stopped. | This counts those of every bb-box install that uses the host. |
| Memory kept free (MiB) | A new box is refused if the host would have less memory than this left, after the memory of the running boxes. | Memory the host keeps for itself. | A new box is refused if the host would have less than this left, after the memory of the running boxes. |

#### Hetzner Cloud

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| API token | A Read & Write API token of the Hetzner Cloud project bb-box makes its hosts in, from the project's Security page. The project should hold nothing else. | The API token of the Hetzner Cloud project bb-box makes its hosts in. | Make a Read & Write token on the project's Security page. The project should hold nothing else. |
| Location | Where hosts are made, such as nbg1 (Nuremberg), fsn1 (Falkenstein) or hel1 (Helsinki): near BB's server, as a desktop's stream crosses between them. | The Hetzner location hosts are made in, such as nbg1 (Nuremberg), fsn1 (Falkenstein) or hel1 (Helsinki). | Choose one near BB's server, as a desktop's stream crosses between them. |
| Arm server type | The type of the hosts for linux-arm64 boxes, an Ampere type such as cax31 (8 cores, 16 GB, 160 GB disk). Empty offers no arm64 boxes. Arm hosts have their own host image. | The type of the hosts for Linux boxes on arm64, an Ampere type such as cax31 (8 cores, 16 GB, 160 GB disk). | Empty offers no arm64 boxes. Arm hosts have their own host image. |
| Idle minutes | A host with no box for this long is deleted. Hetzner bills by the started hour, so a shorter time saves little and makes acquires wait for a new host more often. | How long a host with no box waits before it is deleted. | Hetzner bills by the started hour, so a shorter time saves little and makes new boxes wait for a new host more often. |
| Monthly limit (EUR) | bb-box makes no host when this calendar month's spend so far, and an hour more of every host with the new one, would pass this many euros before VAT. A busy host keeps running until it is idle. 0 sets no limit. Hetzner has no limit of its own: set a cost alert in its Console too. | The most bb-box may spend on Hetzner in a calendar month, in euros before VAT. | It makes no host when this month's spend so far, and an hour more of every host with the new one, would pass it. A busy host keeps running until it is idle. 0 sets no limit. Hetzner has no limit of its own: set a cost alert in its Console too. |
| Host image | What hosts start from. An image name, such as ubuntu-26.04, is the base of the host image bb-box builds as a snapshot, with Docker, Tailscale and the box images in it, and rebuilds weekly or when its scripts change, keeping two; until the first is built, hosts start from the image itself. A snapshot's ID makes hosts start from that snapshot, and bb-box builds none. | What hosts start from: an image name or a snapshot's ID. | An image name, such as ubuntu-26.04, is the base of the host image bb-box builds as a snapshot, with Docker, Tailscale and the box images in it. bb-box rebuilds it weekly or when its scripts change, keeping two; until the first is built, hosts start from the image itself. A snapshot's ID makes hosts start from that snapshot, and bb-box builds none. |
| SSH from | Only with the tailnet off: the addresses, as CIDRs separated by commas, that may reach a host's SSH over the internet, such as BB's server's public address. With the tailnet on, a host's SSH is reached on the tailnet alone. | The addresses that may reach a host's SSH over the internet, used only with the tailnet off. | Give CIDRs separated by commas, such as BB's server's public address. With the tailnet on, a host's SSH is reached on the tailnet alone. |
| Linux image | The image linux boxes run. setup/docker/build.sh builds it. Empty turns them off. | The image Linux boxes run. | setup/docker/build.sh builds it. Empty turns them off. |
| Desktop image | The image linux-desktop-cpu boxes, and linux-desktop boxes when GPU desktops are on, run. setup/docker/build.sh builds it. Empty turns them off. | The image Linux desktops run, drawn by the CPU. | setup/docker/build.sh builds it. Empty turns them off. |
| Wayland desktop image | The image linux-desktop-wayland-cpu boxes run: Sway on Wayland, drawn by the CPU. setup/docker/build.sh builds it. Empty turns them off. | The image Linux desktops on Wayland run: Sway, drawn by the CPU. | setup/docker/build.sh builds it. Empty turns them off. |
| Docker in boxes | Give each box its own Docker daemon, started by its first docker command. Each runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker. | Gives each box its own Docker daemon, started by its first docker command. | Each box then runs as a privileged container, which can take over the Docker host. Off, or on rootless Docker, boxes say No Docker. |
| Most boxes | The most bb-box containers on the host at once, running or stopped, counting those of every bb-box install that uses it. | The most bb-box containers on the host at once, running or stopped. | This counts those of every bb-box install that uses the host. |
| Memory kept free (MiB) | A new box is refused if the host would have less memory than this left, after the memory limits of the running boxes. | Memory the host keeps for itself. | A new box is refused if the host would have less than this left, after the memory limits of the running boxes. |

#### Namespace

| Field | Before | After: shown | After: behind More |
| --- | --- | --- | --- |
| API token | A revocable token for the Namespace workspace, from nsc token create, granted the instance actions the guide lists. It is kept as a secret and never shown. | The token bb-box calls Namespace's API with. | Make a revocable token for the workspace with nsc token create, granted the instance actions the guide lists. |
| API region | us or eu: where bb-box calls Namespace's API and its SSH gateway. Where the machines run is the workspace's regional preference, which Namespace's support sets. | Where bb-box calls Namespace's API and its SSH gateway: us or eu. | Where the machines run is the workspace's regional preference, which Namespace's support sets. |
| Longest life (hours) | How long the workspace's plan lets a machine live: 3 hours on Developer, 5 on Team, up to 24 on Business. A box ends then, and its thread hears an hour ahead. | How long the workspace's plan lets a machine live. | That is 3 hours on Developer, 5 on Team and up to 24 on Business. A box ends then, and its thread hears an hour ahead. |
| Shared iOS hosts | Whether Namespace lends ios boxes as macOS users on a shared host: a Namespace Mac made for an ios box that finds no slot on a pool Mac or a Tart host, and deleted when its last box goes. It lends once bb-box has measured that Namespace's Macs run the iOS Simulator. A host takes the workspace's one Mac, so no macos box starts on Namespace while it lives. | Lends iOS boxes as macOS users on a shared Namespace Mac. | A host is made for an iOS box that finds no slot on a pool Mac or a Tart host, and deleted when its last box goes. It lends once bb-box has measured that Namespace's Macs run the iOS Simulator. A host takes the workspace's one Mac, so no macOS box starts on Namespace while it lives. |
| Slots a host lends at most | Empty: bb-box estimates it from the Mac's cores, memory and video encoder, as for a pool Mac. | The most slots a shared host has at once, making, ready or held. | Empty, bb-box estimates it from the Mac's cores, memory and video encoder, as for a pool Mac. |
| Slots a host keeps ready | Ready slots a host keeps while it holds a box. | Slots a shared host keeps ready while it holds a box. |  |
| Slots a host resets at once | Released slots a host sweeps at once, at most. | The most released slots a shared host resets at once. |  |
| Disk a host keeps free (GiB) | Below this much free disk, a host makes no new slot. | A shared host makes no new slot while it has less free disk than this. |  |

### Not changed

These read well already, and are as they were:

- Proxmox LXC: Node; API token secret; Gateway; SSH user.
- Proxmox QEMU: Node; API token secret; Gateway; SSH user.
- Tart: VM user; Ready slots kept on a shared iOS host; Shared iOS hosts per Mac; Disk a shared iOS host keeps free (GiB); Address (each Mac); User (each Mac); Host keys (each Mac).
- Docker: Network.
- microsandbox: Docker disk (GiB); Root disk (GiB); Memory overcommit.
- Hetzner Cloud: Server type; Most hosts; Network.
- Namespace: macOS version; Most machines; Largest machine.

### Checked

- A test, `test/help-text.test.ts`: every field has help; its first
  sentence starts with a capital and ends with a full stop; every first
  sentence of a field's help, a driver's line and a kind's description is
  at most 120 characters; no field's first sentence names a kind by its ID;
  no help says "not offered yet" or "Unset". On the old text 4 of its 5
  tests fail.
- On a Linux box, from a clone of the delivered commit on origin/main:
  `tsc` passed; the full node suite ran 2,713 tests, 2,425 passed, none
  failed and 288 were skipped, each with its reason, such as a fake that
  has no desktop or a check that needs a live BB; vitest passed 256 of 256. The docs test passed, with the
  reference regenerated.
- On a separate BB in a box: a fresh `npx bb-app` 0.48.0 with no account
  and its own data folder, bb-box installed from this branch. Headless
  Chromium opened BB Box's settings and, for each of the 8 backends, opened
  its Set up form, unfolded Advanced and, on Tart, added a Mac. All 129 new
  help texts and their labels were on the page word for word, at 1440 and
  at 390 px wide. Today's page shows each help text in full;
  [Proxmox LXC](067-settings-page/unit-4/form-proxmox-lxc.png) and
  [Tart, with a Mac](067-settings-page/unit-4/form-tart.png) as they read.
- Not looked at in the owner's browser: production runs main, which does
  not have these words yet.

### Open questions for the owner

1. Approve the words above, or name the ones to change.
2. Four labels in the Shared iOS hosts card still differ by backend for
   the same setting, such as Tart's "Slots per shared iOS host" and
   Namespace's "Slots a host lends at most". Unifying them is a label
   change unit 3 could make with its cards. Not done here.
