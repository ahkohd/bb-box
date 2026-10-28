# 066: The Monitor is Beacon moved into bb-box, and a container is judged by its own cgroup

Status: accepted, 28 October 2026, on the owner's direction of that day.

## Context

bb-box had no view of how its machines are doing. The owner uses a separate
plugin, Beacon, for that: machine status in BB's sidebar footer, with a
switcher over BB's server, the owner's own machines and bb-box's boxes, and an
optional background monitor of BB's server that shows a toast when its CPU or
memory stays high. The owner wants that UI and behaviour, in bb-box, and no
monitoring on the box page.

Beacon reads other machines through its own host entry, which BB runs on each
BB machine. That has three gaps for bb-box's boxes:

- A box that is not a BB machine (enrolment off or failed, or its daemon not
  connected) cannot be read at all.
- A shared ios slot (064) is a macOS user on a shared host. Its BB daemon
  sees every user's processes, so its list was the whole Mac's.
- A container reads its host's numbers. In the owner's screenshot a Proxmox
  LXC box of 2 cores at 20% CPU showed Critical, with load 9.22: the
  Proxmox host's load average, which LXCFS passes through, judged against the
  box's 2 cores.

## Decision

1. **One plugin.** Beacon's footer entry, panel, switcher, sections, wording,
   collectors, background monitor, Mac sensors helper and CLI move into
   bb-box, adapted to its layout: the collectors in `src/monitor`, the
   server's side in `src/plugin/monitor.ts`, the panel in `src/app/monitor`,
   and a `monitor` handler in bb-box's own host entry, beside its others.
   There is one host entry, not two.

2. **The UI stays Beacon's.** The same footer entry ("Machine status", the
   server icon), panel, switcher and sections, in the same words. The
   changes the move forces, and the owner's own:
   - Where a reading has no load average of its own (a container), the CPU
     section's pill shows the cgroup's CPU pressure ("pressure 0%") in its
     place, and its details show pressure over 10 s, 1 and 5 min.
   - A shared slot's pills add the host it is on and the Mac's encoder
     room, and its CPU pill says "host load".
   - Long values truncate in the middle, keeping both ends: Tailscale names,
     MagicDNS names, addresses and machine and box names (the owner's
     review). The copy tooltip keeps the full value.
   - The machine switcher keeps Beacon's plain popover; bb-box's own popover
     becomes a drawer on a narrow screen.
   - The Tailscale copy buttons use the browser's clipboard, as bb-box's
     other copy actions do. bb-box's SDK, 0.6.15, has no
     `experimental_copyToClipboard`; Beacon needed SDK 0.6.49 for it, and
     raising bb-box's SDK would raise the BB it needs.

3. **Each machine is read the cheapest way that works:**

   | Machine | Path |
   | --- | --- |
   | BB's server | in bb-box's server process, as Beacon read it |
   | One of your own machines | bb-box's host entry there |
   | A box that is a BB machine and connected: Proxmox LXC, Proxmox VM, Docker, microsandbox, a dedicated ios or macos box | bb-box's host entry in the box |
   | A shared ios or macos slot whose daemon is connected | bb-box's host entry in the slot, listing only the slot user's processes |
   | Any other running Linux or macOS box, a slot whose daemon is away included | one script through bb-box's own command route to the box (SSH or `docker exec`, as box_run uses), parsed on the server |
   | A Windows box that is not a BB machine | not listed: there is no shell bb-box reads there |

   A route reading takes a 300 ms baseline when it starts cold, as Beacon's
   collector does, and readers within the interval share one reading.
   Through the route a Mac gives no CPU percentage, as macOS has no CPU
   counters a single command can read twice; the panel shows a dash there.

4. **A container is judged by its own cgroup.** Where `/sys/fs/cgroup` is a
   namespaced cgroup v2 (it has `memory.max` or `cpu.max`, which the root
   cgroup never has), the reading uses the container's own counters:
   - CPU from `cpu.stat`'s `usage_usec` over the time between readings,
     against its cores: the least of its quota (`cpu.max`), its cpuset
     (`cpuset.cpus.effective`) and the CPUs it can see. On Proxmox LXC the
     limits sit on the parent cgroup, so the cpuset is what holds 2 cores.
   - Memory from `memory.current` less `inactive_file`, against the least of
     `memory.max` and the memory it can see, which LXCFS sets to the box's.
   - Pressure from the cgroup's `cpu.pressure` and `memory.pressure`. Health
     warns when tasks waited for CPU 25% of the last minute, and is critical
     at 50%; for memory, 10% and 25%.
   - No load average is shown or judged: inside a container it is the host's,
     with or without LXCFS.

   The same holds for Docker boxes, whose cgroup is namespaced, and for
   bb-box's server and the background monitor when they run in a container.
   microsandbox boxes and VMs have their own kernel, so their load is their
   own and is kept. A shared slot shows its host's load, named as the host's.

5. **Settings move into the configuration document**, as a `monitor` section:
   `enabled` (on by default; the owner's), `refreshIntervalSeconds` (5, 2 to
   60), `backgroundMonitoring` (off) and `pressureNotifications` (on), with
   Beacon's defaults. The settings page has a Monitor section and the doctor a
   Monitor check. Off, nothing of the Monitor runs: no sampling, no
   background monitor, no helper, and the footer entry goes. BB registers a
   footer entry once, as it loads a plugin's app, so the entry goes or comes
   when BB next loads the page; until then it says it is off.

6. **Beacon's rules on what it never does stay**: it changes no settings,
   kills no process, calls no outside service, and reads processes by name
   and PID only, never their arguments or environment.

## Consequences

- The standalone Beacon plugin is no longer needed once this is deployed. Its
  footer entry and bb-box's both show until it is removed; they keep their
  own settings, logs and remembered choices.
- bb-box gains two dependencies, Hugeicons' free icons and their React
  component, for Beacon's icons.
- The Mac sensors helper is built from `setup/monitor/bb-box-sensors.c` by
  `setup/monitor/build-sensors.sh` on an Apple silicon Mac and embedded with
  its SHA-256. It is written to `~/Library/Caches/bb-box`, checked for its
  owner, mode and hash before it runs, and started once per process.
- A Docker host that gives containers the host's cgroup namespace (cgroup v1,
  or `--cgroupns host`) is not seen as a container, and its boxes read their
  host's numbers, as with Beacon.

What was measured live is in [066 results](066-results.md).
