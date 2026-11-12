# 099: computer_type types a secret from a file in the box

Status: accepted, 12 November 2026. Extends
[015](015-computer-use-through-cua-driver.md) and
[073](073-recordings-draw-the-pointer-keys-and-zooms-from-the-event-log.md).

## Context

Agents sign in to sites in desktop boxes with passwords they read from a
password manager, such as 1Password's `op read`. Typing a password as
`computer_type`'s `text` puts it in the agent's tool call, in the thread's
transcript, in the tool's result where the field reads it back, and
possibly in logs. Agents worked round this by typing from a script inside
the box's desktop session, which was complex and had a timing bug.

BB Box already reads the box's files through its own command channel, and
it already sends `computer_type`'s text to the computer-use driver in the
box over its own session. So it can read a file in the box itself and send
its contents to the driver, without the text ever passing through the
agent.

## Decision

`computer_type` takes `text_file`, the path of a file in the box, in place
of `text` or `keys`, with `ref`, and `delete`, to delete the file after.
BB Box types a secret only into a field it has confirmed, before typing, is
a password field. It never types one into a field it cannot confirm and
then tries to detect or undo it: by then the password would have been on
the screen, in any screenshot and in recordings.

- Exactly one of `text`, `keys` or `text_file`. The one exception is a
  device box, where `text` may come with `keys`, such as Return, pressed
  once the field holds the text; `text_file` always goes alone.
- `text_file` needs `ref`. A window, or the desktop, without `ref` is
  refused before the file is read.
- BB Box confirms the field before it reads the file:
  - Linux: AT-SPI's role is `password text`.
  - macOS: Cua gives Chrome's password, email and search inputs all the
    role `AXTextField`, with no subrole in its output. BB Box reads the
    element's `AXSubrole` itself, with a JavaScript for Automation script
    run over SSH at the centre of the element's frame. The element there
    must have the element's role and name, and its subrole must be
    `AXSecureTextField`. The script needs Accessibility access; without it
    BB Box cannot tell, and refuses.
  - Windows: Cua gives every input `Edit`. BB Box reads UI Automation's
    `IsPassword` for the element at the centre of its frame, in the desktop
    session, as from the SSH session UI Automation sees only a pane. The
    element must have the element's control type and name.
  - iOS and Android: the role is `secure text field`.
  - A field that is not confirmed is refused: "e12 is not a password field,
    so BB Box types no secret into it", or, where BB Box cannot tell,
    "BB Box cannot tell a password field from a plain one here, so it types
    no secret into e12". There is no option to type anyway.
- BB Box reads the file as the box user through the box's command channel,
  base64 on the way out, by input redirection, so a name that starts with
  a dash is a file. It checks the size first and refuses, saying nothing of
  the contents: a missing file, one that is not a regular file, one the box
  user cannot read, an empty file and one over 4 KiB. It drops one line
  break at the end, LF or CRLF, as `op read > file` adds one.
- The secret goes from BB Box's memory only to the driver's typing: Cua's
  `type_text` on a desktop, the device server's text input on an iOS or
  Android box. On a Wayland desktop, where BB Box types through the image's
  US keyboard or by paste (#707), the text goes to those scripts on their
  standard input, for all typing, not inside the script's own text.
- Fixed words only. The result is "Typed N characters from <path> into
  <ref>.", and whether the file was deleted. It holds nothing read from the
  screen, no element names or values, and no driver error text. If typing
  fails, the error says "Typing into <ref> failed, and the field may hold
  part of the password", whatever the driver said.
- As defence in depth, the result, and every log line written while the
  secret is in BB Box's memory, has each exact occurrence of the secret
  replaced with `[hidden]`. No claim rests on it.
- `delete` deletes the file once BB Box has read the secret, whether the
  typing then worked or failed. A refusal before the read leaves the file.
- A recording logs the typing as secret, with 0 characters, so the clip
  draws no pill and no zoom for it.

## Consequences

- An agent signs in with `op read "op://vault/item/password" > /tmp/pw` in
  `box_run`, then `computer_type` with `ref`, `text_file` and `delete`.
  The email and an authenticator code still go as plain `text`.
- The password is not in the agent's call, the result, the thread, BB's
  logs or BB Box's database, and it never shows as text on the screen.
- A password field's dots still show its length, on the screen, in
  screenshots and in recordings, which show what the screen shows. The box
  holds the password while the file is there, and the app once it is typed.
- On macOS without Accessibility access for scripts run over SSH, and in
  apps that do not mark their password fields, BB Box types no secret.
- A password with a character a US keyboard lacks is pasted on a Wayland
  desktop and on a device, as other text is: it is on the box's clipboard
  for about half a second, and BB Box then puts the clipboard back.
