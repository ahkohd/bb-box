# 108. NUMA placement for Proxmox boxes

Status: Draft  
Date: 2026-11-28

Extends [106](106-proxmox-guests-wait-for-free-host-memory-and-heavy-vms-boot-one-at-a-time.md) and [107](107-proxmox-qemu-boxes-enable-the-virtio-balloon-device.md). Design note only: no backend code changes until the design is approved.

## Context

On a multi-NUMA Proxmox host, Proxmox VE places Linux containers and QEMU VMs without regard to NUMA node boundaries or per-node free memory.

Measurements taken on a four-node Proxmox host (62 GiB per node, 251 GiB total) show the cost:

- Per-node free memory drifted to 26, 4, 14 and 4 GiB (66 GiB free host-wide), leaving two nodes short of free RAM while the host overall looked healthy.
- An 8-core LXC box received CPUs `3,16,25,34,41,43-44,59` scattered across all four NUMA nodes, with `cpuset.mems` left open at `0-3`.
- A freshly acquired 2-core unprivileged Proxmox LXC box (kernel `6.17.13-2-pve`, on a 32-core, 64-thread AMD Ryzen Threadripper PRO 9975WX host in NPS4 mode: 8 physical cores and 16 hardware threads per NUMA node) received `cpuset.cpus.effective: 4,51` (CPU 4 on node 0, CPU 51 on node 1) and `cpuset.mems.effective: 0-3`.
- Host counters showed 52 billion `numa_miss` pages and 56.6 million `allocstall_movable` direct-reclaim stalls since boot (2.7 billion `pgsteal_direct` pages), with busy boxes stalling 13 to 17% of the time even though 66 GiB was free across the node as a whole.

This note answers five questions from Proxmox VE 9.x source code and live box measurements, compares the design options with what each needs from the operator, and recommends an approach.

### Sources inspected

Proxmox VE 9.x repositories cloned and checked directly:

- `proxmox/pve-manager` (`9.3.1`, commit `e5ac6d6`)
- `proxmox/pve-container` (`6.1.29`, commit `44a1c93`)
- `proxmox/qemu-server` (`9.2.24`, commit `2f13e34`)
- `proxmox/pve-common` (`9.2.15`, commit `54925b0`)
- `proxmox/pve-guest-common` (`6.0.15`, commit `17c2695`)

Live measurements taken on 2026-11-28:

- A 4-core, 8 GiB Proxmox QEMU Linux box (Ubuntu 24.04, kernel `6.8.0-151-generic`): `lscpu` reports `NUMA node(s): 1` and `NUMA node0 CPU(s): 0-3`; `/sys/devices/system/node/` exposes only the guest's single virtual `node0` (8 GiB); `/proc/sys/kernel/numa_balancing` is `0`. A QEMU box cannot see the host's NUMA layout or per-node free memory.
- A 2-core, 4 GiB unprivileged Proxmox LXC Linux box (kernel `6.17.13-2-pve` on the four-node NPS4 host): `/sys/devices/system/node/` exposes all four host nodes (`node0` CPUs `0-7,32-39`, `node1` CPUs `16-23,48-55`, `node2` CPUs `24-31,56-63`, `node3` CPUs `8-15,40-47`), their `distance` matrix (`10 12 12 12` per row), live per-node `meminfo` and `vmstat`, `/proc/sys/kernel/numa_balancing` (`1`), and `/proc/vmstat`.

## Findings

### 1. LXC: how Proxmox assigns and rebalances CPUs, how to opt out, and what the API refuses

**Random initial CPU selection at container start.** When Proxmox writes a container's runtime LXC config in `PVE::LXC::update_lxc_config` (`pve-container/src/PVE/LXC.pm:886-911`), it checks only whether raw `lxc.cgroup2.cpuset.cpus` is present. When absent, it deletes random CPUs from the host's effective CPU set until `cores` remain:

```perl
    my $had_cpuset = 0;
    if (my $lxcconf = $conf->{lxc}) {
        foreach my $entry (@$lxcconf) {
            my ($k, $v) = @$entry;
            $had_cpuset = 1 if $k eq 'lxc.cgroup2.cpuset.cpus';
            $raw .= "$k = $v\n";
        }
    }
    ...
    my $cores = $conf->{cores};
    if (!$had_cpuset && $cores && $cpuset) {
        my @members = $cpuset->members();
        while (scalar(@members) > $cores) {
            my $randidx = int(rand(scalar(@members)));
            $cpuset->delete($members[$randidx]);
            splice(@members, $randidx, 1); # keep track of the changes
        }
        my $ver = $cpuset_version == 1 ? '' : '2';
        $raw .= "lxc.cgroup$ver.cpuset.cpus = " . $cpuset->short_string() . "\n";
    }
```

