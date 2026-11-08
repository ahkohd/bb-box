# A box's files

A box's files view reads and changes the box user's own files. It is not the thread's workspace, and it is not a copy between your computer and a box. For that, see [Files](files.md).

## Opening the files

You can open a box's files from:

- the Box panel: select **Open files** on the box's row. That opens a tab called 'Files:' and the box's name, with a folder for its icon. On a narrow screen, such as a phone's, the tab is called by the box's name alone
- the thread's Files tab: it opens the only box whose files can be opened, lists the boxes when there are several, or offers the Box panel when there is none
- the Boxes page: select **Files** on a box's page. On a desktop, select **Open files** in the toolbar's menu, beside **Open thread**. The files show on the page, with a back arrow to where you opened them
- the Monitor: when it shows a box, select **Open** beside the box's name, then **Open files**

The view opens at the box user's home. The path bar goes anywhere that user can read. Select **Home** to return there, and **Up** for the folder above. Select **Refresh** to read the folder again.

A device box, an iOS Simulator or an Android emulator, has no Files button. Open the computer the simulator runs on to see that computer's files. A box that is not ready, or that has no shell, has no files view until it can run a command.

## Reading and editing

Select a file to open it. A text file opens up to 4 MB. An image opens up to 2 MB: png, jpg, jpeg, gif, webp, svg, bmp and ico. Past that, the view says the file is too large to open. You can show its first 256 KB. That slice cannot be saved from here.

A Markdown file has **Read**, **Edit** and **Preview**. Other text has **Read** and **Edit**. Select **Save**, or press Ctrl or Command with S.

If the file changed after you opened it, the save does not write. The view says so, and offers **Reload** or **Overwrite**.

**New file**, **New folder** and **Rename** use the folder in the path bar, or the selected name. **Delete** asks before it removes anything. It will not delete the root of the filesystem or the box user's home.

A folder lists at most 5,000 names. A name that contains a newline is left out. Files whose names start with a dot stay hidden until you select **Hidden**.

## Search

Search in files looks under the folder in the path bar. It uses ripgrep when the box has it, and grep otherwise. On Windows, when ripgrep is absent, it reads each file in PowerShell. It skips `.git`, `node_modules` and `vendor`. It stops at 2,000 hits or 500 files.

Go to a file by name with Ctrl or Command with P. Find in the open file with Ctrl or Command with F. Focus the search with Ctrl or Command with Shift and F. Escape closes go to file, then the search, then find in the file.

The first search runs in the box. A later search of the same folder can use text the view has already read, at most 8 MB, for about 15 seconds, when the query is not a regular expression. A regular expression always runs in the box. On Windows the view keeps names only, so a search there always runs in the box.

## What an agent uses

Agents do not use this view. They run commands with the `box_run` tool, or use the terminal. See [agent tools](../reference/tools.md).

The view runs as the box user, through the same path as the terminal. It can read and change only what that user can. What it reads is not written to a log.
