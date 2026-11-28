# 108. Proxmox LXC boxes get swap in proportion to their memory

Status: Accepted  
Date: 2026-11-28

## Context

`setup/proxmox-lxc/template/build.sh` creates every Proxmox LXC template with `--swap 512`, linked clones inherit `swap: 512`, and BB Box previously never configured `swap` on containers.

Measurements on a Proxmox host with 72 GiB of swap (mostly zram) and ample free swap showed that large containers hit their 512 MiB `memory.swap.max` cap (one box recorded `memory.swap.events` with `max` 1,428,335 and `fail` 11,417,400). Because cold anonymous memory could not be swapped out, reclaim fell onto file cache instead, driving about 1,250 file refaults a second and memory stall time (PSI `full avg10`) of 52% on a 64 GiB container using 35 GiB and 36% on another, while host swap-out remained about 2 pages a second.

## Decision

- Add an advanced Proxmox LXC setting `swap-percent` (`proxmox-lxc-swap-percent`), taking whole numbers from `0` to `100`, defaulting to `25`.
- Compute each container's swap in MiB as `max(512, round(memoryMiB * swapPercent / 100))`. The 512 MiB floor guarantees no container receives less swap than before, and setting `swap-percent` to `0` keeps every container at 512 MiB.
- Set `swap` through the same Proxmox LXC `/config` API call wherever BB Box sets memory or configures a container to run: acquire (including spares and resumed acquires), warm pool fills and warm claims (`hold`), live and GPU resizes (including rollbacks on failure), forks, restores (both in-place rollback and held-copy adoption), and image boxes. After a successful in-place rollback, the swap update is best effort (caught and logged) so a transient API error cannot mark a completed rollback unknown. Proxmox's `pve-container` applies `swap` live on running containers by writing cgroup v2 `memory.swap.max`, governed by the existing `VM.Config.Memory` token privilege.
- Keep `--swap 512` in `setup/proxmox-lxc/template/build.sh`, because every clone is configured before use.
- Leave existing containers unchanged on deploy; they pick up the new swap on a resize that changes their size, a restore or when made again.
- Keep the start gate's `start-swap-free-mib` rule (decision 106) unchanged. Per-container `memory.swap.max` is a cap, not a reservation of host swap, so larger per-box swap limits do not reduce host `SwapFree` until pages are actually swapped out.

## Consequences

- Large Proxmox LXC containers can page out cold anonymous memory up to their proportional limit instead of thrashing file cache, while small containers keep at least 512 MiB of swap.
- Per-container swap caps can add up to more than the host's swap (for example, at 25%, five 64 GiB containers can swap up to 80 GiB on a host with 72 GiB of swap). Operators should lower `swap-percent` when container swap caps add up to more than host swap.
- Full host swap does not drain by itself: once free swap drops below `start-swap-free-mib` (capped at 5% of total swap), every new start and warm refill waits up to `start-memory-wait-seconds` and then fails until a box is stopped or released, and containers that cannot swap fall back to file cache reclaim.
- On hosts whose swap is zram, swapped pages sit in host RAM that no container's memory limit counts, so a container can hold more host RAM than its configured memory; only the start gate's free-memory rule sees this.
- Containers created before this change keep 512 MiB of swap until resized (with a size change), restored or recreated.
