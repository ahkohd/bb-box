# Computer use

How an agent on another machine sees and drives a box's desktop: reading the
accessibility tree, acting on elements, typing, clicking, scrolling, launching
apps and taking screenshots, on Linux now and Windows and macOS later, and
waiting while you hold control.

Status: recommendation made, measured on a local Linux desktop; Windows and
macOS checked from source and documentation only. Checked on 30 September
2026.

## Recommendation

1. **Use Cua Driver, pinned to one release.** It is the only candidate that
   reads the tree, acts on elements, types, clicks by pixel, scrolls and takes
   screenshots on Linux today, and it has the same tools on Windows and macOS.
   Pin a version and its SHA256 in each template, turn off its telemetry and
   update check, and move the pin only after the conformance suite passes.
   Cua ships a pre-release almost every day and behaviour changed between the
   two versions measured.
2. **Run it as one daemon per box, reached over one long-lived SSH session.**
   The template starts `cua-driver serve` inside the desktop session. The
   bb-box plugin keeps one SSH session per box running `cua-driver mcp
   --socket <path>` and speaks MCP over it. A call then costs 2 to 4 ms of
   transport instead of 165 ms for a new SSH connection, and element
   references live as long as the daemon.
3. **Give the agent bb-box's own tools, not Cua's.** Six tools:
   `computer_observe`, `computer_screenshot`, `computer_act`,
   `computer_type`, `computer_launch` and `computer_windows`. The plugin
   calls a fixed list of Cua tools behind them. This is where the plugin
   enforces shared control, keeps references safe, caps tree size, fixes one
   coordinate space and hides differences between Cua versions.
4. **Elements first, pixels second.** The agent acts on references from the
   latest tree. Pixel clicks are allowed only on the latest screenshot of the
   window, and pixels are the only coordinates the agent ever sees.
5. **Enforce the pause in the plugin.** While you hold control, every
   computer tool refuses at once with a clear message and does not reach the
   box. Taking control also closes the box's MCP session, so nothing queued
   can land afterwards. When you hand back, all references are dropped and
   the agent must observe again.
6. **Grant permissions in the image.** On macOS, write Accessibility and
   Screen Recording grants for Cua's signed app into the image's TCC database
   offline, as Devin does, and log in automatically. On Windows, start the
   daemon from a per-user Scheduled Task in the interactive session, with
   automatic logon.
7. **Not now: accessibility-cli.** It is the base of Devin's macOS computer
   use and its macOS and iOS Simulator support look strong, but on Linux it
   crashed Chrome, cannot type into Chrome, press keys, click by pixel or take
   screenshots, and its element IDs change between calls. It has no releases.
   Look again when it ships releases and its Linux input, and for the iOS
   Simulator kind (see Open questions).

## Requirements

| Requirement | Why |
| --- | --- |
| Reads the tree: roles, names, values, actions, references | Accessibility first: acting on named elements is cheaper and surer than guessing from pixels |
| Acts on elements, types, clicks, scrolls, launches apps and URLs | The agent must finish real tasks in native apps and web apps |
| Screenshots the model sees, within its image limits | Canvas, games and visual checks have no tree; oversized images are rejected |
| References that survive between calls, and fail safely when stale | The agent reads, thinks, then acts; the page may change in between |
| Does not disturb you | You may be watching the same desktop; ideally input does not move the shared pointer |
| Same tools on Linux, Windows and macOS | One agent contract for every backend |
| Pauses while you hold control | Two drivers on one desktop fight; you must be able to take over at any time |
| Installable in a template without a person | Boxes are created on demand; nobody can click through permission prompts |

## Options

