# 066 results: the Monitor, measured

What was checked for [066](066-the-monitor-is-beacon-moved-into-bb-box.md),
on 28 October 2026.

## The container fix

The problem, as Beacon showed it, in production BB through the owner's
browser. Both are Proxmox LXC containers with LXCFS, whose `/proc/loadavg` is
the Proxmox host's:

| Machine | Cores | CPU | Load Beacon showed | Beacon's health |
| --- | --- | --- | --- | --- |
| BB's server | 2 | 2% | 7.73 | Critical |
| An idle linux box | 4 | 7% | 2.81 | Warning |

With the Monitor, read the same way the panel reads them:

| Where | What it read | Health |
| --- | --- | --- |
| A fresh BB in a Proxmox LXC box of 4 cores, its host at load 7 to 10 | CPU 0.2 to 1%, no load average, CPU pressure 1.3% over the last minute | Healthy |
| The same box's reading in the fresh BB's footer panel | CPU 1%, "pressure 3%" in place of "load" | Healthy |
| A Docker container with `--cpus 1.5 --memory 1g`, one process using a whole core, its host at load 10.29 | CPU 66.8% (one core of 1.5), 2 cores shown, 1024 MiB total, no load average | Healthy |

The unit tests hold the owner's case: a 2-core LXC box at 20% CPU with its
host at load 9.22 is Critical by Beacon's rule and Healthy by the box's own
cgroup.

Not measured live: a microsandbox box. It is a microVM with its own kernel and
no namespaced cgroup, so it keeps its own load average, as a VM does.

## The separate BB

A fresh `npx bb-app` (0.46.1) in a linux box, with no account, its data
apart from the box's own BB daemon, and bb-box installed from this branch:

- `bb plugin install path:` installed bb-box with its `monitor` service
  running beside the sweeper and the image service.
- The footer shows bb-box's "Machine status" entry with the server icon, and
  its panel shows Beacon's sections.
- `bb box monitor snapshot` and `health` answered; `logs` said there were
  none; `test-alert` refused while background monitoring is off; the doctor
  showed the Monitor check.

## In production

On 28 October 2026, after the Monitor was deployed (main 6b97557), in BB's
panel through the owner's browser. The switcher listed BB's server, the
operator's six machines and every box, spares included, grouped as Beacon
groups them. A box of each kind was made for the check:

| Machine | How it is read | What it showed |
| --- | --- | --- |
| BB's server, a Proxmox LXC container of 2 cores | in bb-box's server process | Healthy; CPU 10%, "pressure 6%" in place of load. Beacon showed it Critical, from load 7.73 |
| The operator's Mac | bb-box's host entry | Healthy; CPU 15% at 50°C, GPU 12% at 48°C and 0.1 W, from the sensors helper |
| A Proxmox LXC box of 2 cores | bb-box's host entry in the box | Healthy; CPU 0%, "pressure 0%", 560 MB of 4 GB |
| A Proxmox QEMU VM box of 2 cores | bb-box's host entry in the box | Healthy; its own load, 0.01 |
| A shared ios slot on the pool's Mac | bb-box's host entry in the slot, as the slot's user | Healthy; "on" its host, "encoder 0%" with no stream open, "host load 1.06"; only the slot user's processes, its Simulator's among them |
| A dedicated ios box, a Tart VM | bb-box's host entry in the box | Healthy; its own load, and no sensors, as a VM has no SMC |

- The sensors helper was written to `~/Library/Caches/bb-box` on the Mac, as
  `bb-box-sensors-` and the first 16 characters of its SHA-256, the folder
  and file mode 0700 and owned by the user, and one helper ran.
- When background monitoring was turned on, it wrote its first summary at
  once, with memory from the server's cgroup and no load (`load1` null). The
  doctor's two Monitor checks were ok. After `bb box monitor test-alert`, the
  open BB window showed "Test notification", there when looked for a few
  seconds later, and its "Open Status" button opened machine status.
  Background monitoring was then turned off again.
- Both plugins registered an icon named "Server", and BB kept bb-box's, so
  Beacon's footer entry did not show while both were installed. bb-box's icon
  now has a name of its own.

## Removing the standalone Beacon plugin

On this server it was removed after the check above, as `machine-status`,
with its helper folder on the Macs. Elsewhere, once bb-box with the Monitor
is deployed, both footer entries show. To keep only bb-box's:

1. Note Beacon's settings: `bb plugin config machine-status` (the plugin's ID
   on this server; elsewhere it may be `beacon`).
2. Set the same in bb-box's settings, under Monitor, or with
   `bb box config show --json`, a `monitor` section, and `bb box config apply`.
   Beacon's `refreshIntervalSeconds`, `backgroundMonitoring` and
   `pressureNotifications` keep their names.
3. If Beacon's diagnostic logs are wanted, export them first:
   `bb machine-status logs --limit 500 --json > beacon-diagnostics.jsonl`.
4. `bb plugin uninstall machine-status`. This removes Beacon's settings and
   its logs; bb-box keeps its own.
5. Reload BB's page so the footer has only bb-box's entry.
6. On each Mac it read, remove Beacon's helper folder,
   `~/Library/Caches/bb-plugin-beacon`.

## F-24: a section's tooltip no longer follows a scroll

Built on 29 October 2026, from the owner's capture of the same day. In the
panel, a section's details tooltip, such as the CPU card's, moved with the
content while the panel scrolled. It drifted up past the panel's top, over
BB's sidebar, and sometimes faded out where it no longer belonged.

Radix's tooltip already closes when an ancestor of its trigger scrolls, but
it then plays its fade-out while it keeps following its trigger. Within the
300 ms after a close, the next tooltip opens with no delay, so each section
that passed under a still pointer opened its tooltip in turn.

The panel's content tooltips now go through `hud-tooltip.tsx`:

- While the panel scrolls, and for 150 ms after its last scroll event, an
  open tooltip is hidden at once, with no animation, and Radix's own close
  removes it. A pointer move in that time does not open one.
- When the scroll ends, a tooltip opens again only if the pointer stays on a
  section for that section's delay, or moves onto one.
- A tooltip opens only while its trigger shows in the panel's visible area:
  inside the scrolling element, below the sticky header and inside the
  window. A side tooltip whose section's top is under the header starts at
  the header's bottom edge instead.

The header's own tooltips, Reload and Hide, do not scroll and are unchanged.
The panel's look is the same.
