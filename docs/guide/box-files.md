# A box's files

A box's files view reads and changes the box user's own files. It is not the thread's workspace, and it is not a copy between your computer and a box. For that, see [Files](files.md).

## Opening the files

You can open a box's files from:

- the Box panel: select **Open files** on the box's row. That opens a tab called 'Files:' and the box's name, with a folder for its icon. On a narrow screen, such as a phone's, the tab is called by the box's name alone
- the thread's Files tab: it opens the only box whose files can be opened, lists the boxes when there are several, or offers the Box panel when there is none
- the Boxes page: select **Files** on a box's page. On a desktop, select **Open files** in the toolbar's menu, beside **Open thread**. The files show on the page, with a back arrow to where you opened them
- the Monitor: when it shows a box, select **Open** beside the box's name, then **Open files**

The view opens at the box user's home. The path bar at the top of the tree goes anywhere that user can read. Type a path and press Enter. The folder button returns home. The up arrow opens the folder above. The reload button reads the folder again.

A device box, an iOS Simulator or an Android emulator, has no Files button. Open the computer the simulator runs on to see that computer's files. A box that is not ready, or that has no shell, has no files view until it can run a command.

## Reading and editing

Select a file to open it. A text file opens up to 4 MB, and BB's source view colours it. An image opens up to 2 MB: png, jpg, jpeg, gif, webp, svg, bmp and ico. Past that, the view says the file is too large to open. You can show its first 256 KB. That slice cannot be saved from here.

A Markdown file has **Preview**, **Read** and **Edit**. Other text has **Read** and **Edit**. Select the check mark to save, or press Ctrl or Command with S. The check mark stays disabled until the text has changed.

If the file changed after you opened it, the save does not change it. The view says so, and offers **Reload** or **Overwrite**. The text you tried to save is put in a new file next to it. The name adds .conflict, or .conflict-2 when that name is taken. A link of that name is left as it is.

The tree lists the files under the path bar, at most 20,000 names. It skips `.git`, `node_modules` and `vendor`. A name that contains a newline is left out. Files whose names start with a dot stay hidden until you select the eye.

On a wide window the tree stays beside the file. Drag its edge to resize it. The width is remembered, and it starts at the same width as the editor plugin's tree. On a narrow window, such as a phone, the tree and the open file take turns. The tree is shown first. Opening a file replaces it, and the back arrow returns to the tree.

New file and New folder sit with the tree's other icons. They create in the folder the path bar shows. Right-click a row, or select … on the row, for New file, New folder, Rename and Delete. Rename is a field on the row. Delete asks you to confirm. An empty folder stays in the tree.

## Search

Search in files is the field across the tree. It looks under the folder in the path bar. Match case, whole word and a regular expression sit inside the right edge of the field. It uses ripgrep when the box has it, and grep otherwise. On Windows, when ripgrep is absent, it reads each file in PowerShell. It skips `.git`, `node_modules` and `vendor`. It stops at 2,000 hits or 500 files.

Go to a file by name with Ctrl or Command with P. Find in the open file with Ctrl or Command with F. The find bar sits above the file. Focus the search with Ctrl or Command with Shift and F. Escape closes go to file, then find in the file.

The first search runs in the box. A later search of the same folder can use text the view has already read, at most 8 MB, for about 15 seconds, when the query is not a regular expression. A regular expression always runs in the box. On Windows the view keeps names only, so a search there always runs in the box.

## What an agent uses

Agents do not use this view. They run commands with the `box_run` tool, or use the terminal. See [agent tools](../reference/tools.md).

The view runs as the box user, through the same path as the terminal. It can read and change only what that user can. What it reads is not written to a log.