| | Cua Driver 0.30.4 | accessibility-cli (f64c036) |
| --- | --- | --- |
| Project | trycua/cua, MIT, 27.5k stars | DioxusLabs, MIT or Apache-2.0, 96 stars |
| Releases | pre-releases almost daily: 0.28.3 on 24 September, 0.30.4 on 28 September, 0.31.0 on 30 September 2026 | none; build from source (releases "planned") |
| Shape | MCP server over stdio, or a daemon (`serve`) with an MCP proxy (`mcp --socket`) | a CLI: one process per call, full tree walk each time; `accessibility-core` is a Rust library |
| Linux tree | AT-SPI, markdown tree with `[index]` and element tokens | AT-SPI, `--format llm` text with numeric IDs |
| Linux input | element actions through AT-SPI; typing and keys through AT-SPI or XTest; pointer through XTest, or MPX with uinput for background | element actions and set value only; no keys, pointer or typing into Chrome |
| Linux screenshots | window and desktop, PNG | not implemented, although the README says it is |
| References | tokens tied to a snapshot, kept by the daemon | walk-order IDs; different in every process |
| Background input | yes on macOS and Windows; on Linux only for AT-SPI actions, or with MPX on real Xorg | macOS: per-process events (SkyLight); Windows: `SendInput`, which moves the cursor |
| Windows | UIA, `PostMessage`, `PrintWindow`; must run in the interactive session | UIA and `SendInput` |
| macOS | AX, SkyLight events, ScreenCaptureKit; signed `CuaDriver.app` holds the grants | AX, SkyLight events, `CGWindowListCreateImage`; the calling process needs the grants |
| iOS Simulator | not documented | yes, a dedicated platform |
| Telemetry | on by default (fixed events, no content); off with `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` | none found |

Other candidates, briefly:

- **Terminator, Windows-MCP and Microsoft UFO3**: Windows only.
- **Peekaboo**: macOS 15 and later only.
- **Playwright MCP and Chrome DevTools MCP**: DOM-level references and fast,
  exact web automation, but only inside a browser started with a debugging
  port, and blind to native dialogs and other apps. A possible complement for
  web-heavy work, not a desktop tool.
- **A bb-box daemon on `accessibility-core`**: a long-lived process would fix
  accessibility-cli's speed and reference problems, but Linux input and
  screenshots would still have to be written.

No other project covers Linux, Windows and macOS with one contract.

## Measurements

All on a local Docker rig: Ubuntu 24.04, XFCE on Xtigervnc at 1920x1080,
Chrome 154 with `--force-renderer-accessibility`, Thunar, Mousepad and the
XFCE terminal, on an x86-64 Linux host. The web app is one page with a
sign-up form, a list of 100 tasks with checkboxes and delete buttons, and a
600x300 canvas with three targets. The rig and scripts are in
[computer-use-rig](computer-use-rig/). Times are wall clock per call from a
client in the box, over MCP stdio for Cua and a new process for
accessibility-cli.

### Tree reading

| Window | Cua elements | Cua time | Cua tree text | accessibility-cli time | accessibility-cli text (`--format llm`) |
| --- | --- | --- | --- | --- | --- |
| Chrome, test page | 365 | 210 to 310 ms | 36.7 KB | 0.7 to 1.3 s | 18 KB; 11.8 KB with `--interactive --visible` |
| Chrome, Wikipedia article | 945 | 630 to 850 ms | 165.6 KB | 1.4 s | 62.4 KB; 22.8 KB with `--interactive` |
| Chrome, Wikipedia, `max_elements` 200 | 200 | 156 ms | 23.3 KB, marked partial | | |
| Thunar | 205 | 120 to 161 ms | 17.8 KB | 1.3 s | 5.5 KB |
| Mousepad | 20 | 22 ms | 2.3 KB | 1.2 s | 16.8 KB (menu items at off-screen positions) |
| XFCE terminal | 20 | 19 ms | 1.5 KB | 1.05 s | 1.3 KB |

- Cua's `query` filter keeps matches and their ancestors: "Delete Task" on
  the test page returned 209 of 365 elements (18.4 KB).
- Cua also returns the tree as structured JSON, three to four times the size
  of the markdown (131.8 KB for the test page). The plugin must pass only the
  markdown to the model.