Proxmox never writes `cpuset.mems` anywhere in `pve-container`, `pve-manager` or `pve-common`. Every container inherits the root cgroup's `cpuset.mems` (all host NUMA nodes).

**Periodic rebalancing in `pvestatd`.** Every 10 seconds (`my $updatetime = 10;`, `pve-manager/PVE/Service/pvestatd.pm:910`), `update_status()` calls `rebalance_lxc_containers()` (`pvestatd.pm:455-609`, called at line 862). It loads each running container's config from `/etc/pve/lxc/<vmid>.conf` and reads its cgroup `cpuset.cpus` (`pvestatd.pm:517-532`).

A container opts out of rebalancing only if its config file contains `lxc.cgroup.cpuset.cpus` or `lxc.cgroup2.cpuset.cpus` (`pvestatd.pm:534-537`, calling `PVE::LXC::Config::has_lxc_entry` in `pve-container/src/PVE/LXC/Config.pm:2082-2093`):

```perl
        if (
            !PVE::LXC::Config->has_lxc_entry($conf, 'lxc.cgroup.cpuset.cpus')
            && !PVE::LXC::Config->has_lxc_entry($conf, 'lxc.cgroup2.cpuset.cpus')
        ) {
```

Opted-out containers are still counted in `$cpu_ctcount[$cpu]++` (`pvestatd.pm:568-570`), so `pvestatd` accounts for their CPUs when balancing other containers. For every container that does not opt out, `rebalance_lxc_containers` first applies any live `cores` change (`pvestatd.pm:541-561`, growing by lowest-numbered host CPUs), then swaps any CPU whose usage count exceeds another CPU's count by more than 1 (`pvestatd.pm:573-608`):

```perl
        foreach my $candidate (@$cpulist) {
            my $cost = $cpu_ctcount[$candidate];
            if ($cost < ($cur_cost - 1)) {
                $cur_cost = $cost;
                $cur_cpu = $candidate;
            }
        }
```

Because `@allowed_cpus` is a flat numerically sorted list (`PVE::CpuSet::members`, `pve-common/src/PVE/CpuSet.pm:132-137`), `pvestatd` has no NUMA awareness. It scatters containers across all nodes and overwrites any direct cgroup edit to `cpuset.cpus` within 10 seconds unless `lxc.cgroup2.cpuset.cpus` is present in `/etc/pve/lxc/<vmid>.conf`.

**Live `cores` resize caveat when opted out.** In `pve-container/src/PVE/LXC/Config.pm:1699-1709`, `cores` is in `$LXC_FASTPLUG_OPTIONS`, so `PUT /nodes/{node}/lxc/{vmid}/config` updates `cores` in the config file and leaves the cgroup unchanged, relying on `pvestatd` lines 534-561 to apply the change within 10 seconds. Once a container opts out via `lxc.cgroup2.cpuset.cpus`, `pvestatd` skips lines 534-561 completely. Whatever manages `lxc.cgroup2.cpuset.cpus` must therefore also update both `/etc/pve/lxc/<vmid>.conf` and the live cgroups (`cpuset.cpus` on `$cgpath` and `$cgpath/ns`) whenever `cores` changes live.

**What the LXC API refuses.** `PUT /nodes/{node}/lxc/{vmid}/config` (`pve-container/src/PVE/API2/LXC/Config.pm:119-156`) sets `additionalProperties => 0` and takes its schema from `PVE::LXC::Config->json_config_properties` (`pve-container/src/PVE/LXC/Config.pm:1482-1493`). Neither `lxc`, any `lxc.*` key, nor any `cpuset` or `numa` key exists in `$confdesc`. Raw `lxc.*` keys are accepted only when parsing `/etc/pve/lxc/<vmid>.conf` on the host (`is_valid_lxc_conf_key`, `PVE/LXC/Config.pm:851-871`, which allows `lxc.cgroup2.*`). Not even `root@pam` can set `lxc.cgroup2.cpuset.cpus` or `lxc.cgroup2.cpuset.mems` through the HTTP API.

In addition, `check_ct_modify_config_perm` (`pve-container/src/PVE/LXC.pm:1693-1794`) restricts `hookscript` to interactive `root@pam`:

```perl
    return 1 if $authuser eq 'root@pam';
    ...
        } elsif ($opt eq 'hookscript') {
            # For now this is restricted to root@pam
            raise_perm_exc("changing the hookscript is only allowed for root\@pam");
```

Because an API token authenticates as `user@realm!tokenid` (for example `root@pam!name`), no API token passes `$authuser eq 'root@pam'`.

Summary for LXC: nothing set through the Proxmox API with BB Box's token (or any API token) can pin an LXC container's CPUs or memory to a NUMA node, or stop `pvestatd` from scattering its CPUs.

### 2. QEMU: `numa`, `numaN`, `affinity` and their API privileges

**`numa` and `numa0..numa7` work with BB Box's existing API token.** `qemu-server/src/PVE/QemuServer.pm:444-450` defines boolean `numa`, and line 883 registers `numa0` through `numa7` (`$MAX_NUMA = 8`, `PVE/QemuServer/Memory.pm:20`) with format `$numa_fmt` (`Memory.pm:22-57`): `cpus`, `memory`, optional `hostnodes` (validated against `/sys/devices/system/node/node<id>/` at start, `Memory.pm:161-165, 523-538`), and `policy` (`preferred`, `bind` or `interleave`, required whenever `hostnodes` is given, `Memory.pm:439-440`).

At VM start, `PVE::QemuServer::Memory::config` (`qemu-server/src/PVE/QemuServer/Memory.pm:403-460`) generates QEMU's NUMA memory backend:

```perl
            my $mem_object = print_mem_object($conf, $memdev, $numa_memory);
            ...
                $mem_object .= ",host-nodes=$host_node_ranges,policy=$policy";
            ...
            push @$cmd, '-object', $mem_object;
            push @$cmd, '-numa', "node,nodeid=$i,cpus=$cpus,memdev=$memdev";
        }

        die "total memory for NUMA nodes must be equal to vm static memory\n"
            if $numa_totalmemory && $numa_totalmemory != $static_memory;
```

In `qemu-server/src/PVE/API2/Qemu.pm:903-913` and `1115-1130`, both `numa` and `numa\d+` require only `VM.Config.CPU`:

```perl
my $cpuoptions = {
    'cores' => 1,
    'cpu' => 1,
    'runningcpu' => 1,
    'cpulimit' => 1,
    'cpuunits' => 1,
    'numa' => 1,
    'smp' => 1,
    'sockets' => 1,
    'vcpus' => 1,
};
...
my $check_vm_modify_config_perm = sub {
    my ($rpcenv, $authuser, $vmid, $pool, $key_list) = @_;

    return 1 if $authuser eq 'root@pam';
    ...
        if ($cpuoptions->{$opt} || $opt =~ m/^numa\d+$/) {
            $rpcenv->check_vm_perm($authuser, $vmid, $pool, ['VM.Config.CPU']);
```

BB Box's pool role (`setup/proxmox-lxc/host/setup-token.sh:26`) already grants `VM.Config.CPU` on `/pool/<pool>`. BB Box can therefore bind a QEMU VM's RAM to one or more host NUMA nodes through the API today, with either `policy=preferred` or `policy=bind`, and no new privileges.

Constraints on `numaN`:

- Neither `numa` nor `numaN` is hotpluggable (`QemuServer.pm:4744-4746` skips unknown options into `[PENDING]`). Changes take effect at the next start, which already matches BB Box's restart-based CPU and memory resize on Proxmox QEMU.
- Every `cores` or `memory` change must update `numaN` together, because VM start fails if total `numaN` memory does not equal VM memory (`Memory.pm:459-460`) or if vCPU ranges do not match `sockets * cores`.
- `numa0` works alongside `balloon` (`Memory.pm:367-478` has no conflict). It cannot be combined with memory hotplug (`Memory.pm:378-381`), which BB Box does not enable.
- Turning `numa` on or off changes QEMU's RAM block layout (`ram-node0` versus default machine RAM) and ACPI SRAT table, so a hibernated warm spare (`lock: suspended`) cannot have `numa` or `numa0` changed before resume; placement must happen before hibernation.

**`affinity` requires `root@pam` and is refused for every API token.** `QemuServer.pm:743-749` defines `affinity` (`format => 'pve-cpuset'`), and `QemuServer.pm:3211-3213` prepends `taskset` before the KVM binary:

```perl
    if (defined($conf->{affinity})) {
        push @$cmd, '/usr/bin/taskset', '--cpu-list', '--all-tasks', $conf->{affinity};
    }
```

