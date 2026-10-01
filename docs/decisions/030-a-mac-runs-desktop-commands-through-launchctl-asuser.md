# 030: A Mac runs desktop commands through `launchctl asuser`

Status: accepted, 1 October 2026. Extended by
[039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md):
Windows runs desktop commands through a one-off scheduled task.

## Context

The run tool's `session: "desktop"` starts a command in the box user's
logged-in desktop session ([011](011-interface-v1.md)). Core does this on
Linux only. On macOS it refuses, and the architecture planned a LaunchAgent
for it (issue #57).

SSH on macOS runs in the `Background` session, apart from the user's `Aqua`
session, and each session has its own way to the window server, the
pasteboard and the login keychain. Apple advises a LaunchAgent for work in
the desktop session, and calls `launchctl asuser`, which moves a command
into a user's session, legacy. A LaunchAgent must be installed in every
image and home skeleton, stays resident, and would have to carry stdin,
output, the exit status and stopping across FIFOs itself.

Measured on macOS 27.0 in a Tart box, over bb-box's SSH
([the macOS desktop session](../research/macos-desktop-session.md)):

- A command wrapped in `launchctl asuser` runs in `Aqua`, with the PATH
  from ~/.zshenv. Its exit status, stdin and output pass through as for
  any SSH command, and output streams.
- The wrapper costs about 21 ms per run.
- The login keychain works only in a wrapped command. The pasteboard works
  with or without it.
- From plain SSH on 27.0, `open -a` starts an app frontmost, and an app's
  binary gets a window that takes typing through Accessibility.
- Privacy grants (TCC) follow the process macOS holds responsible, not the
  session, so the wrapper neither gains nor loses them.

## Decision

- On macOS, core runs a desktop command through the box's own transport
  as:

  ```sh
  sudo -n /bin/launchctl asuser "$uid" /usr/bin/sudo -n -u "$user" -- "$SHELL" -c '<script>'
  ```

  The outer sudo gives `asuser` the root it needs, and the inner one runs
  the command as the box user again. The full paths make the command match
  the sudoers rule below exactly.
- Every Mac gets it:
  - a box whose user is an administrator, such as Tart's, needs nothing
    more;
  - on a Mac whose box user is a standard user, such as an SSH host pool's
    Mac or a physical Mac, Mac setup writes
    `/etc/sudoers.d/bb-box-desktop`, mode 0440, checked with `visudo -cf`:

    ```
    <user> ALL=(root) NOPASSWD: /bin/launchctl asuser <uid> /usr/bin/sudo -n -u <user> -- *
    ```

    It allows the wrapper and nothing else, and gives no root shell. A home
    reset leaves `/etc` alone, so the rule survives it.
- The inner sudo resets the environment. So `command()` puts the env
  file's sourcing, the `cd` and the script inside the wrapper. Writing the
  env file stays outside it.
- Before it runs, the command checks two things, and each failure has its
  own exit status and message:
  - the box user owns the console (`stat -f %Su /dev/console`), or there is
    no desktop session to join;
  - sudo runs a no-op, `/usr/bin/true`, through the wrapper without a
    password, or the message gives the sudoers rule to add. `sudo -n -l`
    is not enough: it allows a command whose rule needs a password (E13
    in the research note).
- `canRunInDesktop("macos")` is true. The interface does not change, and
  core never branches on the backend: on a Mac where sudo refuses, the run
  fails with the message above.
- The conformance suite runs a `session: "desktop"` command on macOS
  desktop kinds, and checks that `launchctl managername` prints `Aqua` and
  that stderr stays apart from stdout.
- If a later macOS breaks `asuser`, that check fails, and a LaunchAgent
  that runs requests from a FIFO replaces the wrapper, as the research note
  describes.

## Consequences

- An agent can start an app, or run a test that needs the window server,
  in a Mac box's desktop, with output and the exit status as for any
  command.
- Only a desktop command reaches the login keychain, so git's keychain
  helper and Xcode's signing work there and not in a plain run.
- Nothing is installed in Mac images, and no process stays resident.
- A run's time limit works as for other macOS commands: core stops the
  local `ssh`, and the command may keep running in the box.
- The SSH host pool's Mac setup, when it is written, and the physical Mac's
  setup add the sudoers rule.
- Windows still needs a scheduled task with `/IT` for its desktop session
  (issue #46).
- Core makes the change in `src/core/in-box.ts` after reading BB's
  variables on macOS.