- A 165 KB tree is about 40,000 tokens. The plugin needs a default budget.
- accessibility-cli's `--visible` still listed off-screen list items.

### Actions in Chrome

The same sequence with Cua in foreground and background delivery, and with
accessibility-cli. The shared pointer started at (1700, 300).

| Action | Cua foreground | Cua background (0.30.4) | accessibility-cli |
| --- | --- | --- | --- |
| Click a text field by element | 0.86 s, pointer moves | refused in 4 ms | no; `--type` fails: "Element does not support setting value" |
| Type text | 0.92 to 1.0 s | refused | not supported |
| Click radio, checkbox or button by element | 1.7 to 2.5 s, pointer moves | 1.4 to 1.9 s, pointer still; radio refused (0.28.3 clicked it) | 0.84 to 0.99 s, pointer still |
| Key chord (Ctrl+A) | 0.84 s | refused | "Keystroke injection is not supported on Linux" |
| Scroll 15 ticks | 3.5 s | refused | not supported |
| Pixel click on the canvas | 2.0 to 2.35 s, within 1 px of each target | refused | "Mouse clicks are not supported on Linux" |
| Window screenshot | 1213x948 PNG, about 109 KB, about 50 ms on top of the tree | same | "not yet implemented on Linux" |
| Desktop screenshot | 1280x720 PNG, 94.6 KB, 52 to 108 ms | same | as above |
| Form result | "Saved Ada Lovelace <ada@example.org> United Kingdom pro news=yes" | "Saved <> United Kingdom free news=yes" | radio, checkbox and submit only |

- Cua's background refusals are clear and fast: "Background delivery is not
  available: Chromium/Electron does not accept pointer or keyboard input
  addressed to an occluded, unfocused renderer through X11 background
  injection. Retry this action with ..." Background pointer input on Linux
  needs real Xorg with MPX and `/dev/uinput`, which Xtigervnc and Xvfb do not
  provide.
- Foreground actions report "not verified, confirm with a screenshot".
  Element clicks in Chrome took 1.4 to 2.5 s in either mode, where AT-SPI
  actions in GTK apps took milliseconds.
- `launch_app` with a URL opened it, but in a second Chrome window with the
  same title.

### GTK apps

| Action | Cua | accessibility-cli |
| --- | --- | --- |
| Set the Mousepad text | 5 ms through AT-SPI, read back | 664 ms, pointer still (as `TextArea`; `TextInput` finds nothing) |
| Type into Mousepad | 13 to 18 ms through AT-SPI in either mode, read back, pointer still | not supported |
| Click a Thunar toolbar button | 296 ms in background, pointer still | "Back" matched 3 elements; the query had to be made unique |
| Type a command in the terminal | background refused; foreground 1.3 s through XTest key events, pointer still | not supported |

### References

- **Cua tokens** (for example `s00000001:26`) kept working after later
  actions, after desktop screenshots and after reading another app's tree, in
  the same process. A new process rejected them.
- **Stale tokens after the page changed**: we deleted Task 1, then used the
  old token for "Delete Task 3". In foreground mode Cua clicked the old
  position and deleted Task 4. In background mode it acted on the element
  itself and deleted Task 3.
- **Pixel clicks need a screenshot**: a pixel click fails with "The latest
  snapshot for this window does not contain a screenshot owned by this
  session" if the last observation of that window had no image. This is a
  useful guard: the agent cannot click pixels it has not seen.
- **accessibility-cli IDs** are the order of a fresh tree walk, so an ID from
  one call named a different element in the next, including Chrome's own
  toolbar buttons. Title selectors are safer but can be ambiguous.

### Coordinates

- Cua's pixel `x` and `y` are pixels of the window screenshot it returned.
  The 1280-pixel-wide window came back 1213 pixels wide (scale 0.94765625):
  Cua keeps screenshots at or below 1.15 megapixels. Clicks at the three
  targets found in the screenshot landed at canvas (99, 100), (300, 150) and
  (500, 250), within 1 pixel.
