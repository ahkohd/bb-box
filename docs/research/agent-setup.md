# An agent sets bb-box up

On 29 October 2026, fresh agents were given the `bb-box-setup` skill and the
new `bb box backend`, `kind` and `option` commands, and plain requests from
a person. This note says what they did, where they went wrong, and what was
changed in the skill or the CLI because of it.

## The commands, and why they are shaped so

The configuration is one checked document (029), and the settings page
saves it through `config.check` and `config.apply`, with a revision, an
operation ID and a receipt (067). Before these commands, an agent changed
it from a terminal only by exporting the whole document, editing the JSON
and applying it back. The new commands each make one change through the
same calls:

| Command | The page's control |
| --- | --- |
| `bb box backend list`, `types`, `fields <type or ID>` | The backends list, Add backend's list of types, a backend's fields |
| `bb box backend add <type> [--id <name>]` | Add backend, then Save and turn on, or Save with `--off` |
| `bb box backend set <ID>` | A backend's form and its switch |
| `bb box backend remove <ID> --yes` | Remove backend, with its confirmation |
| `bb box backend host add`, `set`, `remove` | Tart's Macs |
| `bb box kind set <kind>` | A kind's page: switch, presets, default, largest, spares, Make default |
| `bb box option list`, `get`, `set`, `unset` | Options: Boxes, Images, Devices, Network and Monitor |
| `bb box run <box> <command>` | None: added for the agents' proof, below |

The names follow the `bb box` commands already there: a noun, then a verb,
as `bb box image set` and `bb box machines add` are. `bb box kinds` and
`bb box config` stay as they were. "option" names what the page calls
Options; "setting" would be confused with `bb settings`, BB's own.

What they share:

- **One checked save.** Each reads the configuration, makes its change on
  the latest revision, and calls `config.apply` with it. Refused for a
  revision that moved, it makes the change again on the new one, at most 3
  times, as a switch on the page does. `--revision n` saves only at that
  revision and refuses otherwise. The refusals are the page's: problems at
  their fields, a backend that has boxes, a reused operation ID.
- **An operation ID and its receipt.** Each save has an operation ID,
  `cli-<uuid>` or the one `--operation` gives. The same command with the
  same ID, as after an answer lost on the way, answers with the first
  save's receipt and saves nothing more.
- **What changed, and the doctor's words.** A save prints each change as
  its path and before and after. A save that touches a backend that is on
  then runs that backend's checks through `config.check` and prints them,
  and records them against the revision they checked, as the page's Check
  does. The exit code is 2 when it saved and those checks failed.
- **`--check`** saves nothing, says what would change, lists the problems
  and runs the backend's checks with the change: the page's Check.
- **Secrets never on the command line.** `--field` refuses a secret field
  without printing its value. A secret comes from a dotenv file, as
  `bb secret request --write-env` writes, by `--secret field=VARIABLE` with
  `--secrets-file <path>` or `--secrets-stdin`. BB's CLI reads one line of
  at most 16 KiB for a `-stdin` option, so that line is one `VARIABLE=value`
  line, or the whole file in base64 for several secrets at once, as the
  tailnet's client needs. Output and JSON show a secret only as set,
  replaced or cleared. A save's submission, which bb-box keeps only as a
  digest, holds each secret as its SHA-256.
- **Removal asks.** `bb box backend remove` without `--yes` says what would
  go, the secrets and warm boxes, and removes nothing.
- **The default kind stays on**, as on the page, even where the
  configuration names no default kind.

Every command has tests in `test/config-cli.test.ts`: the receipt and its
replay, a reused ID refused, a stale revision refused, a change made by
someone else in between kept, problems refused and saved off, a backend's
checks failing after its save, removal with and without boxes, hosts, kinds,
options, the tailnet's secrets, `--json`, and no made-up secret in any
output. `test/docs.test.ts` checks that the skill names every one of these
commands and every backend type.

## How the agents were run

- **The BB.** A fresh `npx bb-app` 0.48.0 with no account, in a Linux box
  (8 cores, 16 GiB, Docker 29.1), as a Linux user of its own, `fresh`, with
  its own data folder and port. bb-box was installed there from this
  branch's folder, with `bb plugin install`.
- **The machine for the SSH host pool.** A second Linux box, with an admin
  user `ops` that `fresh` reaches over SSH and that may use `sudo`.
- **The agents.** Each was a new BB thread of the lead's BB, on Claude Code
  with Claude Opus 5.5, started on the first box. Its prompt said to run
  everything as `fresh`, through `sudo -iu fresh bash -l`, which reaches the
  fresh BB alone. It listed the fresh BB's two bb-box skills by name,
  description and file, as BB lists skills, and said to read a skill when
  its description fits. It gave the person's request, and said the person
  was away. Nothing else was said about bb-box.
