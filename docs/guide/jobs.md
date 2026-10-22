# Long commands and jobs

Agents run commands in a box with the `box_run` tool. A command that takes longer than 4.5 minutes goes on in the box as a job, and the agent reads its result later with `box_job`.

## Why long commands become jobs

BB ends an agent's tool call after about 5 minutes. So `box_run` waits for a command for 270 seconds at most. If the command is still running then, it goes on in the box as a job. The agent gets the output so far, and the job's name.

A command also goes on as a job when BB Box restarts while it runs, for example for an update. BB Box waits 5 seconds for running commands to finish before it restarts, as agents cannot use its tools until it is back.

On Windows, a command run in the desktop session does not go on as a job. It is stopped at 270 seconds, and the agent gets its output so far.

## Reading a job

The agent calls `box_job` with the job's name. While the job runs, `box_job` gives its output so far. Once it ends, `box_job` gives its exit code and all its output.

After `box_job` has given a job's result, the box's next command clears the job away.

## Time limits

A command stops after 10 minutes unless the agent asks for longer, up to an hour. At its limit, the command and everything it started are stopped.

For something that must keep running, such as a server, the agent starts it in the background:

- on Linux and macOS, with `nohup` and its output sent to a file
- on Windows, with `Start-Detached`

See [agent tools](../reference/tools.md) for `box_run` and `box_job`.