- Element frames in the tree are in screen coordinates, although Cua's note
  says otherwise. Clicking at a frame position plus an offset, as pixels,
  missed by (12, 67) pixels. The plugin must never show the agent frames and
  pixels together.

### Transport and screenshots

| Measure | Result |
| --- | --- |
| New SSH connection per call | 165 ms before the tool runs |
| One long-lived SSH session | 263 ms to start, then 2 to 4 ms per call |
| `docker exec` per call | 30 ms |
| Capture a 1920x1080 frame (PIL, scrot) | 5 ms, 45 ms |
| Encode 1280x720: JPEG quality 80, PNG | 71 KB, about 100 KB |

Claude reads images in 28-pixel patches. The standard limit is a long edge
of 1568 pixels and 1568 visual tokens; models with the high-resolution tier
allow 2576 pixels and 4784 tokens. Images over the limit in a tool result are
rejected, and with more than 20 images in a request each must be under 2000
pixels. Cua's 1.15-megapixel window screenshots come to about 1,500 tokens,
inside the standard limit.

## Failure modes found

- **Chrome's tree is empty** unless `org.a11y.Status IsEnabled` is true
  before Chrome starts. Chrome 154 also needs `--force-renderer-accessibility`.
  Cua sets `IsEnabled` itself; accessibility-cli does not.
- **accessibility-cli crashes Chrome on its first tree read.** Its D-Bus
  proxies fetch every property with `GetAll("org.a11y.atspi.Value")`, which
  crashes Chrome. Turning off property caching
  ([acli-no-getall.patch](computer-use-rig/acli-no-getall.patch)) fixes it.
  Not yet reported upstream.
- **Foreground clicks on stale tokens hit the wrong element** (above).
- **Mixed coordinate spaces** miss by tens of pixels (above).
- **A second window with the same title** after `launch_app` makes window
  selection by title ambiguous; always select by window ID.
- **Behaviour changes between releases**: 0.30.4 refuses background radio
  clicks that 0.28.3 performed.
- **Leftover input devices**: Cua's MPX path can leave a master pointer and
  keyboard behind if killed mid-action; the next daemon start removes them
  (Cua's `linux-mpx-recovery.md`).
- **Tree size**: a long article is 165 KB of text.

## Design

```
agent (BB thread)             bb-box plugin (BB server)                     box
computer_* tools  --call-->   control check                                 cua-driver serve
                              reference map, budgets       --one ssh-->     (desktop session,
                              one MCP session per box       cua-driver mcp    socket or pipe)
                                                             --socket <path>
```

- **In the box**: the template installs a pinned Cua Driver and starts
  `cua-driver serve` inside the logged-in desktop session, with telemetry and
  the update check off. On Linux this is a user service that knows the
  display, the session bus and the AT-SPI bus, and sets `IsEnabled` before
  the desktop starts apps.
- **In the plugin**: on the first computer tool call for a box, the plugin
  opens one SSH session running `cua-driver mcp --socket <path>` and keeps it
  open. It closes it after 10 idle minutes, when you take control, and when
  the box is released. A failed session is reopened once, then the tool
  reports the error.
- **The kind** declares `computerUse: { driver: "cua", version, socket }`, or
  none for headless kinds, so the tools appear only for desktop boxes.

### Agent tools

| Tool | Input | Returns |
| --- | --- | --- |
| `computer_windows` | none | text: windows with ID, app, title, size, focus |
| `computer_observe` | window ID; optional `query`, `limit`, `screenshot` | text: header (window, size, element count, "partial" if cut) and tree lines with references such as `e26`; with `screenshot`, also the window image |
| `computer_screenshot` | window ID, or the whole desktop | image, plus one line of text: its size and "x and y are pixels of this image" |
| `computer_act` | `ref` or `x`,`y`; `action`: click, double click, right click, scroll, set value, press (an element action); `value` or `amount` where needed | text: what was done, then what changed in the tree, with new references |
| `computer_type` | text or a key chord; optional `ref` to focus first | text: what was done, and the element's value read back where the tree has it |
| `computer_launch` | app name or URL | text: the new or reused window ID |

- **Tree text**: markdown lines from Cua, without frames, with Cua's
  indexes replaced by the plugin's references. Default budget: 300 elements;
  over it the header says so and suggests `query`.
- **Images**: PNG as Cua returns it. The plugin reads the size from the PNG
  header and asks Cua for a smaller image if the long edge is over 1568
  pixels. Desktop screenshots use `max_image_dimension`.
- **Report what changed**: after each action, the plugin reads the window's
  tree again (about 0.2 to 0.3 s in Chrome) and returns the lines that
  appeared, disappeared or changed value. This is Devin's loop: query, act on
  references, read again and report the change; screenshots when appearance
  matters.

### References

The agent sees short references such as `e26`, never Cua tokens. The plugin
keeps, per window, the latest snapshot and for each reference a fingerprint:
role, name, and the roles and names of its ancestors.

- An action on a reference from the latest snapshot uses its token directly.
- A reference from an earlier snapshot is re-found by fingerprint in the
  latest one. One match: use it. None or several: refuse with "e26 (button
  'Delete Task 3') is no longer on screen. Call computer_observe again."