- **Round 1.** "Set up Docker boxes here", "Turn the Monitor off" and "Make
  Linux boxes 4 cores by default" ran at the same time on the new BB, then
  "Add this Linux machine to the SSH host pool".
- **Round 2.** The fresh BB's data folder was deleted and BB started again,
  bb-box installed again, the Docker images bb-box had built removed, and
  the pool machine's setup undone as its guide says. Then the four requests
  ran again, with the skill and CLI as changed after round 1.

## What the agents did

Every run did what it was asked and proved it with a box, which it then
removed. None hand-edited the configuration, printed a secret, or touched
the other agents' work. The times are the agents' own.

| Request | Round 1 | Round 2 |
| --- | --- | --- |
| Set up Docker boxes here | `bb box setup docker`, the Linux image in about 4 min. It warned that boxes would not join BB, as BB had no account; the agent found BB's machine access settings in `bb guide machines`, set them, and proved it with `bb box machines add`: ready in 0.5 s, a BB machine 5.4 s later. It ran a command in the box with `bb terminal create` | The same, in 3 min 20 s, with the machine access commands now in the warning and the skill. Its box joined BB in 8.5 s, and it ran `uname -a`, `nproc` and `docker version` with `bb box run` |
| Turn the Monitor off | `bb box option set monitor.enabled=false`, confirmed by `option list` and `bb box doctor`; told the person to reload BB. Under 0.3 s a command | The same, with `bb box option get`. About 1 s a command |
| Make Linux boxes 4 cores by default | `bb box kind set linux --cores 4 --check`, then saved: `small`, the default, from 2 to 4 cores. Its first proof box failed, as the Docker run was still building the image; it waited, and the second had 4 cores | The same. Its box had 4 cores, and its CPU limit was 4 of the host's 8 |
| Add this Linux machine to the SSH host pool | Added the pool off, took bb-box's public key from `--check`, ran `setup.sh` on the machine, added its line and host keys with `--add-line` and turned the pool on: every check passed. Its box was the machine's whole 4 cores, and the release reset it | The same, run beside the Docker run. As BB's machine access was not set yet, its box did not join BB. The agent said so and did not change BB's setting unasked, as the skill says; `bb box run` worked in the box all the same |

Where they went wrong or were slowed:

- **Machine access.** A fresh BB with no account cannot be reached by its
  boxes, and the warning said so only in terms of BB's settings page. The
  round 1 Docker agent found `machineServerUrl` and `defaultMachineAccess`
  itself; setting the URL alone was not enough.
- **No command in a box from a terminal.** The skill's proof ran
  `uname -a` in the box, but outside a thread there was no command for it:
  agents used `bb terminal create` and `docker exec`.
- **Guessed commands.** `bb box option get` and `bb box machines list`, both
  missing in round 1.
- **The scripts' folder.** The skill said to clone the installed commit,
  but `bb plugin source` gives a folder for a bb-box installed from one.
- **Sizes and the pool.** A pool box has its whole machine, so "4 cores by
  default" holds only on backends that size their boxes. The round 2 agent
  noticed; the skill did not say it.
- **Outside this work**: a box that failed for a missing image did not say
  the image was building; `bb box images list` said no backend had images
  for Docker on a BB machine; `bb box setup docker` printed nothing until
  it ended; `bb settings general <key>` cannot read a value, though
  `bb settings show` can.

## What was changed because of them

| After | Change |
| --- | --- |
| Monitor, round 1 | `bb box option get <name>`. The skill says that the Monitor off stops all of its parts, and that the doctor confirms it |
| Docker, round 1 | `bb box setup docker`'s warning gives the two `bb settings general` commands. The skill's When it goes wrong covers machine access, and docker.md says to settle it before the proof |
| Docker and cores, round 1 | `bb box run <box> <command>`, for a thread's box or, with `--machine`, one of the person's machines, exiting with the command's code. The skill's proof gives the thread, terminal and no-thread ways, and says to read the State line |
| Pool, round 1 | The skill says a bb-box installed from a folder has its scripts in that folder |
| Pool, round 2 | The skill says what ready but not enrolled means |
| Docker, round 2 | The skill says `bb settings show` shows BB's settings, and how to find an address |
| Cores and Monitor, round 2 | The skill says a size on the pool only chooses the machine; `monitor.enabled`'s help names its notifications |

## Not done

- The other backends' setups were not run by an agent: Proxmox, Tart, the
  pool's Macs, microsandbox and the cloud backends need hosts or accounts
  that a test may not use. Their reference files follow their guides, and
  their commands are the same commands the runs proved.
- `bb secret request` was not run: it needs a person at BB's form. The
  tests feed made-up secrets through the same parsing.
