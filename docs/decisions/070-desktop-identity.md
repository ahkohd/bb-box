# Linux desktop identity reset

5 November 2026. Follow-up to decision 070 and decision 071, unit 6.

## What changed

Linux desktop images enable identity reset version 9. Proxmox LXC and
QEMU, Docker, microsandbox, Tart and boat.dev expose the desktop identity
source where they already offer that kind. Tart now offers desktop forks
and Keep. Desktop snapshots need reset version 9; the existing minimum
versions for servers have not changed.

This does not add snapshots to Docker, Hetzner, Namespace or the SSH host
pool. Their existing snapshot limits still apply. Android's reset stays
off. Windows and macOS reset scripts have not changed.

The other fixes from unit 6 are:

- fork admission checks the requested GPU, not the source kind's default
- a fork with no GPU does not need a place on a card
- capacity refusals use fork words before any copy, without telling an
  agent to release a box or change settings
- Proxmox copy and restore VMID refusals, and snapshot tools' hints, give
  agents no release or settings instructions
- an appended `snapshots.db` migration stores the GPU part, card, index
  and NVIDIA userspace; earlier rows stay unrecorded
- takes read the current claim and, for GPU boxes and desktops, the
  userspace version when reachable; restore checks can show a mismatch
- snapshot rows show GPU details for Linux, or a recorded non-none part,
  not empty GPU facts on macOS and Windows
- a GPU-less fork's facts do not fall back to its source template's card,
  at creation, start or the next inventory read

The guides now describe desktop reset version 9. Dated amendments retain
the history of the earlier Tart and boat.dev decisions.

## What differs from a server reset

The shared reset still removes BB's copied host identity and credentials,
the access file and Tailscale state. It renews the machine ID and SSH host
keys unless the provider supplies them, as boat.dev does.

On a desktop it also removes Chrome and Chromium singleton locks, copied
D-Bus session address files and Cua Driver's stale socket. It keeps the
user, UID, desktop settings, saved sessions, browser profile data and
keyrings. The cleanup covers the standard Chrome and Chromium profile
locations, including `google-chrome-*` directories. It does not search
arbitrary custom browser data directories.

The desktop services and the user's systemd service wait for the identity
to be decided, including when an interface appears late. Network setup
can proceed while the settle service waits. Docker runs the check before
starting any desktop process. Startup recreates the display, session bus,
VNC endpoint, Selkies and Cua Driver. A disk fork starts a new desktop
session; it does not resume the source's processes or memory.

## Checks

All workloads ran on disposable Linux boxes, not the coordination machine.

| Check | Result |
| --- | --- |
| `npm run typecheck` | passed |
| node suite, through `npm test` | 3,362 passed, 335 skipped, no failures or cancellations; 3,697 cases, 295.36 s |
| Vitest, through `npm test` | 462 passed in 5 files, 52.31 s |
| `bb plugin build` on the separate BB | passed; existing SDK version and retired-API warnings remain |
| Docker X11 and Wayland image targets | both exported bootable images with reset version 9 enabled; final record-labelling rebuilds were not completed |
| real SQLite migration and record round trip | passed, including old rows, updates, reopen and mismatch words |
| identity reset and backend contract tests | passed for the enabled builds, desktop data, service ordering, GPU admission, facts and both refusal audiences |

The final suite ran on a clean box without the live desktops. Earlier runs
found and fixed a legacy GPU-facts regression and an extra transport probe
which could block the flush timeout. A later mixed run saw the real QA
XFCE panel in a test which expects none; PID isolation also hit a bridge
timing check. The clean final run above passed. One long RPC was aborted,
so the final run kept its log and exit status on the box.

## Live proof and limits

A fresh signed-out BB ran in a Docker box, with its own home, data folder
and ports. It installed bb-box from the bundle's `close-out/desktop-identity`
branch, resolved to implementation commit `3379bebe2643`. The later
review follow-up changes documentation and non-Linux GPU display only.

Both the X11 and Wayland CPU desktops forked as new containers from their
running source's disk. The source's marker was written by bb-box, not by
hand. The delivered guest script was copied into both disposable sources
before the copy, to align them with its final bytes. The enabled switch
came from the built images, not a hand-written marker or an in-place
change to the switch. Each copy booted with version 9, `boot=reset`, a
matching marker and no pending reset. Before enrolment it held neither
its source's BB credentials nor its access file.

For each pair, machine ID and SSH host keys differed, the encrypted test
keyring's bytes matched, and the source's before and after identity
records matched in full. The copy enrolled as a different BB host while
the source stayed connected as its original host. Wayland's addresses and
MACs were checked as different too.

