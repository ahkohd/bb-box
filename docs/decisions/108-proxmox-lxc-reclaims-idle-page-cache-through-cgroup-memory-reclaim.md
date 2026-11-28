# 108. Proxmox LXC reclaims cold page cache from idle containers through cgroup memory.reclaim

Status: Accepted  
Date: 2026-11-28

## Context

On a Proxmox node with many running LXC containers, idle containers keep gigabytes of cold file-backed page cache. Under memory pressure, especially when one NUMA node runs short of free memory, Linux global reclaim evicts file pages across cgroups in proportion to their cache size rather than sparing busy containers. Busy containers then stall in direct reclaim and repeatedly refault their hot working set, while idle containers hold cold cache they no longer need.

BB Box reaches Proxmox only through its pool-scoped API token and has no root access on the Proxmox host. We tested what an unprivileged LXC container's own root (`sudo`) can trigger from inside:

- `/proc/sys/vm/drop_caches` is mounted read-only inside unprivileged containers (`Read-only file system`, exit 2) and cannot be used.
- `/sys/fs/cgroup/memory.reclaim` is writable by container root (`-rw-rw-r-- nobody root`, mapped to the container's `lxc/<vmid>/ns` cgroup v2) and accepts `<bytes> swappiness=0` on Linux 6.11 and later (including Proxmox VE 9's Linux 6.17 kernel). Writing `<bytes> swappiness=0` frees file-backed page cache (`memory.stat` `file` and `inactive_file`) while leaving `anon`, `shmem` and `memory.swap.current` untouched and adding zero memory stall (`memory.pressure`). Without `swappiness=0`, plain `<bytes>` can swap anonymous pages even while cold file cache is present.

## Decision

Proxmox LXC runs an idle page cache sweep (`src/backends/proxmox-lxc/idle-cache.ts`) inside its existing upkeep loop (`ProxmoxLxcBackend.maintain()`, triggered by the 3-minute sweep and throttled to run at most once a minute).

- **Settings (on by default):** Proxmox LXC adds two advanced settings: `idle-cache-reclaim` (boolean, default `true`) and `idle-cache-minutes` (whole number from `1` to `1440`, default `15`).
- **Idle detection (cheapest reliable signal):** each sweep reads running containers in one Proxmox API call (`GET /nodes/{node}/lxc`, returning `cpu`, `cpus`, `uptime` and `mem`) and filters to this install's running, in-range containers (skipping templates, filling, acquiring, reserved, image and retired containers). A container must have `uptime` at least `idle-cache-minutes`, stay at `cpu <= 0.05` (5% of its allocated cores) continuously across the full idle window, pass a per-container cooldown of `idle-cache-minutes`, and have total reported memory above 192 MiB (the 128 MiB floor plus 64 MiB minimum reclaimable). Before reclaiming, the in-box script also checks `cpu.stat` `usage_usec` against the prior sweep's sample (catching CPU bursts that happened between 3-minute sweeps) and `memory.pressure` (`some` avg10 or avg60 at least 1%, or `full` avg10 or avg60 at least 0.5%).
- **Safe, stepped file-only reclaim:** the sweep runs at most one container at a time over SSH. Inside the container it probes `0 swappiness=0` on `/sys/fs/cgroup/memory.reclaim`; on older kernels without `swappiness=` (such as Proxmox VE 8 on Linux 6.8), it reclaims only when swap has zero headroom (`memory.swap.current >= memory.swap.max`) and skips otherwise, so anonymous memory and `shmem` are never swapped by force. It reclaims file cache above a 128 MiB floor in 256 MiB steps (up to 32 steps per pass), stopping early if swap grows, `memory.pressure` rises (`some` avg10 at least 1%, `full` avg10 at least 0.5%, `some` total increases by 50 ms or more, or `full` total increases by 10 ms or more), `workingset_refault_file` rises by 1024 pages or more in a step, `memory.reclaim` returns `EAGAIN`, or a step frees less than 16 MiB.
- **Fault isolation, logging and doctor:** a container that does not answer SSH or times out after 30 s is skipped quietly without stopping the rest of the sweep. Each container whose cache is freed is logged with the bytes reclaimed, before and after file cache, step count and stop reason. The last 10 sweep summaries persist in backend storage and are reported by `bb box doctor` under `proxmox.idle-cache` ("Idle page cache").

## Consequences

- Idle Proxmox LXC containers return cold page cache above 128 MiB back to the host without host-side root helpers or extra Proxmox API privileges.
- Busy containers, recently booted containers, pressured containers and containers with bursty CPU between sweeps are left untouched, and anonymous memory and `shmem` are never dropped or swapped by force.
- Operators on Proxmox VE 8 (Linux 6.8) with free swap headroom see containers safely skipped rather than swapped; operators on Proxmox VE 9 (Linux 6.17) get file-only reclaim through `swappiness=0`.
- Operators can tune the idle window with `idle-cache-minutes` or turn the sweep off with `idle-cache-reclaim`.