However, `affinity` is absent from `$cpuoptions`, `$memoryoptions`, `$hwtypeoptions`, `$generaloptions`, `$vmpoweroptions`, `$diskoptions` and `$cloudinitoptions` in `qemu-server/src/PVE/API2/Qemu.pm:903-982`. In `$check_vm_modify_config_perm` (`API2/Qemu.pm:1159-1163`), it falls into the final `else` branch:

```perl
        } else {
            # catches args, lock, etc.
            # new options will be checked here
            die "only root can set '$opt' config\n";
        }
```

No Proxmox role privilege grants access to `affinity`, and no API token passes `$authuser eq 'root@pam'` (`API2/Qemu.pm:1118`). Without host-side root assistance, BB Box can bind a QEMU VM's memory via `numa0`, but cannot pin its vCPU threads via `affinity`.

### 3. Per-node free memory and CPU layout: what the API hides and how BB Box can learn it

**Proxmox VE 9.x API exposes no per-NUMA-node memory and no structured CPU topology.**

- `GET /nodes/{node}/status` (`pve-manager/PVE/API2/Nodes.pm:383-580`, `Sys.Audit` on `/nodes/{node}`) calls `PVE::ProcFSTools::read_cpuinfo()` and `PVE::ProcFSTools::read_meminfo()` (`pve-common/src/PVE/ProcFSTools.pm:55-145, 380-439`). `cpuinfo` returns only aggregate `cpus`, `cores`, `sockets` and `model`; `memory` returns only host-wide `total`, `free`, `available` and `used` from `/proc/meminfo`.
- `GET /nodes/{node}/rrddata` returns host-wide metrics only (as noted in [decision 106](106-proxmox-guests-wait-for-free-host-memory-and-heavy-vms-boot-one-at-a-time.md)).
- `GET /nodes/{node}/report` (`Nodes.pm:2054-2076`, `Sys.Audit` on `/nodes/{node}`) calls `PVE::Report::generate()` (`pve-manager/PVE/Report.pm:93-311`), which does run `lscpu` (line 111) and `head /proc/pressure/*` (line 119). However, it runs roughly 40 heavy commands sequentially (`apt-cache policy`, `pvenode apt history`, `qm list`, `pct list`, `zpool status`, `zfs list`, `df`, `iptables-save`, reading all guest config files, each with a 10-second timeout) and still never reads `/sys/devices/system/node/node*/meminfo` or `numactl`. It is unsuitable for polling and still lacks per-node free memory.

**How BB Box could learn topology and live per-node free memory:**

1. **From a Proxmox QEMU box: not possible.** Measured on our 4-core, 8 GiB QEMU Linux box (`Ubuntu 24.04`, kernel `6.8.0-151-generic`): the guest sees only its own single virtual `node0` and cannot see the host's NUMA nodes, CPU lists or free memory.
2. **From an unprivileged Proxmox LXC box: possible today, but fragile and incomplete.** Because `pve-container` mounts sysfs with `lxc.mount.auto = sys:mixed` (`PVE/LXC.pm:747`) and LXCFS does not virtualise `/sys/devices/system/node`, our measured 2-core LXC box could read every host node's `cpulist`, `distance` and `meminfo` (`MemTotal`, `MemFree`, `Active(file)`, `Inactive(file)`, `FilePages`, `SReclaimable`, `KReclaimable` -- Linux per-node `meminfo` omits `MemAvailable`, so available RAM must be estimated from `MemFree` plus reclaimable file and slab pages). This fails on QEMU-only hosts or whenever no LXC box is running, relies on container sysfs visibility that future LXCFS or Proxmox updates could narrow, and still provides no way to pin LXC containers or QEMU `affinity`.
3. **From a static owner setting in BB Box configuration: topology only, no live memory.** A setting can give the node count and CPU lists (which change only across hardware or BIOS changes), but cannot report live per-node free memory. Blind round-robin or counting only BB Box's own boxes ignores ZFS ARC, host processes, other VMs and other BB Box installs -- the exact drift that left two nodes on the measured host at 4 GiB free while another had 26 GiB free.
4. **From a root node-side report helper writing a stopped VM's notes (existing BB Box pattern):** `setup/proxmox-lxc/host/bb-box-gpu-memory` and `setup/proxmox-lxc/host/bb-box-gpu` ([decision 071](071-gpu-boxes.md)) already solve the same API gap for GPU free memory. A root service on the Proxmox node writes structured lines into the `description` of a stopped, protected, diskless VM outside BB Box's pool, where BB Box's user and token hold `PVEAuditor` on `/vms/<vmid>` alone. Extending that mechanism to publish each NUMA node's `cpulist`, `distance`, `MemTotal`, `MemFree`, reclaimable file and slab memory, and live 10-second `/proc/pressure/memory` PSI works on both LXC and QEMU hosts, needs zero boxes running, and adds no token privilege on the pool or `/`.

