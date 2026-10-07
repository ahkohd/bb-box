# Files

You can move files between a thread and its boxes, and have some files in every box from the start.

## Copying a file to or from a box

Agents copy files with the `box_copy` tool. To copy a file, ask the thread's agent.

`box_copy` copies one file at a time, in either direction, between the box and:

- the thread's workspace, where the project is
- the thread's storage folder

A relative path in the box is under the box user's home. To copy a folder, the agent makes it into one archive file first.

A file over 16 MiB streams through the thread's machine, and BB Box checks it arrived whole. A file too large to copy in one go is refused, with the commands to move it in parts.

See [agent tools](../reference/tools.md) for `box_copy`.

## Files for every box

Some programs need a file in your home folder that no project has, such as an agent's settings file with its API key. Files for every box puts such files into each box for you.

To add one, go to Settings, BB Box, Files for every box, and select **Add file**. Give the file's path under the box user's home, such as `.pi/agent/models.json`, and paste its contents.

BB Box then writes the file:

- into each Linux and macOS box as it becomes a BB machine
- into every running box, when you add or change a file
- into a stopped box, when it starts again

Each file is readable by the box user only. Windows boxes do not get these files. Removing a file from the list does not delete it from boxes that already have it.

A file's contents can hold an API key, so BB Box keeps them secret. It never shows them again, and never writes them to a log or a tool's output. The settings page shows only whether each file's contents are set. You can replace the contents, or remove the file.

You can have up to 20 files, each up to 1 MiB.
