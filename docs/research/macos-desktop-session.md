# The macOS desktop session

How bb-box runs a command in a Mac box user's logged-in desktop session, so
that the run tool's `session: "desktop"` works on macOS (issue #57).

Status: recommendation made; experiments E7 to E12 pending. Checked on
1 October 2026, on macOS 27.0 in a Tart box from a Cirrus Labs image.

## Recommendation

1. **Wrap the command in `launchctl asuser`.** On macOS, core runs a
   desktop command through the box's SSH as:

   ```sh
   sudo -n /bin/launchctl asuser "$uid" /usr/bin/sudo -n -u "$user" -- "$SHELL" -c '<script>'
   ```

   The command joins the box user's desktop session, and still runs under
   the SSH session, so output, stdin and the exit status work as for any
   other command.
2. **Every Mac gets it.**
   - Boxes whose user is an administrator, such as Tart's, have it already
     through their passwordless sudo.
   - On Macs whose box user is a standard user (SSH pool Macs and physical
     Macs), Mac setup adds one sudoers rule that allows this wrapper and
     nothing else.
3. **Core's change is small**, in `src/core/in-box.ts`, with no interface
   change and no backend named (see The wrapper).
4. **Fallback: a LaunchAgent.** Apple calls `asuser` legacy. If a later
   macOS breaks it, the conformance suite fails, and the LaunchAgent design
   below replaces the wrapper.
5. **Not chosen:** `open` alone, a script started as an app, `tart exec`,
   and loading a job into the session from SSH (see Other ways).

## Why SSH is not enough

- macOS runs SSH sessions in the `Background` session, apart from the
  logged-in user's `Aqua` session. Each session has its own bootstrap
  namespace, which is how a process finds the window server, the
  pasteboard and other per-login services. Over SSH,
  `launchctl managername` prints `Background` (E6).
