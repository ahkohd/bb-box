# 110. Windows boot address runs at normal priority without WMI or DAD

Status: Accepted  
Date: 2026-11-28  
Extends: [039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md), [054](054-windows-images-are-refreshed-in-a-box-of-the-current-build.md)

## Context

Fresh Windows desktop clones on Proxmox QEMU took about 48 s or more from VM start to answering port 22, even when the host was not waiting in the start gate. Initial profiling on a 4-core, 8 GiB Windows 11 Pro VM broke down where the time went between `api.start` and TCP port 22 accepting connections:

| Boot scenario (4 cores, 8 GiB, Windows 11 Pro) | NIC up | Task launched | `sshd` listening | `boot.ps1` started | Address set | Address ready |
| --- | --- | --- | --- | --- | --- | --- |
| Fresh clone under host memory stalls (14% PSI) | +76.7 s | +76.5 s | +83.7 s | +130.8 s | +140.4 s | +142.95 s (port 22) |
| Idle reboot, static IP already present | +3.92 s | +3.95 s | +5.04 s | +18.6 s | skipped | +5.04 s |
| Idle reboot, IP cleared to DHCP (old task, Priority 7, WMI, default DAD) | +4.64 s | +4.57 s | +5.88 s | +18.9 s | +19.7 s | +24.25 s (NCSI) |
| Idle reboot, IP cleared to DHCP (native C service prototype, DAD=0) | ~+4.7 s | +4.74 s | ~+5.8 s | +4.74 s | +4.77 to +5.33 s | +5.59 to +6.09 s (NCSI) |

Three causes accounted for the delay after the NIC came up:

1. Task Scheduler ran `bb-box address` at its default Priority 7 (below-normal CPU and low I/O priority), starving PowerShell 5.1 startup during boot (14.3 to 14.7 s idle; 54.3 s under host stalls).
2. `boot.ps1` queried WMI/CIM (`Win32_OperatingSystem`, `Win32_BIOS`, `Win32_NetworkAdapter`, `Win32_NetworkAdapterConfiguration`), waiting for the WMI service and CIM module load during early boot.
3. IPv4 duplicate address detection (`DadTransmits` default 3) kept the new static address `Tentative` for 2.5 to 3.8 s after `netsh` returned, blocking `sshd` from accepting connections on a unique pool address that BB Box already allocates.

A native C service prototype removed PowerShell startup as well and set the address in 26 to 59 ms, reaching ready in 5.6 to 6.1 s idle. However, static review noted that the C service added 544 lines of Windows C code that CI cannot execute, called the undocumented `DhcpNotifyConfigChange` function, wrote directly to `Tcpip` registry keys, and duplicated `boot.ps1` (which `firstlogon.ps1` still uses during template builds). The reviewer could not measure live because six acquire attempts timed out while the host had 8.5% to 12% memory stalls, and recommended taking the simpler route first.

Review also noted that refreshing a Windows template (`ProxmoxQemuBackend` `#capture()`) previously cleared only `C:\bb-box\boot.log` and left the image box's static IPv4 address in the template, unlike `setup/proxmox-qemu/build.sh` which switches the template back to DHCP.

## Decision

- Keep the `bb-box address` startup scheduled task and `setup/proxmox-qemu/answer/bb-box/boot.ps1`, and drop the native C service.
- Register `bb-box address` at Priority 4 (normal CPU and I/O priority) with a 4-minute execution limit in both `setup/proxmox-qemu/answer/bb-box/firstlogon.ps1` and `setup/windows/refresh.ps1` (when `boot.ps1` is staged for `windows-desktop`).
- Rewrite `boot.ps1` without WMI or CIM:
  - Read uptime from `[Environment]::TickCount` masked as unsigned 32-bit milliseconds.
  - Parse the SMBIOS Type 1 serial directly from `HKLM:\SYSTEM\CurrentControlSet\Services\mssmbios\Data` (`SMBiosData`).
  - Poll `[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()` every 50 ms for up to 180 s (matching `READY_TIMEOUT_MS`) for the first non-virtual Ethernet adapter that is up with IPv4 properties bound (skipping WFP and QoS filter adapters).
  - Disable IPv4 duplicate address detection (`netsh interface ipv4 set interface <index> dadtransmits=0`) before applying the static address and gateway, and check `$LASTEXITCODE` on DAD, address and DNS `netsh` calls.
- Extend `Check 'address from the SMBIOS serial'` in `setup/windows/check.ps1` to assert that the address from `boot.log` is assigned and `Preferred`, DHCP is `Disabled` on that adapter, and its IPv4 DNS servers match `C:\bb-box\dns.txt`.
- Clear the image box's static IPv4 route, static IPv4 address, DHCP setting, DNS servers and `C:\bb-box\boot.log` in `ProxmoxQemuBackend`'s `#capture()` before templating, using a detached script that shuts Windows down after clearing the address so SSH returns cleanly and shutdown never races the network reset.

## Measurements

Interleaved 8-boot comparison on a 4-core, 8 GiB Windows 11 Pro VM (clearing IP, default route and DNS to DHCP and resetting `DadTransmits=3` before each reboot, with a native boot probe polling `GetUnicastIpAddressTable` every 10 ms from SCM startup until `IpDadStatePreferred`):

| Condition | Variant | Rep 1 `Preferred` (from boot tick) | Rep 2 `Preferred` (from boot tick) | First seen DAD state | DAD wait |
| --- | --- | --- | --- | --- | --- |
| Idle | Old (Priority 7, WMI, `DadTransmits=3`) | +19.50 s (seen +16.38 s) | +20.02 s (seen +16.72 s) | `Tentative` (1) | 3.13 s / 3.30 s |
| Idle | New (Priority 4, no WMI, `DadTransmits=0`) | +14.11 s (seen +14.11 s) | +15.80 s (seen +15.80 s) | `Preferred` (4) | 0 ms |
| 8-thread CPU load | Old (Priority 7, WMI, `DadTransmits=3`) | Timed out past 240 s (`boot.log` empty, APIPA) | Timed out past 240 s (`boot.log` empty, APIPA) | never seen | N/A |
| 8-thread CPU load | New (Priority 4, no WMI, `DadTransmits=0`) | +16.91 s (seen +16.91 s) | +17.09 s (seen +17.09 s) | `Preferred` (4) | 0 ms |

## Consequences

- Idle boot to `Preferred` drops by 4.2 to 5.4 s (eliminating the 3.1 to 3.3 s DAD delay and WMI overhead), and under full CPU contention the task finishes in about 17 s instead of starving past the 240 s timeout.
- `boot.ps1` stays the single address implementation for both template builds and box boots, with no undocumented Windows APIs or compiled C binaries to maintain.
- Refreshed Windows templates receive the Priority 4 task, WMI-free `boot.ps1`, and a clean DHCP network state automatically, while Tart's `prepare-windows-image.sh` continues to strip the SMBIOS address steps and check cleanly.
- Task Scheduler's `AtStartup` trigger plus PowerShell 5.1 startup still leaves roughly 10 s between SCM service start (~4 s) and `boot.ps1` writing the address (~14 to 16 s idle). If further reduction is needed later, a small wrapper service that invokes `netsh` can be reconsidered without touching Tcpip registry internals.