Both copies reopened the copied Chrome HTTP-origin profile and read its
persisted marker. The keyring decrypted the same synthetic value after
unlock. Cua Driver typed different text into source and copy; Chrome's
DOM and desktop captures confirmed the input, with the source unchanged.
X11 used Xtigervnc and XFCE; Wayland used Sway and wayvnc. Both displays
were 1920 by 1080. Selkies delivered video and VNC authenticated and sent
full raw frames. Chrome's restore-pages prompt is expected from a disk
copy of an open browser; the profile data remained present.

Measurements are local functional probes, not a performance benchmark.
Each box had 2 cores and 4 GiB. Video counts came from a 3-second Selkies
probe. CPU and memory are one whole-container `docker stats` sample during
concurrent source and copy probes; 100% CPU means one core.

| Desktop | Source video frames | Copy video frames | Source CPU and memory | Copy CPU and memory |
| --- | --- | --- | --- | --- |
| X11 | 179 | 179 | 26.85%, 1.153 GiB | 28.08%, 778.6 MiB |
| Wayland | 114 | 113 | 16.77%, 762 MiB | 16.10%, 664.7 MiB |

Wayland VNC's first complete 8,294,400-byte frame took 318 ms on the
source and 315 ms on the copy. Sign-in took 158 and 157 ms, using Apple
authentication. X11 took 67 and 63 ms for its first complete frames, with
VNC password sign-in taking 7 and 6 ms. The X11 VNC check followed an
ordinary restart; both identity checks said `boot=kept`, not reset again.
These are single samples over the local Docker bridge, from connection
through authentication and raw frame receipt. They are not browser or
input-to-display latency measurements.

Docker has no snapshot API. Its proof uses a paused `docker commit` of a
running desktop and a new container with a new identity value. Ownership
labels are cleared so the test BB does not treat the copy as an unrecorded
guest of its source. BB's manual provider enrols the copy through a private
command passed on stdin. No credential is printed or included in evidence.
This proves the guest reset and desktop startup, not Docker snapshot tools
or capture of Docker's separate data volume. With no account configured,
Tailscale state removal was checked in the guest-script tests, not on a
live tailnet.

The test BB used direct machine access through its Docker bridge. Its
initial default asked for a Connect account; only the test BB's settings
were changed. A file-URL browser fixture did not prove persisted storage,
so the final fixture used HTTP and was closed and reopened before the
copy. Test helpers were kept outside `/tmp`, which startup or enrolment
can clear. No real browser account or user secret was used.

Docker builds exported both bootable desktop images. Their final
record-labelling passes rebuilt layers because the guest script changed
while the initial build was running. HTTPS workers stalled after
downloads had reached the cache. Only recorded workers of these test builds were
stopped, after checking cached package hashes; pins were not changed.
The labelling rebuilds were still running after the live proof and were
stopped with the test box. This is not a completed standard-image refresh
or image-record labelling check. Production images still need a full
rebuild from the final, unchanged checkout.

Proxmox was not contacted. Neither were a Tart host, a microsandbox host
or boat.dev. Their adapter contracts pass the node suite; their live
backend checks remain the lead's. Only the disposable compute boxes for
this work were acquired and released through the harness. No production
plugin configuration, existing box or owner machine was changed. This
thread pushed, merged and deployed nothing. Both independent reviews
reported GO before the documentation and GPU-display follow-up.

The evidence delivered beside the bundle contains the final check log,
source and copy identity comparisons, connected-host records, profile and
keyring checks, VNC and Selkies measurements, and desktop captures. The
reproduction helpers contain no credentials. The captures are
`x11-source.png`, `x11-copy.png`, `wayland-source.png` and
`wayland-copy.png`.

## Images due for rebuilding

The shared guest scripts are part of each Linux image's program digest.
Rebuild the applicable standard images, then rebuild project images from
those new bases and replace old spares:

| Backend | Images affected |
| --- | --- |
| Proxmox LXC | Linux server, GPU desktop, CPU desktop and Wayland desktop templates |
| Proxmox QEMU | Linux server and CPU desktop templates |
| Docker | Linux, X11 desktop and Wayland desktop images; the arm64 Linux and desktop images where offered |
| microsandbox | its Docker-built Linux and CPU desktop images |
| Tart | arm64 Linux and CPU desktop images |
| boat.dev | Linux and CPU desktop templates |
| Other consumers | Docker-built images used by Hetzner and Namespace |