- This makes references survive between calls without the foreground
  misclick measured above. It needs its own experiment (see Experiments).

### Coordinates

- The agent only ever sees pixels of an image the plugin returned. The
  plugin records each image's window, scope and size, and passes `x` and `y`
  to Cua unchanged with the same scope. Cua already maps them to the screen.
- A pixel action is accepted only for the latest image of that window. Cua
  enforces this too.
- Tree lines carry no frames, so screen coordinates never reach the agent.
- Resizing the desktop is allowed only while you hold control (see
  [desktop streaming](desktop-streaming.md)), and every image is dropped when
  control returns, so a resize cannot leave stale coordinates.

### Delivery mode

- The plugin asks for background delivery first. If Cua refuses with its
  "Background delivery is not available" message (it answers in 2 to 4 ms),
  the plugin retries in foreground, unless you are watching and have turned
  foreground off for the box.
- Background element actions do not move the pointer and act on the element
  itself, so they are the safer choice. On a Linux desktop served by
  Xtigervnc or Xvfb, Chrome needs foreground for typing, keys, scrolling and
  clicking text fields.
- On the GPU desktop, which runs real Xorg with the NVIDIA driver, Cua's
  MPX background input may work if the box has `/dev/uinput`. That is an
  experiment, not an assumption.

### Shared control

The plugin already knows who holds control: it is the relay that drops your
input when you do not hold it. The same state gates the computer tools.

1. **Before every computer tool call**, the plugin checks the box. If you
   hold control, it returns at once, as an error, without reaching the box:

   > Paused: a person has taken control of this box's desktop in BB. The
   > computer tools will work again when they hand control back. Nothing was
   > done and the desktop is as they left it. Wait, or ask them in the thread.

2. **When you take control**, the plugin waits up to 3 s for a call in
   flight to finish, then closes the box's MCP session so no queued call can
   land. The panel shows control as yours only after that.
3. **When you hand back**, the plugin drops every reference and image for
   the box. The first call after that carries a note: "Control returned; the
   desktop may have changed. Observe before acting."

This is cooperative, not a security boundary, like the rest of bb-box. The
agent can still reach the box through SSH and run input tools there. A
stronger pause would stop the Cua daemon while you hold control, at the cost
of its references and a restart.

## Windows

From Cua Driver's `WINDOWS.md` and accessibility-cli's source.

- **Session.** Cua's daemon must run in the interactive desktop session
  (Session 1 or later). In Session 0, where services run, UI Automation,
  `PrintWindow` and app activation return nothing, and Cua refuses to act.
  An SSH login usually lands in Session 0, so the daemon must not be started
  from SSH. SSH runs only `cua-driver mcp --socket \\.\pipe\cua-driver`.
