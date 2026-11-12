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
of `text` or `keys`, and `delete`, to delete the file after typing.

- BB Box reads the file as the box user, with a short script through the
  box's command channel, base64 on the way out. It refuses, saying nothing
  of what the file holds: a missing file, one that is not a regular file,
  one the box user cannot read, an empty file and one over 4 KiB. It drops
  one line break at the end, LF or CRLF, as `op read > file` adds one.
- The secret goes from BB Box's memory only to the driver's typing: Cua's
  `type_text` on a desktop, the device server's text input on an iOS or
  Android box. On a Wayland desktop, where BB Box types through the image's
  US keyboard or by paste (#707), the text now goes to those scripts on
  their standard input, for all typing, not inside the script's own text.
- With `ref`, BB Box looks at the element's role first. A password field
  (`password text` in AT-SPI, `AXSecureTextField` on macOS, `secure text
  field` on iOS and Android) is typed into. A field that clearly shows its
  text, such as a text field, a search field, a combo box, a terminal or a
  document, is refused before the file is read, naming the window's
  password fields, and the file is left as it was.
- Some platforms do not say. On macOS, Cua gives a password input in Chrome
  the role `AXTextField`, as it gives an email or search input, so a plain
  text field there is typed into with a warning. On Windows, UI Automation
  marks a password box with a property, not a role, so an edit field there
  is typed into with a warning too, as is any role that says neither.
  macOS's search fields, text areas, combo boxes and web areas are still
  refused.
- With `window` instead of `ref`, BB Box cannot see the field, so it types
  and says it could not confirm the field hides what it shows.
- The result says only "Typed N characters from <path> into <target>",
  what changed on the screen, and whether the file was deleted. It never
  reads the field's value back. As defence in depth, every result, hint and
  error of the call, and every log line written while it runs, has each
  occurrence of the secret replaced with `[hidden]`, also in the form JSON
  escapes it.
- `delete` deletes the file once BB Box has read the secret, whether the
  typing then worked or failed. A refusal before the read leaves the file.
- A recording logs the typing as secret, with 0 characters, so the clip
  shows no pill, no zoom and not even the secret's length.

## Consequences

- An agent signs in with `op read "op://vault/item/password" > /tmp/pw` in
  `box_run`, then `computer_type` with `text_file` and `delete`. The email
  and an authenticator code still go as plain `text`.
- The secret stays out of the agent's call, its result, BB's logs and BB
  Box's database. It is still on the box's screen as the app draws it, and
  in the box's own memory and the driver's.
- A password with a character a US keyboard lacks is pasted on a Wayland
  desktop and on a device, as other text is: it is on the box's clipboard
  for about half a second, and BB Box then puts the clipboard back.
- The mask works on the exact text of the secret. A screen that shows only
  part of it, or changes it, is not masked; password fields show none of
  it.
