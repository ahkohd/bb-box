# 015: Computer use drives a pinned Cua Driver through bb-box's own tools

Status: accepted, 30 September 2026. Partly supersedes
[008](008-shared-control.md) and [011](011-interface-v1.md). Partly
superseded by [022](022-references-follow-renames-not-rows.md): how an old
reference is found again.

## Context

The agent needs to read a desktop's accessibility tree, act on elements,
type, click by pixel, scroll, launch apps and take screenshots, with the same
tools on Linux, Windows and macOS. The [computer use
research](../research/computer-use.md) compared the options on a Linux
desktop:

| | Cua Driver 0.30.4 | accessibility-cli |
| --- | --- | --- |
| Linux, Windows, macOS | all three, one set of tools | all three, but on Linux no keys, pixel clicks, typing into Chrome or screenshots |
| Tree of a Chrome page (365 elements) | 210 to 310 ms | 0.7 to 1.3 s, and its first read crashed Chrome |
| References | tokens kept by a daemon | walk-order IDs that change between calls |
| Releases | a pre-release almost every day | none |

It also found:

- a stale Cua token in foreground mode clicked the element's old position and
  deleted the wrong task;
- tree frames are in screen coordinates and screenshot pixels are not, so
  mixing them missed by tens of pixels;
- a Chrome article's tree is 165 KB of text, about 40,000 tokens;
- a new SSH connection costs 165 ms per call, and one long-lived session 2 to
  4 ms.

v1 made `computerUse` a yes or no, and 008 paused the agent by stopping a
computer-use service in the box.

## Decision

- **Driver.** Cua Driver, one release pinned in each template with its
  SHA-256, with telemetry (`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`) and the
  update check (`CUA_DRIVER_RS_UPDATE_CHECK=false`) off. The pin moves only
  after the conformance suite passes. Not accessibility-cli, for now.
- **In the box.** `cua-driver serve` runs in the logged-in desktop session:

  | OS | Started by |
  | --- | --- |
  | Linux | a user service that knows the display, the session bus and the AT-SPI bus |
  | Windows | a per-user Scheduled Task with `LogonType=Interactive`, and automatic logon |
  | macOS | a LaunchAgent that runs `open -n -g -a CuaDriver --args serve`, so the grants belong to Cua's signed app |

- **Kind.** `computerUse` becomes `{driver, version, socket}`, or null for
  kinds without it. Offers of a kind agree on the driver. Each template pins
  its own version.
- **Transport.** The plugin keeps one session per box running `cua-driver
  mcp --socket <socket>` and speaks MCP over its stdin and stdout. It opens
  the session on first use, and closes it after 10 idle minutes, when you
  take control and when the box is released. A failed session is reopened
  once. For this, `CommandTransport` gains `spawn(script)`, which returns a
  byte channel to a long-running command.
- **Agent tools.** The agent gets bb-box's six tools, never Cua's:
  `computer_windows`, `computer_observe`, `computer_screenshot`,
  `computer_act`, `computer_type` and `computer_launch`.
  - Tree text has no frames, and uses the plugin's short references such as
    `e26`. The default budget is 300 elements.
  - Images are kept at or under 1568 pixels on the long edge.
  - Each action returns what changed in the tree.
- **References.** The plugin owns them. Each has a fingerprint: role, name,
  and its ancestors' roles and names. A reference from an earlier snapshot is
  found again in the latest one, or refused if it matches none or several.
- **Coordinates.** The agent sees only pixels of images the plugin returned.
  A pixel action is accepted only against the latest image of that window.
- **Delivery.** Background first. When Cua refuses, which takes 2 to 4 ms,
  the plugin retries in foreground.
- **Shared control.** The relay's control state gates the tools. This
  replaces 008's steps for taking control:
  1. While you hold control, every computer tool refuses at once without
     reaching the box.
  2. Taking control waits up to 3 s for a call in flight, then closes the
     box's MCP session. The daemon keeps running.
  3. Handing back drops every reference and image, and the first call after
     it tells the agent to observe again.

## Consequences

- Nothing in the box pauses the agent, on any OS. 008's cgroup freeze is
  dropped. The pause is cooperative, like the rest of bb-box: the agent can
  still reach the box over SSH.
- The core names Cua, as it names noVNC: in-box software, not a provider. A
  second driver, for example for the iOS Simulator, would be a new `driver`
  value behind the same six tools.
- A kind with computer use needs a command transport with `spawn`. `doctor`
  checks it. The QEMU guest agent cannot offer it, so Windows computer use
  needs OpenSSH.
- Templates grant permissions without a person:
  - Tart images get Cua's TCC rows written offline, and automatic login;
  - a physical Mac needs one Screen Recording approval by a person when it
    joins the pool;
  - Windows needs automatic logon, and the daemon runs without elevation.
- The rig's Chrome and GTK sequences become the computer-use part of the
  conformance suite, run on every backend and on every change of the pin.
- Still open: whether Cua tokens survive a new proxy session, where macOS 26
  keeps its window-picker consent, how to drive the iOS Simulator, and Cua's
  background input on the GPU desktop's real Xorg.