Android images which track the same shared guest inputs or boat.dev's
combined template fingerprint may also become due. Their reset remains
off. This change does not make Windows or macOS images due.

Use `bb box images list` to resolve the actual image IDs and due reasons.
Existing boxes and snapshots do not acquire version 9 when an image is
rebuilt. Make new desktop boxes and take new snapshots. Old snapshots
retain their refusal and its reason.

## Exact checks for the lead

Run these on a separate test BB with its own authorised pool and VMID
range. Use the established unit 6 node procedure. Do not write identity
markers by hand.

1. Import the bundle and install `close-out/desktop-identity` on the test
   BB. Keep its account, data folder, backend configuration and guests
   separate from production. Resolve image IDs with
   `bb box images list --json`. Build each affected test template with
   `bb box images build <backend/ref> --pinned --try`. After its trial
   passes, use `bb box images build <backend/ref> --pinned` to replace
   only the test image.
2. Confirm that `general.identityResetBackends` includes the test backend.
   Make new GPU, CPU and Wayland desktops from the rebuilt images. In
   each guest, run `sudo bb-box-identity version` and
   `sudo bb-box-identity status`: version 9, enabled, a matching armed
   marker, no pending reset, and its own box ID are required.
3. On the node, for each test guest, run
   `pct exec "$vmid" -- systemd-analyze verify /etc/systemd/system/bb-box-identity.service /etc/systemd/system/bb-box-identity-settle.service`.
   Read `Requires` and `After` with `systemctl show` for the display,
   session, VNC, Selkies and `user@1000.service`, where present. Verify
   that the desktop waits for the settle service, not just the first
   boot check. Check that the system and user D-Bus services work under
   the new machine ID. Repeat the late-interface and reset-failure checks
   from decision 070: no desktop or user daemon starts before a decision.
4. Seed a Chrome HTTP-origin profile marker and an encrypted test keyring.
   Close and reopen Chrome once to prove the marker reached disk. Take
   a snapshot with `bb box snapshot take <box> --name desktop-ready`.
   Fork it once with GPU none and once with shared, using the unit 6
   commands or tools. Each fork must pass the normal identity check,
   with no hand-written marker, and become a different BB machine.
5. Keep both source and fork running. Compare hashes of their machine IDs
   and SSH public host keys, their BB host IDs and addresses. The source
   must keep its identity and one connection. Exercise the fork's
   desktop, Chrome data, keyring unlock, Cua input, VNC and Selkies.
   For the GPU path, confirm the intended card and Xorg renderer too.
6. Keep a desktop snapshot, then release its source. Inspect its held copy
   before it is a template: no GPU claim or NVIDIA device lines, `onboot`
   off, new MAC addresses. Fork the kept snapshot as a new machine and
   repeat the desktop and identity checks.
7. On the test storage which requires a held-copy undo, restore a desktop
   with its undo enabled. Verify that the undo really is a held copy,
   and that a same-box restore keeps the current BB identity and current
   GPU claim. Exercise the desktop again. Repeat the unit 6 swap,
   earlier-guest, interrupted-copy and claim-recovery checks.
8. Fill only the test card capacity. Exercise both an agent's `box_fork`
   and the person's fork. A shared fork must be refused before a clone,
   with fork words and no instruction to release boxes or change settings.
   A fork with none must still work. Exhaust only the test VMID range and
   check the agent's fork and restore refusals too.
9. Use a snapshot with a genuinely older NVIDIA userspace, or a dedicated
   test template containing it, to show the restore mismatch warning.
   Do not change the node's driver. Confirm that the stored part, card,
   index and userspace survive a BB restart. Older records must still
   say GPU not recorded. Confirm that a GPU-less fork shows no source
   card in its facts, including after inventory reconciliation.
10. Re-run the unit 6 claim checks, including `gpu.<card>.whole`. Remove
    only the test guests and their kept copies. Check the test pool and
    ledger for leftovers. Production image rebuilds and smoke tests are
    the lead's separate action after approval.

For QEMU, repeat the guest checks through `qm` and SSH rather than `pct`.
For Tart, stop through BB before taking a Linux desktop snapshot. For
microsandbox and boat.dev, repeat the existing saved-snapshot fork and
restore flows with a fresh desktop image and check its identity value.

## Open items

Full standard-image rebuilds and labelling checks remain for the lead,
as do the native backend and GPU checks above.

The optional suppression of marker-write warnings on an old Docker image
is not included. The image record has a program digest, not an explicit
reset-on field, so the existing probe still reports the old image until
it is rebuilt. No product decision is needed for this change.
