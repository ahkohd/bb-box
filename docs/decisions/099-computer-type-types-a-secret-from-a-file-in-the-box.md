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
BB Box types a secret only into the element that has the focus and reports
itself as a password field at that moment. It never types one into a field
it cannot confirm and then tries to detect or undo it: by then the
password would have been on the screen, in any screenshot and in
recordings.

- Exactly one of `text`, `keys` or `text_file`. The one exception is a
  device box, where `text` may come with `keys`, such as Return, pressed
  once the field holds the text; `text_file` always goes alone.
- `text_file` needs `ref`. A window, or the desktop, without `ref` is
  refused before the file is read.
- A field whose own role says it is not a password field, such as a text,
  search or combo field or a document, is refused before it is focused.
- Otherwise BB Box focuses the field with a click on its reference in the
  foreground, as a person would: on macOS Cua's background press leaves the
  keyboard focus where it was. It then asks the platform for the element
  that has the focus and whether it is a password field. A check of the element under the field's point is
  not enough: another element can lie there with the same name (an
  overlay), and a page can turn the field into plain text as it gets the
  focus.
  - Linux: AT-SPI, from the desktop session: the app's accessible with the
    focused state, found by walking its tree over D-Bus, has the role
    `password text`.
  - macOS: Accessibility, by a JavaScript for Automation script run over
    SSH: the app's `AXFocusedUIElement` has the subrole
    `AXSecureTextField`. The script needs Accessibility access; without it
    BB Box cannot tell, and refuses. Cua gives Chrome's password, email and
    search inputs all the role `AXTextField`, with no subrole in its output.
  - Windows: UI Automation's `FocusedElement`, read in the desktop session,
    says `IsPassword`. Cua gives every input `Edit`.
  - iOS and Android: the focused element's role is `secure text field`,
    which Android gives a node with its password flag.
- The focused element must be the field: the same role and name, and on
  Linux and Windows the same frame within 4 pixels. On Windows its
  AutomationId must match the id Cua shows, where both give one: a password
  input laid over a plain one of the same name and place differs only
  there. On macOS, where a script cannot read the frame, the element under
  the field's centre must be the focused element itself. A device's frame is not
  compared, as the keyboard can scroll the field, but the focused element
  must still be a password field of the same role and name. A focused
  element that is not a password field is refused as one; any other
  mismatch, or nothing focused, is refused as the focus being elsewhere.
- BB Box then sends the characters to whatever has the focus: Cua's typing
  into the window, without an element, on a desktop, and the device's text
  input on a device. It does not target the element again, so the keys go
  where the check looked.
- Whenever BB Box reads a window or a device's screen, the value of an
  element whose platform marks it secure reads as `(hidden)`, with no
  length: AT-SPI's `password text`, the `secure text field` of iOS and
  Android, and a desktop field BB Box has confirmed this way. Android gives
  a password field's text to accessibility in full, so without this a
  later `computer_observe` would show it. The hiding happens where the
  tree is read, before observations, change summaries, read-backs, labels
  and hints.
- BB Box reads the file as the box user through the box's command channel,
  base64 on the way out, by input redirection, so a name that starts with
  a dash is a file. It checks the size first and refuses, saying nothing of
  the contents: a missing file, one that is not a regular file, one the box
  user cannot read, an empty file and one over 4 KiB. It drops one line
  break at the end, LF or CRLF, as `op read > file` adds one.
- The secret goes from BB Box's memory only to the driver's typing. On a
  Wayland desktop, where BB Box types through the image's US keyboard or by
  paste (#707), the text goes to those scripts on their standard input, for
  all typing, not inside the script's own text.
- Fixed words only. The result is "Typed N characters from <path> into
  <ref>.", and whether the file was deleted. It holds nothing read from the
  screen and no driver error text. If typing fails, the error says "Typing
  into <ref> failed, and the field may hold part of the password".
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
- The file's contents are not in the tool's input, its result or BB's
  records, and BB Box's later readings of the screen show a password
  field's value as `(hidden)`.
- The boundary is the app. The app receives the password and can reveal or
  misuse it: a page could switch the field to plain text after the check,
  and then the screen, screenshots and recordings show it. The dots show
  the password's length on the screen, in screenshots and in recordings.
  The box holds the password while the file is there.
- On macOS without Accessibility access for scripts run over SSH, and in
  apps that do not mark their password fields, BB Box types no secret.
- A password with a character a US keyboard lacks is pasted on a Wayland
  desktop and on a device, as other text is: it is on the box's clipboard
  for about half a second, and BB Box then puts the clipboard back.
