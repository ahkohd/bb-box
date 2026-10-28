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

## Removing the standalone Beacon plugin

Once bb-box with the Monitor is deployed, both footer entries show. To keep
only bb-box's:

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