### 4. Proxmox hookscripts: privileges, timing traps and whether to ship one

**Privilege.** Setting, changing or deleting `hookscript` is restricted to interactive `root@pam` for both LXC (`pve-container/src/PVE/LXC.pm:1774-1776`) and QEMU (`qemu-server/src/PVE/API2/Qemu.pm:1159-1163`). Both `clone_vm` paths (`PVE/API2/LXC.pm:2320-2322` and `PVE/API2/Qemu.pm:4860-4863`) copy `hookscript` from a template into clones, so a template built by root could pass a hookscript to clones. However, `PVE::GuestHelpers::check_hookscript` (`pve-guest-common/src/PVE/GuestHelpers.pm:99-118`) requires the script to live in a storage with `snippets` content enabled and be executable on disk, and `exec_hookscript` (`GuestHelpers.pm:120-160`) fails the entire guest start if `pre-start` errors or if the script file is missing.

**Source-level traps that make hookscripts a poor fit for NUMA placement:**

1. **The guest config lock is already held during `pre-start` and `post-start`.** LXC wraps `vm_start` in `PVE::LXC::Config->lock_config($vmid, ...)` (`pve-container/src/PVE/API2/LXC/Status.pm:190-217`), and QEMU wraps `vm_start_nolock` in `PVE::QemuConfig->lock_config($vmid, ...)` (`qemu-server/src/PVE/QemuServer.pm:5397-5436`). A hookscript that calls `pct set`, `qm set` or `lock_config` deadlocks against its own parent start task and aborts the start after the 10-second lock timeout.
2. **Proxmox does not reload `$conf` after `pre-start`.**
   - In LXC (`pve-container/src/PVE/LXC.pm:3253-3286`), `update_lxc_config($vmid, $conf)` writes `/var/lib/lxc/$vmid/config` on line 3253, *before* `exec_hookscript($conf, $vmid, 'pre-start', 1)` runs on line 3284, and `systemctl start pve-container@$vmid` runs immediately on line 3286 without calling `update_lxc_config` again.
   - In QEMU (`qemu-server/src/PVE/QemuServer.pm:5400, 5529, 5582`), `$conf` is loaded once on line 5400, passed to `pre-start` on line 5529, and then that same in-memory `$conf` is passed to `config_to_command` on line 5582 without reloading. Writing `affinity` or `numa0` to `/etc/pve/qemu-server/$vmid.conf` during `pre-start` has no effect on the boot currently starting.
3. **`post-start` is too late and misses live resizes.**
   - For LXC, writing only `/sys/fs/cgroup/lxc/$vmid/cpuset.cpus` in `post-start` is overwritten by `pvestatd` within 10 seconds unless `/etc/pve/lxc/$vmid.conf` contains `lxc.cgroup2.cpuset.cpus` (which cannot be written safely through Proxmox locking while `vm_start` holds the lock). Furthermore, `post-start` never runs on live `cores` resize.
   - For QEMU, `post-start` (`QemuServer.pm:5955`) runs *after* QEMU has launched and *after* a hibernated warm spare has already loaded its `vmstate` RAM from disk (`QemuServer.pm:5725`), so memory has already been allocated on arbitrary nodes.
4. **No visibility back to BB Box and fragile failure mode.** A hookscript does not report per-node free memory to BB Box's start gate or doctor, requires `snippets` storage setup and template updates, and if removed or broken causes Proxmox to refuse starting every box that references it.

Summary for hookscripts: Proxmox hookscripts are not a sane route for NUMA placement, and BB Box should not ship one in `setup/`.

### 5. What the kernel already does (`numa_balancing`) and what pinning gains or loses

**What `numa_balancing` does today, and why it is not enough.** On the measured Proxmox host, `/proc/sys/kernel/numa_balancing` is `1`. AutoNUMA periodically clears page-table permissions (`numa_pte_updates`: 288 billion) to collect hint faults (`numa_hint_faults`: 229 billion) and tries to converge threads and pages onto the same node. It fails here for three reasons:

- **Scattered LXC cpusets block convergence.** When a container's `cpuset.cpus` spans two or four NUMA nodes (such as `4,51` on a 2-core box or `3,16,25,34,41,43-44,59` on an 8-core box), the scheduler cannot group its threads onto one node. AutoNUMA instead ping-pongs pages back and forth between nodes as threads run on different CPUs, burning CPU on hint faults and TLB shootdowns while `numa_miss` climbs past 52 billion pages.
- **No placement away from short nodes.** When two nodes have 4 GiB free and two have 14 to 26 GiB free, unpinned guests starting on the short nodes fault pages there first, triggering direct reclaim (`allocstall_movable`: 56.6 million) and 13 to 17% stall time before spilling over.
- **Costly EPT page migration for QEMU.** Unpinned QEMU vCPUs spray guest RAM across nodes on first touch, and migrating KVM guest pages under AutoNUMA causes EPT invalidations and VM exits.

**What pinning gains:**

- Keeps a single-node box's threads and memory together (local distance `10` versus remote `12` on single-socket NPS4, and larger gaps on multi-socket servers), improving L3 cache locality and stopping AutoNUMA ping-pong.
- Steers new boxes onto the NUMA node with the most available memory, preventing two nodes from sitting in direct reclaim while 66 GiB is free on the others.
- Stops `pvestatd` from rotating LXC CPUs every 10 seconds (which also avoids the Docker-in-LXC `dockerd` cpuset drift recorded in [decision 062](062-docker-boxes-are-pinned-to-their-cores-and-see-their-memory-through-lxcfs.md)).
- On hosts with NVIDIA GPUs, lets GPU boxes be placed on their card's local PCIe NUMA node (`/sys/bus/pci/devices/<pci>/numa_node`) when that node has room.

**What pinning loses, and the risks that must be handled:**

- **Boxes larger than one NUMA node must span.** BB Box offers custom sizes up to 32 cores and 64 GiB RAM (`linux-desktop`, `linux-desktop-cpu`, `windows-desktop`, `android`; up to 16 cores and 32 GiB for `linux`). On a four-node host with 62 GiB and 16 hardware threads per node (32 cores, 64 threads total) -- or even 32 threads per node on a 128-thread host -- a 32-core or 64 GiB box cannot fit inside one node. Any placement rule must compute the minimum node count `k = max(ceil(cores / cpus_per_node), ceil(memory / usable_mem_per_node))`:
  - `k = 1`: pin to the single best NUMA node.
  - `1 < k < total_nodes`: span the `k` nodes with the most available memory (for QEMU, expose `k` virtual NUMA nodes `numa0..numa{k-1}` mapped 1:1 to those `k` host nodes so Linux and Windows schedule threads locally inside the guest; for LXC, draw `cores` CPUs evenly from those `k` nodes).
  - `k >= total_nodes`: span all nodes (no single-node restriction).
- **Hard memory binding risks single-node OOM kills and reclaim storms.** If a box is hard-bound to node 0 (`cpuset.mems = 0` for LXC, or `policy=bind` for QEMU) and ZFS ARC or other host workloads later grow on node 0, the kernel cannot spill allocations to nodes 1 to 3 even if 30 GiB is free there. It will enter severe direct reclaim or OOM-kill processes inside the box.
  - **QEMU has soft local-first binding built in:** `numa0` with `policy=preferred` (`MPOL_PREFERRED`) allocates on the chosen host node first and spills over only if that node runs out of memory. (For `k > 1` spanning VMs, each virtual node `numa0..numa{k-1}` maps to a single distinct host node with `policy=preferred`.)
  - **LXC gets soft local-first allocation by pinning CPUs only (`lxc.cgroup2.cpuset.cpus`) and leaving `cpuset.mems` unrestricted (`0-3`).** Under Linux's default `MPOL_DEFAULT` policy, every allocation runs on the current CPU's local NUMA node first. Because every thread in the container runs only on node `N`'s CPUs, pages allocate on node `N`, AutoNUMA stops fighting the cpuset and pulls any temporarily spilled pages back to node `N` once space returns, and the container never hits an isolated single-node OOM cliff when ZFS ARC spikes. Hard `lxc.cgroup2.cpuset.mems` should stay off by default (available only as an explicit opt-in if an operator later wants strict isolation).
- **Uneven CPU load across nodes.** Pinning prevents a busy box on node 0 from borrowing idle CPUs on node 2 while `pvestatd` would have spread threads across all nodes. Choosing the placement node by available memory with fewest pinned cores as a tie-breaker keeps nodes balanced across box turnover; the slight loss of cross-node CPU borrowing is a worthwhile trade against 13 to 17% direct-reclaim stalls.