- **Starting the daemon.** Cua's autostart registers a per-user Scheduled
  Task (`cua-driver-serve`) with `LogonType=Interactive` that starts the
  daemon at logon; `schtasks /Run /TN cua-driver-serve` restarts it. A
  per-user task needs no elevation.
- **Logon.** The template turns on automatic logon for the box's user, and
  turns off the screen lock and screen saver, so a desktop session exists
  after every boot. The logon password should be generated per box and
  stored as an LSA secret, not as plain text in the registry.
- **Permissions.** Windows has nothing like TCC: UI Automation,
  `PostMessage` and app activation work from a standard user. Apps running
  elevated need an elevated daemon started interactively. Install the pinned
  binary during the image build rather than through a browser, so
  SmartScreen has no downloaded-file mark to act on; check this in the
  experiment.
- **Focus.** Without UIAccess, Windows may refuse to move focus for
  foreground input; Cua then reports "Foreground swap was rejected by
  Windows" rather than typing into the wrong window. Its UIAccess worker is
  off by default.
- **accessibility-cli** reads UI Automation but clicks by pixel with
  `SendInput` using absolute moves, which moves the shared cursor, despite
  the README's example.

## macOS

From Cua Driver's `MACOS.md`, `EMBEDDING.md` and `scripts/README.md`,
accessibility-cli's source, and Devin's article on its Mac environments.

- **Identity.** macOS grants Accessibility and Screen Recording to the
  process responsible for a launch, not to an executable path. Cua ships a
  signed app, `CuaDriver.app` (`com.trycua.driver`), and starts its daemon
  through LaunchServices, `open -n -g -a CuaDriver --args serve`, so the
  grants belong to Cua's app, whoever calls it. The SSH side runs only the
  `mcp --socket` proxy, which needs no grants.
- **Grants.** Accessibility (TCC service `kTCCServiceAccessibility`) is
  required. Screen Recording (`kTCCServiceScreenCapture`) is needed for
  screenshots and pixel actions; without it Cua still works from the tree.
  macOS 26 (Tahoe) adds a separate consent to bypass the private window
  picker, which Cua's `permissions grant` raises.
- **Granting in the image.** As Devin does, mount the guest disk on the host
  while building the image and write the rows into the system TCC database
  (`/Library/Application Support/com.apple.TCC/TCC.db`) for
  `com.trycua.driver`, with its code-signing requirement from
  `codesign -d -r- /Applications/CuaDriver.app`. System Integrity Protection
  guards that file only on the running system. Also create the user and turn
  on automatic login there. Grants follow the signing identity, so they
  survive Cua updates signed with the same certificate; ad hoc builds break
  them.
- **Starting the daemon.** A LaunchAgent for the box's user runs the `open`
  command above at login. Cua's `cua-driver permissions status --json`
  confirms both grants without raising prompts; the template's readiness
  check should run it.
- **Physical Macs** cannot be prepared offline in the same way. On a
  supervised Mac an MDM privacy profile can allow Accessibility for
  `com.trycua.driver`, but for Screen Recording a profile can only deny it or
  let a standard user approve it. Plan for one approval by a person when a Mac joins the pool, or
  Recovery-mode preparation.
- **accessibility-cli on macOS** uses per-process SkyLight events
  (`SLEventPostToPid`) for background input and `CGWindowListCreateImage`
  for window capture, deprecated in macOS 14 and removed from the macOS 15
  SDK in favour of ScreenCaptureKit. Its README asks for grants
  on "the invoking terminal"; over SSH that is the SSH server, so every SSH
  command would gain Accessibility. It would need its own signed app to be
  safe in a box.

## Experiments

On the local rig first, then on each backend as it arrives:

1. **Daemon and proxy on Linux.** Run `cua-driver serve` as a user service
   in the rig, drive it through `ssh -T box cua-driver mcp --socket <path>`
   from the host, and repeat the Chrome and GTK sequences. Record per-call
   time, whether tokens survive closing and reopening the proxy, and whether
   several proxies share references.