- On macOS 26, an app's binary started from SSH shows a window, but the
  window takes no keyboard input, and the app gets no Dock icon or menu
  bar. `open` from SSH starts an app properly, because Launch Services
  starts it in the desktop session (Apple's forum, thread 803553).
- Apple's advice is to start code in the right context rather than switch
  contexts: a LaunchAgent for work in the desktop session. It calls
  `launchctl asuser` legacy (thread 765060).
- Privacy grants (TCC) follow the process macOS holds responsible, not the
  session. For an SSH command that is `sshd-keygen-wrapper`. Cirrus Labs'
  images grant it Accessibility, Screen Recording and Apple Events, so
  `osascript` to System Events works from SSH with or without the wrapper
  (E5). The wrapper is not expected to change the responsible process.
- Computer use does not depend on this. Cua Driver runs as a LaunchAgent
  in the desktop session, with its own grants
  ([015](../decisions/015-computer-use-through-cua-driver.md)).

## Measured

On macOS 27.0, as the box user over bb-box's SSH:

- **E5.** The wrapper ran `osascript -e 'tell application "System Events"
  to count processes'` and printed a count, with exit status 0.
- **E6.** The wrapper started TextEdit's binary. Its window appeared on
  the desktop, `computer_windows` listed it, and the agent typed into it.

## The wrapper

- The outer sudo is needed because `asuser` needs root. `asuser` moves the
  command into the user's desktop session. The inner sudo runs it as the
  box user again. `$SHELL -c` is the user's shell, as for any SSH command,
  so ~/.zshenv gives it the PATH. The full paths make the command match
  the sudoers rule exactly.
- The inner sudo resets the environment. So on macOS, `command()` puts
  the env file's sourcing, the `cd` and the script inside the wrapper.
  Writing the env file can stay outside it.
- Before it runs, the wrapper checks two things, each failing with a
  status and message of its own:
  - the box user owns the console (`stat -f %Su /dev/console`). Otherwise
    there is no desktop session to join;
  - sudo allows the wrapper (`sudo -n -l` with the same command).
    Otherwise the message points to the sudoers rule in the Mac setup
    guide.
- `canRunInDesktop("macos")` becomes true. Core never branches on the
  backend: on a Mac where sudo refuses, the run fails with that message.
- A run's time limit works as for other macOS commands today: core stops
  the local `ssh`, and the command may keep running in the box.
- The conformance suite runs a `session: "desktop"` command on macOS
  desktop kinds, and checks that `launchctl managername` prints `Aqua`.

## Standard box users

Mac setup writes one file, `/etc/sudoers.d/bb-box-desktop` (mode 0440,
checked with `visudo -cf`):

```
<user> ALL=(root) NOPASSWD: /bin/launchctl asuser <uid> /usr/bin/sudo -n -u <user> -- *
```

- It allows only the wrapper. The inner sudo runs as root, but its
  arguments are fixed up to `--`, so it can only run a command as the box
  user. The rule gives no root shell.
- A home reset leaves `/etc` alone, so the rule survives it. The box user
  still cannot write `/Library`, so a home reset still restores the Mac
  ([later backends](later-backends.md), Physical Mac).
- The SSH host pool's macOS setup does not exist yet. The rule goes in
  with it.

## Fallback: a LaunchAgent

Only if `asuser` stops working:

- A LaunchAgent in `~/Library/LaunchAgents`, from the image or the home
  skeleton, runs a small sh loop in the desktop session. It loads at
  login: loading it from SSH fails for a standard user on macOS 27
  (flair issue 2040).
- The loop reads request directories from a FIFO. For each request, core
  writes the script, and FIFOs for stdin, stdout, stderr and the exit
  status. Each request runs in its own process group, so the SSH side can
  stop it.
- The cost: it must be installed in every image and skeleton, a process
  stays resident, and core must carry stdin, output, the exit status and
  stopping across the FIFOs itself.

## Other ways, not chosen

- **`open`.** It starts apps in the desktop session from SSH, and takes
  `--env`, `--stdin`, `--stdout`, `--stderr` and `-W`. It starts apps
  only, and `computer_launch` already opens apps.
- **A script as an app's executable, started with `open`.** Launch
  Services handles it badly on Apple silicon: it may offer Rosetta, or
  fail to launch. Apple advises against it. A compiled launcher would be a
  binary for bb-box to build and ship.
- **`tart exec`.** tart-guest-agent runs in the desktop session, but only
  Tart has it, and it is reached from the Mac host, not the box.
- **`launchctl bootstrap gui/<uid>` from SSH.** It fails for a standard
  user on macOS 27 (flair issue 2040).

## Experiments

E7 to E12 go to the next Tart live check, run as the box user over
bb-box's SSH:

| | Checks | Expected |
| --- | --- | --- |
| E7 | how `ps -E` prints a literal backslash (for the variables) | to decide whether `\NNN` decodes exactly |
| E8 | the session, PATH, HOME and parent processes a wrapped command sees | `Aqua`; the PATH from ~/.zshenv |
| E9 | exit status, stdin and streaming through the wrapper | 7; `hello`; two lines 2 s apart |
| E10 | the wrapper's cost per run | to measure |
| E11 | the login keychain and the pasteboard, with and without the wrapper | to find out |
| E12 | a GUI binary from plain SSH, then `open -a` | no typing for the binary; `open` works |

If E8 and E9 pass, the wrapper is enough for #57.

## Sources

Read on 30 September and 1 October 2026:

- Apple Developer Forums, thread 765060, "Accessing Window Server and other
  GUI services when running tests via SSH vs LaunchAgent":
  https://developer.apple.com/forums/thread/765060
- Apple Developer Forums, thread 803553, "Macos Tahoe issue launching apps
  through SSH": https://developer.apple.com/forums/thread/803553
- tpsdev-ai/flair issue 2040, on loading a LaunchAgent over SSH on macOS
  27: https://github.com/tpsdev-ai/flair/issues/2040
- PowerShell issue 27587 and Ryubing issue 422, on scripts as app
  executables: https://github.com/PowerShell/PowerShell/issues/27587,
  https://github.com/Ryubing/Issues/issues/422
- `open(1)` on current macOS (`--env`, `--stdin`, `--stdout`, `--stderr`).
- bb-box: `setup/tart/guest/customize.sh` (the Cua Driver LaunchAgent) and
  `src/core/in-box.ts`.