## Options compared

| Option | LXC CPU and memory locality | QEMU memory and vCPU locality | Per-node free memory | API privileges needed | Host files or setup needed | Live LXC `cores` resize | Failure mode if host component stops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **1. API-only (QEMU `numa0` only)** | None | Memory only (`numa0`, no `affinity`) | None from API (LXC sysfs leak only if LXC runs, or blind static config) | None beyond today (`VM.Config.CPU` already granted) | None (optional static node count setting) | Unchanged (Proxmox default) | Not applicable |
| **2. Proxmox hookscripts in `setup/`** | Broken or racy (`pre-start` too late for `update_lxc_config`, `post-start` overwritten by `pvestatd`, config locked) | Broken (`pre-start` not reloaded, `post-start` too late for hibernated `vmstate`) | None | None on token; `root@pam` needed to attach on templates | `snippets` storage, script and template edits | Not handled | **Hard-fails `pct start` and `qm start`** |
| **3. Host helper, report VM and QEMU `numa0` via API (recommended)** | Full (CPU pin to one node via `lxc.cgroup2.cpuset.cpus` with soft local-first memory) | Full (`numa0` `policy=preferred` via API and `affinity` via helper) | Live from `/sys/devices/system/node` (and live 10 s PSI) | `PVEAuditor` on one stopped report VM (none on pool or `/`) | Root systemd service (`bb-box-numa` or extended `bb-box-gpu`) and report VM | Handled live by helper | Safe: boxes still start with Proxmox defaults; doctor warns |
| **4. Give BB Box `root@pam` credentials** | Still impossible over HTTP API (`lxc.*` rejected by schema) | Full | Still none from API | Full root password or ticket (violates least privilege) | None | Still not handled for LXC | Not applicable |

## Recommendation

Adopt **Option 3**, built in two incremental phases so each step delivers value and is proven live before the next:

### Phase 1: Host NUMA report, placement selection, and QEMU `numa0` (no new LXC helper writes yet)

1. **Node-side host report (extending the `bb-box-gpu-memory` report VM pattern):**
   - A small root script and systemd timer (or an extension of `bb-box-gpu` when present, and a standalone `setup/proxmox-lxc/host/setup-numa-report.sh` for hosts without GPUs) reads `/sys/devices/system/node/node*/{cpulist,distance,meminfo}` and `/proc/pressure/memory` every 10 to 15 seconds and writes changed readings into the notes of a stopped, protected report VM where BB Box's token holds `PVEAuditor` only.
   - Format follows the existing indented plain-text convention (`at <epoch>`, `numa <id> <cpulist> <mem_total_mib> <mem_free_mib> <mem_reclaimable_mib>`, `psi memory some <avg10> full <avg10>`).
   - Single-NUMA-node hosts need nothing; BB Box ignores NUMA placement when the report lists fewer than two nodes or is absent.
2. **Start gate and doctor integration (extends [decision 106](106-proxmox-guests-wait-for-free-host-memory-and-heavy-vms-boot-one-at-a-time.md)):**
   - `bb box doctor` (`proxmox.memory`) displays per-NUMA-node free and reclaimable memory when the report is present, replacing the current note that per-bank memory is not read.
   - Live 10-second PSI from the report can feed the start gate when fresher than Proxmox's 60-second RRD sample.
3. **Node selection and QEMU `numa0` via existing API token:**
   - Given the report's per-node topology and live available memory (conservative estimate: `MemFree + Inactive(file) + SReclaimable`, minus a per-node reserve), BB Box computes the minimum node count `k` for the requested box size (`cores` and `memoryMiB`).
   - For QEMU VMs where `k < total_nodes`, BB Box sets `numa=1` and `numa0..numa{k-1}` with `hostnodes=<chosen node>` and `policy=preferred` through the existing `VM.Config.CPU` token privilege on acquire, resize, fork and warm-spare creation (before hibernation). Warm spares are spread across NUMA nodes, and claiming prefers a spare on a node with room.

### Phase 2: Root host placement helper for LXC `cpuset.cpus` and QEMU `affinity`