2. **Reference fingerprints.** Replay the stale-token test (delete Task 1,
   then act on the old "Delete Task 3") through the plugin's mapping, in both
   delivery modes; then reorder, filter and re-render the list and count
   wrong actions. Target: none.
3. **Pause.** With the relay's control state, take control during a long
   scroll, check that the scroll ends or is cut and that later calls refuse
   with the message; hand back and check the first call's note.
4. **GPU desktop.** On the Proxmox GPU desktop with real Xorg, pass
   `/dev/uinput` and check Cua's background input in Chrome.
5. **Tart macOS image.** Write the two TCC rows and automatic login offline,
   boot, and run `cua-driver permissions status --json`, a tree read of
   Safari and a screenshot, with no prompt on screen. Repeat after moving the
   Cua pin.
6. **Windows VM.** Automatic logon, the Scheduled Task, the named-pipe
   proxy over OpenSSH, and the same sequences in Edge and Notepad.
7. **Conformance suite.** Turn the rig's Chrome and GTK sequences into the
   computer-use part of bb-box's conformance suite, run on every backend and
   on every change of the Cua pin.

## Open questions

- **Token lifetime through the proxy.** Tokens live in the daemon, and pixel
  clicks check that a screenshot belongs to "this session". Whether a new
  proxy connection is a new session is not documented; experiment 1 answers
  it.
- **Tahoe's window-picker consent.** Where macOS 26 stores it, and whether it
  can be written offline like the TCC rows, is unknown.
- **iOS Simulator.** Cua does not document it; accessibility-cli has a
  dedicated platform, and Devin uses it for this. The iOS Simulator kind may
  need accessibility-cli behind the same bb-box tools. Evaluate on the macOS
  backend.
- **Browser tools.** Whether web-heavy work also needs Playwright MCP or
  Chrome DevTools MCP, which need Chrome started with a debugging port.
- **Reporting the Chrome crash.** The accessibility-cli bug and patch are
  ready to report to DioxusLabs; not filed without permission.
- **Telemetry during the rig runs.** The rig ran Cua with its telemetry at
  the default (on). It sends fixed event names and counts, not content; the
  template turns it off.

## Sources

- Cua Driver: https://github.com/trycua/cua (commit 9545a3d), releases
  `cua-driver-rs-v0.28.3` and `cua-driver-rs-v0.30.4`; in
  `libs/cua-driver/`: `rust/Skills/cua-driver/LINUX.md`, `WINDOWS.md`,
  `MACOS.md`, `RUNTIME.md` and `EMBEDDING.md`; `docs/action-support.md`,
  `docs/linux-mpx-recovery.md`, `docs/linux-desktop-validation.md`,
  `scripts/README.md`; `rust/crates/cua-driver/src/telemetry.rs`,
  `version_check.rs` and `mcp_envelope.rs`; `rust/crates/cua-driver-uia`
- accessibility-cli: https://github.com/DioxusLabs/accessibility-cli (commit
  f64c036), `README.md`, `packages/accessibility-core/src/platform/x11.rs`,
  `macos.rs` and `msft.rs`, `accessibility/cache.rs`,
  `packages/accessibility-macos-sys/src/macos/symbols.rs` and `window.rs`,
  `packages/accessibility-windows-sys/src/msft/reader/adapter.rs`
- Claude vision limits: https://platform.claude.com/docs/en/build-with-claude/vision
- Apple privacy profile (PPPC) settings:
  https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web
- Devin's Mac article, https://devin.ai/ (image preparation, the
  accessibility loop, accessibility-cli)
- BB plugin SDK 0.5.29 (`bb.agents.registerTool` results with text and image
  content)
- [Desktop streaming](desktop-streaming.md) (control filter, resolution lock)
  and [the GPU in a desktop box](gpu-desktop.md) (real Xorg)
- The rig: [computer-use-rig](computer-use-rig/)
