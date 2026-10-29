# 069 results

What was built and checked for each unit of
[069](069-boxes-page.md). Each unit keeps to its own section.

## Unit 1a: BoxMenu

Built on 29 October 2026. A box's menu is now one component, `BoxMenu`,
for a thread's box and for a machine of your own. Nothing a person sees or
does changes.

### What changed

- `BoxMenu`, in `src/app/box-menu.tsx`, holds the menu's button, its items,
  when each is offered, and the dialogs its items open: New thread on this
  box…, Resize… and the Release confirmation.
- It takes the box, whose it is, where its views open, and whether its
  Resize dialog is open. A thread's box brings its thread, whether it is
  the thread's own BB machine (held), whether New thread is offered, and the
  row's way to Start, Stop, Release and Check now. A machine of your own
  brings whether Open in browser is offered and the row's Start, Stop and
  Remove.
- The row keeps whether Resize is open, as its resize note hides while the
  dialog is open, as before.
- `BoxRow` (the Box panel and the Boxes page's Threads tab) and `MachineRow`
  (the Boxes page's Machines tab) render `BoxMenu` in place of their own
  menus. Their props are unchanged. `BoxAction` moved to `box-menu.tsx`.
- What differed between the two menus still differs, as `BoxMenu` says by
  whose box it is: a machine's menu offers Open desktop only (never a
  device's Simulator or Emulator), Open in browser only on the Boxes page,
  no Check now, and Remove…, which opens the Machines tab's own dialog with
  its in-use guard.

Files: new `src/app/box-menu.tsx`; changed `src/app/box-row.tsx` and
`src/app/settings-machines.tsx`, which also loses imports nothing used and
`isMoving`, which nothing called. Shared files touched: `src/app/desktop.tsx`
and `src/app/panel.tsx`, one import line each, for `BoxAction`. No server
change. No test changed: the app tests already pin each menu item by item,
in each place:

- the panel lists the thread's boxes as rows, opens a row's details, and
  opens a desktop (a desktop box's whole menu, and Open in browser);
- Resize is offered only where the box's backend changes a part (061);
- releasing a box asks first;
- the panel stops and starts a box that can, and not one that cannot (a
  real box's whole menu);
- a row starts a child thread on its box, and opens it; a box that is not a
  BB machine offers no thread;
- the Boxes page's Threads tab (a thread box's whole menu, with no New
  thread) and its Machines tab (Open in browser, Remove… and its dialog);
- the box this thread runs on, without Release or Stop (its whole menu);
- F-19: each screen in a tab of its own (Simulator before Desktop).

### Checked

On a fresh Linux box, 8 cores, on the commits delivered, rebased onto main
`66682093` (main's next commit, `e58e31a6`, changes only
`067-results.md`):

| Check | Result |
| --- | --- |
| `tsc` | passes |
| Node suite | 2,841 tests: 2,553 pass, 0 fail, 288 skipped (the live suites, skipped as on main), 4 min 4 s |
| vitest | 306 pass, in 4 files |
| `test/docs.test.ts`, `test/site.test.ts` and `scripts/reference.ts --check` | pass; the reference is unchanged |

On the live check's box, once that BB and its desktops ran there, one
server test, "High resolution doubles a Linux desktop's pixels with Xfce at
2x…", failed 3 times in 3 on main `c108795e` and on this branch alike; it
passed there before, and passes on the fresh box.

The live check below ran with the branch rebased onto `c108795e`; main's
next commit, `66682093`, changes none of this unit's files.

### Live check on a separate BB

A Linux box with Docker, 8 cores, 16 GiB, ran a fresh `npx bb-app` 0.48.0
with no account, its own data folder and ports, started with `env -i`,
`HOME` and `PATH` only. bb-box was installed with `bb plugin install` of a
path: first main `c108795e` ("before"), then this branch ("after"), over
the same data, so the same boxes. A Docker backend on the box's own Docker
ran bb-box's Linux and Linux desktop images, built with
`setup/docker/build.sh`. A project and a thread were made with `bb project
create` and `bb thread spawn`; the thread's agent has no login, so it
stopped at once, idle.

Boxes, made through bb-box's CLI as a thread or a person would:

- for the thread: ready-heron (Linux) and bright-sparrow (Linux desktop);
- machines of your own: workbench (Linux) and studio (Linux desktop);
- for each run, two more boxes for the thread and one more machine, to be
  released and removed through the menu.

None joined BB as a machine: a BB with no account cannot (bb connect needs
one), so each row says "Could not join BB".

[`live-check.mjs`](069-boxes-page/unit-1a/live-check.mjs) drives headless
Chromium at 1440 by 1000. In each place it opens each box's menu, records
its items, which are disabled and its separators, takes a screenshot, then
uses every item and checks what it did through the page, the clipboard,
new browser tabs, the RPCs the page sent, and bb-box's own state. Both runs
passed, every item doing the same:

| Place | Box | Item | What it did, before and after alike |
| --- | --- | --- | --- |
| Box panel | ready-heron | Copy address | the clipboard held its address |
| | | Check now | sent `refresh` with the thread and the box |
| | | Resize… | opened "Resize ready-heron", which asked `resize` with the thread |
| | | Stop, then Start | stopped, then ready, as bb-box's state said |
| | | Open terminal | a panel tab "Terminal: ready-heron", connected |
| | bright-sparrow | Open in browser | a new browser tab at `/plugins/bb-box/desktop/<thread>/<box>` |
| | | Open desktop | a panel tab "Desktop", streaming the box's desktop |
| | the first spare | Release… | asked "Release …? Its disk and everything on it will be deleted…", then released it |
| Boxes page, Threads | ready-heron | Copy address, Check now, Resize…, Stop, Start | as in the panel |
| | | Open terminal | the page went to `<thread>/<box>/terminal` |
| | bright-sparrow | Open in browser | a new browser tab at the same address as the panel's |
| | | Open desktop | the page went to `<thread>/<box>` |
| | the second spare | Release… | asked, then released it |
| Boxes page, Machines | workbench | Copy address | the clipboard held its address |
| | | Resize… | opened "Resize workbench", which asked `machines.resize`, with no thread |
| | | Stop, then Start | stopped, then ready |
| | | Open terminal | the page went to `operator/<box>/terminal` |
| | studio | Open in browser | a new browser tab at `/plugins/bb-box/desktop/operator/<box>` |
| | | Open desktop | the page went to `operator/<box>` |
| | the spare machine | Remove… | asked "Remove …? Its machine leaves BB…", then removed it |
| BB Box settings | | | no box menu on the page, before or after |

The 13 menus recorded, items in order, were the same in both runs, with
the same disabled items (none) and the same 2 separators each, once each
run's spare boxes' names were set aside:

| Place | Box and state | Items |
| --- | --- | --- |
| Box panel and Threads | ready-heron, ready | Open terminal, Copy address, Stop, Resize…, Check now, Release… |
| | ready-heron, stopped | Copy address, Start, Resize…, Check now, Release… |
| | bright-sparrow, ready | Open desktop, Open in browser, Open terminal, Copy address, Stop, Resize…, Check now, Release… |
| Machines | workbench, ready | Open terminal, Copy address, Stop, Resize…, Remove… |
| | workbench, stopped | Copy address, Start, Resize…, Remove… |
| | studio, ready | Open desktop, Open in browser, Open terminal, Copy address, Stop, Resize…, Remove… |

The runs' records:
[before](069-boxes-page/unit-1a/before-results.json),
[after](069-boxes-page/unit-1a/after-results.json).

### Screenshots, before and after

[`menus-at-sizes.mjs`](069-boxes-page/unit-1a/menus-at-sizes.mjs) opened
each of the four boxes' menus in each place at 1440, 760 and 390 px, dark
and light: 36 screenshots a run, with no spare boxes listed.
[`compare.mjs`](069-boxes-page/unit-1a/compare.mjs) compared them pixel by
pixel. 25 of 36 are identical. In the other 11, 2 to 23 pixels differ, each
by 1 to 3 levels of 255, all on the anti-aliased rounded corners of the
search field, the sidebar's highlight and the footer's pill: none in a
menu or a row.

In the live run's own screenshots, what differs is what should: the spare
boxes' names, and so where their rows sort; the desktop streams; and
settings' "checked 25 minutes ago".

| Place | Before | After |
| --- | --- | --- |
| Box panel, 1440, dark | [ready-heron](069-boxes-page/unit-1a/before-panel-ready-heron-1440-dark.png) | [ready-heron](069-boxes-page/unit-1a/after-panel-ready-heron-1440-dark.png) |
| Box panel, 760, light | [bright-sparrow](069-boxes-page/unit-1a/before-panel-bright-sparrow-760-light.png) | [bright-sparrow](069-boxes-page/unit-1a/after-panel-bright-sparrow-760-light.png) |
| Threads, 1440, light | [bright-sparrow](069-boxes-page/unit-1a/before-threads-bright-sparrow-1440-light.png) | [bright-sparrow](069-boxes-page/unit-1a/after-threads-bright-sparrow-1440-light.png) |
| Threads, 390, dark | [ready-heron](069-boxes-page/unit-1a/before-threads-ready-heron-390-dark.png) | [ready-heron](069-boxes-page/unit-1a/after-threads-ready-heron-390-dark.png) |
| Machines, 1440, dark | [workbench](069-boxes-page/unit-1a/before-machines-workbench-1440-dark.png) | [workbench](069-boxes-page/unit-1a/after-machines-workbench-1440-dark.png) |
| Machines, 390, light | [studio](069-boxes-page/unit-1a/before-machines-studio-390-light.png) | [studio](069-boxes-page/unit-1a/after-machines-studio-390-light.png) |
| Machines, stopped, from the live run | | [workbench](069-boxes-page/unit-1a/after-machines-workbench-stopped.png) |

### Keyboard

On the after install, on each tab of the Boxes page: Tab from the search
field reached the row's menu button (9 stops on Machines, 15 on Threads);
Enter opened the menu with focus on its first item; ArrowDown moved to the
next; End went to Remove… or Release…; Escape closed it with focus back on
the button.

### Not checked live, and why

- New thread on this box…: offered only for a box that joined BB, which a
  BB with no account cannot do. The item and its dialog moved unchanged;
  "a row starts a child thread on its box, and opens it" covers it.
- Open simulator and Open emulator: they need a device box, on a Mac or a
  Linux host with KVM. They are made by the same code as Open desktop
  (`screensOf`); F-19's test covers them.
- The thread's own BB machine in the panel (held), which needs a box that
  joined BB: its test covers its menu, item by item.

### Deviations from 069

- 069's row for unit 1a names the menu "in settings". Settings has had no
  box menu since 067 unit 1 moved your machines to the Boxes page's
  Machines tab; the live check found none on BB Box's settings page, before
  and after. `MachineRow` keeps its settings form (`from="settings"`:
  views with a way back to settings, no Open in browser), which nothing
  renders now; `BoxMenu` keeps it too.

### Follow-ups

- Unit 1c's page menu (069 section 2) lists Check now for every box and,
  for a machine, a device's views; today a machine's menu has neither.
  `BoxMenu` is where to change that, if unit 1c does.
- `MachineRow`'s settings form could go, or serve unit 1c's
  `from-settings` page.

## Unit 1b: the box log, its files and the reach check

Built on 29 October 2026, on main `9676abb5`.

### What it adds

- **Two files beside bb-box's `data.db`.** `box-log.db` and `box-history.db`
  are attached to the SDK's handle as `boxlog` and `boxhistory` at start,
  each in WAL mode with a 4 MB journal limit, and capped at 8 MB and 64 MB.
  Each keeps its migrations in its own `_migrations` table, by the SDK's
  rules: ordered statements, each with its hash, append-only, run in one
  transaction. Where the handle refuses `ATTACH`, the tables go in
  `data.db` under their own migration tables, its cap rises from 10 MB to
  48 MB, and the box log keeps at most 1,000 events. `box-history.db` has
  no tables yet: unit 3 adds them.
- **The box log**, `boxlog.box_events`: box, thread, name, time, kind, who
  (the person, an agent with its thread, a command, bb-box with why,
  outside bb-box, or unknown), and words of at most 1 KB. A failed stop,
  start, resize or release carries what bb-box then observed of the box,
  when, and from which backend; a resize carries the parts that changed,
  read back from the backend after a failure. "Release asked" is written
  before the backend is called and "released" only once it confirms; a
  release that fails keeps its record. Forget writes "forgotten" and
  deletes nothing. A box keeps its last 7 days and its latest event of each
  kind; a released or forgotten box, 24 hours.
- **When the log cannot be written**, the operation still runs, the box
  is marked with the time of the failed write (kept across restarts), and
  the view claims nothing older than it. The doctor reports the failed
  writes.
- **The reach check.** A box that does not answer a command (the Monitor's
  Live readings through its route included), a Live reading through BB's
  host entry, or a terminal, is checked again by itself after 1
  minute, after 5, then every 15 minutes: through BB's connection state for
  a BB machine, then one command through its route. It never calls a
  backend's API. A command to a box it knows does not answer reads no
  power. Check now (`refresh`) checks at once, and reads the box's power at
  most once a minute while it does not answer.
- **The box's view gains** `log` (its last start: asked, ready or failed,
  by whom, first or not; its last stop: when, by whom, asked or not; its
  last failed operation: which, when, the words, what was observed, the
  parts) and `reach` (answers, with when it last answered; not answering,
  with since, the error, the host, attempts and the next check; or its
  backend not in settings).
- **Who asks**, through every way in: the panel's RPC as the person, the
  tools as the agent with its thread, `bb box` as a command, and bb-box's
  own work with why (spares, an ended thread, a crashed VM started again).
  A claimed spare names whoever asked for the box.
  New commands: `bb box stop`, `bb box start` and `bb box forget`; a new
  RPC, `forget`.
- The doctor has a Box log section: where each file is, its events and
  room, its cap read back from the plugin's own connection, and failed
  writes. Two checks join the catalog: `box-log` and `box-history`.

### Checked

On a Linux box, on this commit rebased onto `d5a64b32`: `tsc` clean; the
node suite 2,861 tests, 2,573 passed, 288 skipped, 0 failed, the docs and
site tests among them; vitest 4 files, 321 tests passed;
`scripts/reference.ts --check` passes. Rebased onto `9676abb5`, whose
change beside this one is in `test/app.test.tsx` alone: `tsc` clean, vitest
323 tests passed, this unit's node tests with the docs and site tests 27
passed, and the reference check passes. The new tests
are in `test/box-log.test.ts` (the files and the store, with a set clock
for 24 hours and 7 days), `test/box-events.test.ts` (the registry's events
and the reach check's schedule), and two in `test/plugin.test.ts` (who,
through the panel, a tool and `bb box`; the reach check with the Monitor
off).

| Gate | Test |
| --- | --- |
| G4 | Both files made and migrated on a fresh start, nothing run again on a second, each `max_page_count` and journal as set; a changed statement refused; `box-history.db` filled past its cap leaves the Monitor's `pressure_logs` and the box log writable; with `ATTACH` refused, the tables in `data.db`, its cap 48 MB, kept by the Monitor's store, and 3,000 events of 1.1 KB words taking under 4 MB of it |
| G5 | 10,000 events of 1.1 KB words keep `box-log.db` within its 8 MB cap, each cut to 1 KB; with the file read-only, 4 failed writes, the doctor's fail, and no last stop or start in the view, also after a restart; a failed release keeps its record and logs no "released" until a later release confirms; a restart after the guest was deleted finishes the release by observing it, with no second release, and removes its BB machine; Forget refused while the backend is built, and once it is not, "forgotten", no "released", no stop |
| G6 | A stop that fails records "running, checked then"; the guest stopping later is "stopped" by the asker from the confirmed time, not a stop bb-box did not ask for, unless the backend says its VM crashed, which is started again; a start whose VM runs but never answers SSH records "running", and with its power unreadable "unknown"; a resize refused after its memory changed names memory and puts the size read back on the record |
| G7 | A box that does not answer, over a set hour: checks at 1, 6, 21, 36 and 51 minutes, at most 6 lines logged, no backend call; each next check shown is when it comes; Check now reads power at most once a minute; with the Monitor off, the same, through the plugin |

### Live check on a separate BB

A fresh `npx bb-app` 0.48.0 with no account, its own data folder and ports,
started with `env -i`, `HOME`, `PATH` and `BB_BOX_LIVE_CHECKS=1` only, in a
Linux box with Docker 29.1.3 (8 cores, 16 GiB). bb-box was installed from
this branch with `bb plugin install path:`, and Docker on the box set up
with `bb box setup docker`, its Linux image built in 4 minutes. A `docker`
shim first on BB's `PATH`, [`docker-shim.sh`](069-boxes-page/unit-1b/docker-shim.sh),
logs every call bb-box makes, and on a flag fails one stop or holds one
removal. The agent is a custom ACP agent registered in BB's
`provider-acp` settings, [`acp-agent.mjs`](069-boxes-page/unit-1b/acp-agent.mjs):
it calls BB's own box tools, through the MCP server BB gives it, as a
prompt names them. The person clicks in headless Chromium at 1440 by 1000.
The script is [`live-check.mjs`](069-boxes-page/unit-1b/live-check.mjs).

**Files.** On the first start BB's log said "Opened box-log.db, attached
to bb-box's database: ran 3 migrations." and "Opened box-history.db,
attached to bb-box's database: no migration to run."; both files were
beside `data.db`. `bb box doctor` read the caps back from the plugin's
connection: "24 KB used of its cap of 8.0 MB", and "box-history.db,
attached to bb-box's database, capped at 64.0 MB". After `bb plugin reload
bb-box`, both said "no migration to run". BB 0.48.0's handle took `ATTACH`,
so the fallback ran in tests only.

**Who stopped it.** One box, made by the agent's `box_acquire`; each row is
what the view (`allBoxes`) and `box-log.db` then said:

| Step | The view | Events logged |
| --- | --- | --- |
| The agent's `box_acquire` | last start by the agent in its thread, the first | made by the agent; ready |
| The person: Stop on the Boxes page | stopped, last stop by the person | stop asked, stopped, by the person |
| The person: Start on the Boxes page | last start by the person, ready 248 ms after it was asked | start asked, started, by the person |
| A command: `bb box stop`, then `bb box start --json` | last stop by a command; last start by a command, ready after 249 ms | stop asked, stopped, start asked, started, by the command |
| The agent: `box_stop`, then `box_start` | last stop and start by the agent in its thread | the same four, by the agent, with its thread |
| Outside bb-box: `docker stop` on the host, then `bb box sweep` | stopped, last stop by outside bb-box, not asked; the row's line "It stopped without a request from bb-box at 22:14:55 UTC." | stopped without being asked, outside |
| `bb plugin reload bb-box` | the same last start and stop | all 17 events kept |

![The Boxes page after the stop from outside](069-boxes-page/unit-1b/live-outside-stopped.png)

**Outcomes and releases**, on a second fresh BB set up the same way in the
same box, with machines of its own made by `bb box machines add`. These
ran on the change before an independent code review of it; after the
review's fixes, bb-box was installed again on this BB from this branch
(`0acd5011`, the same change before its last rebases), and the stops above
(15 events, each with the same who), the stop that times out and the
interrupted release ran again, with the same results:

| Step | Result |
| --- | --- |
| A stop that times out, then succeeds: the shim failed `docker container stop` with "timed out waiting for the container to stop" and stopped it 8 s later | Logged "stop failed", observed running, checked then by Docker on the box. The container exited; `bb box sweep` then logged "stopped" by the command, at the time it confirmed it, and no "stopped without being asked"; the failure left the view |
| The box log made read-only: BB stopped, `chmod 444 box-log.db`, BB started | bb-box started; its prune and writes failed and said so. The person's Stop on the Boxes page stopped the box (the container exited). The view gave no last stop, although the log held an earlier stop by the person; the doctor failed: "bb-box could not write 2 events to its box log …". With the file writable again and BB restarted, writes worked and the view still claimed nothing from before the failed writes |
| BB killed between the container's removal and the record's: the shim held `docker container rm` for 40 s after removing it, and `kill -9` stopped BB's server then | The container gone, the record `releasing`, "release asked" with no "released". BB's own supervisor started the server again in 2 s, before its BB machine reconnected, so the first sweep could not reach Docker and logged "release did not finish: sunny-canyon is offline in BB", keeping the record. The next sweep, 3 minutes later, found the guest gone and logged "released" by the command that asked, "bb-box found its guest gone after a restart", with no second `docker rm` |
| Forget while the backend is in settings | Refused: "release the box instead" |
| Forget after Docker was removed from the configuration (with BB stopped, from the stored document, as the settings refuse to remove a backend with boxes) | The view said `not-in-settings`. `bb box forget` logged "forgotten" by the command, with the box's name, its backend and its last state, ready; no "released", no stop. The record went; the container still ran |

**A box that does not answer, for an hour.** The script,
[`reach-hour.mjs`](069-boxes-page/unit-1b/reach-hour.mjs), paused the box's
container with `docker pause` (Docker then reads its power as unknown, so
the box stays ready), ran one `bb box run`, and read the view every 20 s
for 62 minutes. The Monitor was on for the first half and off for the
second; box history does not exist until unit 3.

| Time (UTC) | What happened | Docker calls on the box |
| --- | --- | --- |
| 22:16:26 | Paused; `bb box run` failed: "Box modest-lantern is running but does not answer. The box … did not answer through docker exec." The view: not answering, next check 22:17:26.206 | the command's 2 `exec`, and 1 `container inspect`, the failed command's own power reading |
| 22:17:26.223 | Check 1 | 1 `exec` |
| 22:22:26.243 | Check 2, 5 minutes later | 1 `exec` |
| 22:37:26.262 | Check 3, 15 minutes later | 1 `exec` |
| 22:47:27 | The Monitor turned off | |
| 22:52:26.281 | Check 4 | 1 `exec` |
| 23:07:26.298 | Check 5 | 1 `exec` |
| 23:18:29 | Check now | 1 `container inspect`, 1 `exec`; still not answering |
| 23:18:29 | Check now again, at once | 1 `exec`, no power reading |
| 23:18:29 | Unpaused, then Check now | 1 `exec`: answers |

- In the hour, 6 lines for the box in BB's log: the first failure and
  checks 1 to 5, at 1, 6, 21, 36 and 51 minutes.
- Each check came within 20 ms of the next check the view gave before it
  (22:17:26.206, 22:22:26.223, 22:37:26.243, 22:52:26.262, 23:07:26.281).
- From 22:16:27 until Check now, bb-box made no Docker call about the box
  but one `exec` a check. Its backend's listing, one `container ls` every
  3 minutes for all its boxes, went on as before.
- The checks went on the same with the Monitor off.
- This run was on the change before the review's fixes; its words
  for a failed check, "It did not answer a command within 10 s.", are now
  "It did not answer a command.", as the check fails at once.

### Deviations from 069

- `bb box stop`, `bb box start` and `bb box forget`, and an RPC `forget`,
  are new: 069 names a stop by a `bb box` command and Forget, but no such
  command or call existed. Forget is refused while the box's backend is in
  the settings.
- A failed stop whose box is found stopped within 5 minutes of the
  failure, before any other stop or start, is logged as the asker's stop,
  not as one bb-box did not ask for, unless the backend says the VM
  crashed. Before, such a stop was recorded as unrequested (#406).
- A claimed spare logs "made" by whoever asked for the box, with the
  spare's name, so its last start names them, not bb-box's spares.
- The reach check keeps "last answered" in memory only, so after a restart
  of bb-box it is unknown until a command answers. For a BB machine it asks
  BB's connection state first, and when BB says it is connected, runs one
  command too, so a box that BB sees but bb-box cannot reach is still found.
- Check now's limit of one power reading a minute applies only while the
  box does not answer; otherwise Check now reads its power as before.
- The sweep still lists each backend's guests every 3 minutes, one call per
  backend, as before; the reach check adds no call per box.
- After a restart in the middle of a release, a sweep that cannot read the
  guest's power, as while its BB machine reconnects, tries the release and
  logs it as not finished; the next sweep finishes it.

### Open questions

- The Boxes list (`allBoxes`, `machines.list`) still leaves out a box whose
  release did not finish, as it leaves out every releasing box. Its record
  and its view are kept, with the failure in `log.lastFailed`; whether the
  list shows it, with Release again, belongs to unit 1c or 1d.

### Follow-ups

- Unit 1c: the words for `log` and `reach`; `boxPage` can take a released
  or forgotten box from `app.boxLog.ended(boxId)`; Forget… and Release
  again… call the `forget` and `release` RPCs.
- Unit 3: box history's tables, as migrations of `box-history.db`; its
  readings report a box that does not answer to `app.reach.failed`; a
  released or forgotten box's points go with its log, 24 hours after.
- A desktop viewer that cannot open its route does not yet report to the
  reach check; commands, terminals and the Monitor's readings do.