1. **Extend the host helper pattern from `setup/proxmox-lxc/host/bb-box-gpu` ([decision 071](071-gpu-boxes.md)):**
   - Either add NUMA placement as a module in a shared Proxmox host helper or ship a companion `bb-box-numa` service under `setup/proxmox-lxc/host/` with the same safety model: explicit `pools <pool>` allowlist, `writes off` by default until opted in, `--preview` and `--dry-run`, version reporting in the report VM, and `PVE::LXC::Config->lock_config` / `PVE::QemuConfig->lock_config` discipline.
   - Communication uses the existing pool-scoped marker tag pattern (for example `numa.n0.g<gen>` or `numa.n0-1.g<gen>`), so BB Box's API token still needs zero new privileges on the pool or `/`.
2. **LXC placement and live resize:**
   - Before starting a new or stopped LXC container (and after forks or restores, since `clone_vm` copies `lxc.*` entries from the source), the helper writes `lxc.cgroup2.cpuset.cpus = <subset of node N's CPUs>` into `/etc/pve/lxc/<vmid>.conf`. This pins the container to one NUMA node (or `k` nodes when larger than one node) and opts it out of `pvestatd` rebalancing (`pvestatd.pm:535-536`).
   - `lxc.cgroup2.cpuset.mems` stays unset by default so Linux allocates locally on node `N` via `MPOL_DEFAULT` while still spilling over safely under unexpected host memory pressure (such as ZFS ARC growth). An opt-in setting can enable strict `lxc.cgroup2.cpuset.mems` later if needed.
   - On live LXC `cores` resize, the helper detects the mismatch between `$conf->{cores}` and `lxc.cgroup2.cpuset.cpus` (or a new marker tag), updates both `/etc/pve/lxc/<vmid>.conf` and `/sys/fs/cgroup/lxc/<vmid>{,/ns}/cpuset.cpus` within the same NUMA node (expanding to a second node only if `cores` now exceeds one node's logical CPUs), and avoids touching unrelated containers outside configured pools.
   - For GPU LXC boxes, node selection prefers the assigned card's PCIe `numa_node` when that node has sufficient memory and CPU headroom.
3. **QEMU `affinity`:**
   - Before starting a QEMU VM (including warm spares before hibernation), the helper sets `affinity: <cpulist of chosen node(s)>` in `/etc/pve/qemu-server/<vmid>.conf`, matching the `hostnodes` BB Box set in `numa0..numa{k-1}`.
   - If the helper is stopped or absent, QEMU VMs still start cleanly with their API-configured `numa0` `policy=preferred` memory binding and LXC boxes start cleanly with Proxmox's default cpuset; `bb box doctor` reports that the helper is not running.

### Open questions for the lead before implementation

1. **One helper or two?** Should NUMA reporting and placement be added to `bb-box-gpu` (renaming or expanding it into a general Proxmox host helper on hosts with or without GPUs), or shipped as a separate `bb-box-numa` service sharing the same report VM convention?
2. **Memory policy default:** Confirm soft local-first defaults (`policy=preferred` for QEMU, CPU-only pinning without `cpuset.mems` for LXC) versus hard binding (`policy=bind` and `cpuset.mems`). Soft local-first avoids single-node OOM kills under ZFS ARC spikes while still eliminating cross-node AutoNUMA ping-pong.
3. **Per-node available memory formula:** Linux `/sys/devices/system/node/node*/meminfo` has no `MemAvailable` line. Confirm using `MemFree + Inactive(file) + SReclaimable` (or `MemFree + floor(0.5 * (FilePages + SReclaimable))` capped below `MemTotal`) for placement ranking and start-gate warnings.
4. **Live `pvestatd` coexistence:** Confirm that opted-out BB Box containers are balanced across CPUs within their assigned node by the helper (least-used CPUs first, overlapping when overcommitted, as in [decision 062](062-docker-boxes-are-pinned-to-their-cores-and-see-their-memory-through-lxcfs.md)) while non-BB Box containers remain under `pvestatd`.

## Consequences

- **No backend code changes yet:** this draft records the Proxmox VE 9.x source findings and options for review.
- **No weakening of BB Box's Proxmox token:** neither phase requires `root@pam`, `Sys.Modify` or pool-wide elevation.
- **No hookscripts in `setup/`:** avoids lock deadlocks, stale `$conf` reads, `pvestatd` fights, `snippets` prerequisites and start-blocking failure modes.
- **Oversized boxes stay supported:** boxes whose `cores` or `memory` exceed one NUMA node span the minimum `k` nodes cleanly rather than being refused or starved.
- **Live proof required at implementation time:** once approved, implementation will be measured live on a multi-NUMA Proxmox host (comparing `cpuset.cpus.effective`, `numastat` / per-node `numa_miss`, direct-reclaim stalls and live LXC `cores` resize before and after).
