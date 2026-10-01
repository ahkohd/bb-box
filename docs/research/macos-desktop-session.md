# The macOS desktop session

How bb-box runs a command in a Mac box user's logged-in desktop session, so
that the run tool's `session: "desktop"` works on macOS (issue #57).

Status: recommendation made and measured, accepted as
[030](../decisions/030-a-mac-runs-desktop-commands-through-launchctl-asuser.md),
and built.
Checked on 1 October 2026, on macOS 27.0 in a Tart box from a Cirrus Labs
image.

## Recommendation

1. **Wrap the command in `launchctl asuser`.** On macOS, core runs a
   desktop command through the box's SSH as:

   ```sh
   sudo -n /bin/launchctl asuser "$uid" /usr/bin/sudo -n -u "$user" -- "$SHELL" -c '<script>'
   ```

   The command joins the box user's desktop session, and still runs under
   the SSH session, so output, stdin and the exit status work as for any
   other command. It also reaches the login keychain, which plain SSH
   cannot. It costs about 21 ms per run.
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
- **E7.** `ps -E` does not escape a literal backslash, so a value holding
  a backslash and three digits reads like an escape (see Variables below).
- **E8.** A wrapped command's `launchctl managername` prints `Aqua`. Its
  PATH comes from ~/.zshenv, and HOME is the box user's. Its parent is the
  inner sudo, which the shell replaces.
- **E9.** The exit status (7), stdin (`hello`) and streaming (two lines
  2 s apart) all pass through the wrapper, and stderr stays apart from
  stdout. The conformance suite checks the session, stdin, stderr and the
  exit status.
- **E10.** `time` gives 0.021 s for a wrapped `/usr/bin/true`.
- **E11.** `security show-keychain-info` fails from plain SSH and works
  wrapped, so only a wrapped command can use the login keychain. The
  pasteboard works both ways.
- **E12.** From plain SSH, TextEdit's binary got a window that took
  typing through Accessibility. Real key events were not checked. `open -a
  TextEdit` from plain SSH brought it up frontmost, as a child of launchd.
- **The pre-check.** `stat -f %Su /dev/console` prints the box user.
- **E13.** `sudo -n -l` with the wrapper's command exits 0 when the rule
  that allows it needs a password, as long as another rule has `NOPASSWD`;
  the wrapper itself then fails with sudo's "a password is required". A
  no-op run through the wrapper, `/usr/bin/true`, fails there and passes
  where the wrapper works.
- **E14.** With a box user's sudo limited to the standard user's rule
  below, the wrapper runs a script of several lines with quotes in it, and
  sudo refuses other commands as root and the wrapper for another user.
- **E15.** bb-box's desktop command takes about 93 ms for
  `/usr/bin/true`, against 20 ms for a plain one: the checks about 12 ms,
  the wrapper about 20 ms, and the inner shell's `~/.zshenv` hook loads the
  variables again.
- **Prompts.** No screen-capture consent prompt appeared on a fresh boot.
  It appeared once, after the box was suspended and resumed, and Tart's
  setup is to pre-approve it. macOS shows an "App Background Activity"
  notification on every boot.

So the wrapper passes E8 and E9, and it is enough for #57. E11 is a further
reason to prefer it over plain SSH: git's keychain helper and Xcode's
signing work only in a wrapped command. E12 shows that macOS 27 is kinder
to plain SSH than Apple's forum reports for 26, but the session is still
`Background` and the login keychain still out of reach.

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
    there is no desktop session to join (status 69);
  - sudo runs a no-op through the wrapper without a password (E13).
    Otherwise the message gives the sudoers rule to add (status 77).
- `canRunInDesktop("macos")` becomes true. Core never branches on the
  backend: on a Mac where sudo refuses, the run fails with that message.
- A run's time limit works as for other macOS commands today: core stops
  the local `ssh`, and the command may keep running in the box.
- The conformance suite runs a `session: "desktop"` command on macOS
  desktop kinds, and checks that `launchctl managername` prints `Aqua` and
  that stderr stays apart from stdout.

## Variables

E7 bears on how bb-box reads BB's variables from a worker's
environment on macOS (`src/core/in-box.ts`). `ps -E` prints a newline
in it as `\012`, but a literal backslash as it is, so `\NNN` in a
value is ambiguous. It is rare, and GH_TOKEN never has one. A space
followed by `WORD=` in a value is ambiguous too. Both go when BB gives
the variables directly ([BB requests](../bb-requests.md), request 8).

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

Run as the box user over bb-box's SSH on macOS 27.0. Results are above.

| | Checks | Result |
| --- | --- | --- |
| E5 | `osascript` to System Events, wrapped | a count, exit 0 |
| E6 | TextEdit's binary, wrapped, then typing | window listed and typed into |
| E7 | how `ps -E` prints a literal backslash | not escaped |
| E8 | the session, PATH, HOME and parents of a wrapped command | `Aqua`; PATH from ~/.zshenv |
| E9 | exit status, stdin, stderr and streaming through the wrapper | 7; `hello`; stderr apart; lines 2 s apart |
| E10 | the wrapper's cost per run | 21 ms |
| E11 | the login keychain and the pasteboard, plain and wrapped | keychain wrapped only; pasteboard both |
| E12 | a GUI binary from plain SSH, then `open -a` | binary typed into via Accessibility; `open` frontmost |
| E13 | `sudo -n -l` and a no-op through the wrapper, when its rule needs a password | `-l` exits 0; the no-op fails |
| E14 | the wrapper with only the standard user's rule | runs; other root commands refused |
| E15 | bb-box's desktop command against a plain one, for `/usr/bin/true` | 93 ms; 20 ms |

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
