# 074: A box has a files view

Status: accepted, 8 November 2026.

## Context

A person can open a box's desktop and its terminal from the panel. To read or change a file they use the terminal, or ask an agent to copy the file out. [bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor) (MIT, copyright 2026 AbdElrahman Telb) already does this for a BB workspace: a tree, editor tabs, BB's source view, search, go to file, find in the file, a Markdown preview, images, and a save guarded by the file's hash.

A box's files are not the thread's workspace. They are the box user's own files, reached through the same command transport as the terminal and `box_run`.

## Decision

- Taken from that plugin: the layout (a tree, tabs, the open file), the shortcuts (Ctrl or Command with P, with F, with Shift and F, and with S, and Escape), smart-case search, go to file by name, find in the open file, a Markdown preview, images shown, other binaries named, and the hash guard (Reload or Overwrite). The plugin's own copy of BB's components is not used. The view is built from bb-box's components, in the same style as the rest of the panel.
- Rewritten: every read and write. The plugin reads the machine BB's server is on, or BB's file API. bb-box runs one command in the box, as the box user, through the box's command transport. Linux and macOS get a POSIX shell script. Windows gets PowerShell. Listing a directory is one command. Typing in the tree does not list again: the list stays until that folder changes, or the person refreshes it.
- Search uses ripgrep in the box when `rg` is on the path, and grep otherwise. On Windows, when ripgrep is absent, the fallback reads each file in PowerShell. The plugin keeps a corpus of the text files it has read for that folder, at most 8 MB, for 15 seconds. A later search uses the corpus when it holds the whole folder and the query is not a regular expression. A regular expression always runs in the box, so a pattern that backtracks cannot stall BB. Past the budget, the least recently used text is dropped. A folder that does not fit is searched in the box every time. On Windows the warm step lists names only, so a search there always runs in the box.
- Limits, each one the panel states in words: a directory lists at most 5,000 names. A text file opens up to 4 MB. An image opens up to 2 MB. Past that the view says the file is too large to open, and can show the first 256 KB. Search stops at 2,000 hits or 500 files. A save sends the hash the file had when it was opened. If the file has changed, the save does not write, and the view offers Reload or Overwrite. Delete asks before it removes anything.
- A device box, an iOS Simulator or an Android emulator, has no Files button. The files of the simulator are not the computer's files, and the button would not say which disk it meant. Linux, macOS and Windows boxes have it, including a Mac that hosts a simulator, when the box has a shell and is ready.
- The box user's own rights are the only rights used. File contents are not written to a log, a health check or an error. A failure says what to try next, and never the bytes that were read. That includes env files: opening one shows it in the view, and nowhere else.

## Consequences

- The panel gains a Files tab beside the thread, a Files button on a box's row and on its page, and a files view on the Boxes page. The tab opens at the box user's home. A path bar goes anywhere that user can read.
- The calls are the panel's RPC: `files.home`, `files.list`, `files.read`, `files.readRange`, `files.write`, `files.create`, `files.rename`, `files.delete`, `files.search` and `files.names`. Each is one command in the box.
- The plugin's copyright and permission notice is kept on the [Third-party software](../../THIRD-PARTY.md) page.
- A file name that contains a newline is not listed. Search skips `.git`, `node_modules` and `vendor`.
