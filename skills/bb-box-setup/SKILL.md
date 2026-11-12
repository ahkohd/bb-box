---
name: bb-box-setup
description: Set up or change bb-box for a person from the command line. Covers its backends (Docker, Proxmox LXC and QEMU, Tart, the SSH host pool with its Macs and iOS hosts, microsandbox, Hetzner Cloud, Namespace, boat.dev), kinds and sizes, warm and spare boxes, the tailnet, images and the Monitor. Use it when asked to make boxes work somewhere, add a machine, or change bb-box's settings.
---

# Setting up bb-box

bb-box makes boxes for BB threads on backends: places that boxes come from.
This skill is for setting them up and changing them for a person, with the
`bb box` command. Using boxes is in the `bb-box` skill.

Never hand-edit the configuration's JSON. Each `bb box backend`, `bb box
kind` and `bb box option` command makes one checked save, as the settings
page does: it is refused on the same problems, it gets a revision and a
receipt, and it prints what changed. A backend change then prints the
backend's own checks.

## Ground rules

- **Ask before you act on what is not yours.** Ask before you run a script
  on a machine, make something that costs money, or turn on a backend whose
  boxes can take over their host. Docker boxes are privileged containers by
  default, so a box there is root on that machine. Say that plainly when you
  ask.
- **Never see a secret.** Get API tokens, keys and OAuth clients with `bb
  secret request`, which asks the person in a form and writes a dotenv file
  you never read. Pass that file to bb-box with `--secret`. Never put a
  secret on a command line, never `cat`, `grep` or print the file, and never
  copy a secret into a message. To test that a variable is there, print only
  yes or no: `grep -q '^NAME=' file && echo yes || echo no`.
- **Prove it with a box.** A backend is set up when a box made there
  answers, not when its settings save. Release the box after.
- **Say what you did.** Report each backend's state, the doctor's warnings
  and the box you proved it with. Report what you left for the person to do.

## The steps

1. **Look first.** `bb box doctor`, `bb box backend list`, `bb box kinds`
   and `bb machine list` show what is there. Do not add a second backend for
   something that is already set up.
2. **Choose a backend.** Use the table below. When the request is plain,
   such as "set up boxes here", suggest a backend on the machine that runs
   BB: Docker on Linux, Docker in WSL 2 on a Windows PC, and microsandbox on
   a Mac with Apple silicon, where Docker's x86_64 images run emulated.
3. **Ask what only the person knows.** Ask about the machine, its address,
   what it may cost, and whether privileged boxes are acceptable. Their
   backend's reference file lists what to ask.
4. **Prepare the host.** Run the backend's setup scripts where its
   reference says, as the user it says. Read what they print: the lines to
   add to bb-box, host keys, and warnings.
5. **Add it with a check first.** Run `bb box backend add <type> ... --check`
   to see the problems and run the backend's checks without saving. Then run
   it again without `--check`. A backend is on unless you give `--off`. Give
   `--off` to save it part way, such as before its host is ready.
6. **Read the checks.** A save prints the backend's checks, and exits 2
   when they fail. Fix what they say, then `bb box backend set <id> --check`.
   `bb box doctor` checks everything.
7. **Prove it.** Make a first box on it, run a command in it, and release
   it. In a BB thread:
   `box_acquire({kind: "linux", on: "<backend ID>"})`, `box_run` with
   `uname -a`, then `box_release`. From a terminal, the same is
   `bb box acquire linux --on <backend ID>`, `bb box run <box> "uname -a"`
   and `bb box release <box>`, each in the thread (`--thread <id>` names
   one). With no thread at all, make the box one of the person's machines:

   ```sh
   bb box machines add linux --on <backend ID> --name first-box
   bb box run first-box "uname -a; nproc" --machine
   bb box machines remove first-box
   ```

   Read the State line: `ready` with `BB machine: enrolled` is the proof.
   `failed` says why. `ready` with enrolment failed means the backend works
   but boxes cannot reach BB: see "Boxes will not join BB yet" under When
   it goes wrong, and tell the person; `bb box run` still works there.
   Remove the box whatever happened.

## Which backend

| The person has or wants | Backend | Reference |
| --- | --- | --- |
| Docker on the machine that runs BB, or on one of their BB machines | `docker`, through `bb box setup docker` | [docker.md](references/docker.md) |
| Docker on another Linux host over SSH, or in WSL on a Windows PC | `docker` | [docker.md](references/docker.md) |
| Linux boxes with a kernel of their own, beside Docker | `microsandbox` | [microsandbox.md](references/microsandbox.md) |
| A Proxmox VE host: Linux boxes and desktops, GPU desktops | `proxmox-lxc` | [proxmox.md](references/proxmox.md) |
| Windows desktops, Linux VMs or Android on Proxmox | `proxmox-qemu` | [proxmox.md](references/proxmox.md) |
| Macs with Apple silicon, for macOS, iOS, arm64 Linux and Windows VMs | `tart` | [tart.md](references/tart.md) |
| Their own Linux machines or Macs, each lent whole; iOS slots on a Mac | `ssh-pool` | [ssh-pool.md](references/ssh-pool.md) |
| No machine of their own: rented by the hour, minute or second | `hetzner`, `namespace`, `boat` | [cloud.md](references/cloud.md) |

`bb box backend types` lists every type with the kinds it makes and its
guide. `bb box backend fields <type>` lists a type's fields, what each
takes, whether it is a secret, and its default.

## The scripts

The setup scripts and guides are in bb-box's repository, at the version that
is installed. `bb plugin source bb-box` says where it came from. Installed
from a folder, the scripts are in that folder: copy them from there.
Installed from Git, it gives the URL and the commit: clone that commit where
you need the scripts:

```sh
git clone <url> bb-box && git -C bb-box checkout <commit>
```

Each backend's guide, such as `setup/docker/README.md`, says more than its
reference file here. Read it when a step fails or the person asks why.

## The commands

| Command | What it changes |
| --- | --- |
| `bb box backend add <type> [--id <name>]` | A new backend, on unless `--off` |
| `bb box backend set <id>` | A backend's fields, secrets, switch, name, warm boxes and the projects it is kept for |
| `bb box backend remove <id> --yes` | Removes a backend, with its secrets. Refused while it has boxes |
| `bb box backend host add\|set\|remove <id> <host>` | The hosts of a backend that has them, such as Tart's Macs |
| `bb box kind set <kind>` | A kind's switch, sizes, default size, largest size and spares, or makes it the default kind |
| `bb box option set <name>=<value>`, `bb box option unset <name>` | The general and Monitor options. `bb box option list` and `bb box option get <name>` show them |

They take these options:

- `--field key=value` sets a field, and `--unset key` gives it back its
  default. `key=` with nothing after it saves an empty value: for an image
  or template field, that turns its kind off on this backend.
- `--add-line key=line` and `--remove-line key=text` edit a field that holds
  lines, such as the SSH host pool's `machines`. `--field-file key=path`
  sets a field to a file's text.
- `--on` and `--off` turn a backend or host on and off. Off, it makes no new
  boxes, and its boxes keep working.
- `--warm kind=count` keeps ready boxes of a kind waiting on that backend.
- `--projects "Work, Client"` keeps a backend for those BB projects, by name
  or ID: only their threads see it, and they use it before shared backends,
  falling back to shared ones when it is full. Threads elsewhere, or in no
  project, never see it. `--projects ""` gives it back to every project.
  Ask which projects first: it is the person's choice, such as a work
  account kept for work. `bb box doctor` warns when none of its projects is
  still in BB.
- `--check` saves nothing. It says what would change, lists the problems
  and runs the backend's checks.
- `--revision n` saves only while the configuration is at revision `n`.
  Without it, the change is made on the latest revision.
- `--operation <id>` names the save. If an answer never comes, run the same
  command with the same ID. It is saved once, and the receipt says at which
  revision.
- `--json` prints the outcome as JSON: `saved`, `revision`, `operation`,
  `receipt`, `changes`, `problems` and `doctor`.

The exit code is 0 when it saved, 1 when nothing was saved, and 2 when it
saved but the backend's checks failed. `bb box config show` prints the whole
configuration, without secrets. A person can do the same on the settings
page's Configuration page: Export downloads that file, and Import checks one
and lists what it changes, before and after, before Apply.

## Secrets

Ask for the secret, then hand bb-box the file:

```sh
bb secret request HCLOUD_TOKEN --write-env "$BB_THREAD_STORAGE/bb-box.env" \
  --purpose "bb-box needs a Hetzner Cloud API token to make hosts" \
  --describe HCLOUD_TOKEN="Read & Write token of the project for bb-box"
grep '^HCLOUD_TOKEN=' "$BB_THREAD_STORAGE/bb-box.env" | \
  bb box backend add hetzner --secret token=HCLOUD_TOKEN --secrets-stdin
```

- `--secret field=VARIABLE` names a secret field and the variable that
  holds its value. Repeat it for each secret.
- `--secrets-stdin` reads one line from stdin: one `VARIABLE=value` line,
  or for several secrets at once the whole file in base64:
  `base64 < "$BB_THREAD_STORAGE/bb-box.env" | tr -d '\n' | bb box ... --secrets-stdin`.
  It works from any machine.
- `--secrets-file <path>` reads the dotenv file itself, on the machine BB's
  server runs on. Use it only when your thread runs on that machine.
- `--secret-file field=path` takes a whole file, such as an SSH private
  key, also on the machine BB's server runs on.
- `--clear-secret field` clears one.

A secret on the command line, as `--field token=...`, is refused, and the
value is not printed. bb-box shows a secret only as set or not set.

Several backends need an SSH key that their hosts accept. Leave
`ssh-private-key` empty, and bb-box makes one. Add the backend with `--off`,
then run `bb box backend set <id> --check`: a note in its checks gives the
public key, starting `ssh-ed25519`, to give the host's setup script.

## Kinds and sizes

A kind is a type of box, such as `linux` or `macos-desktop`. It is offered
when it is on and a backend that is on makes it. `bb box kinds` lists the
kinds on offer, their presets and their default.

- **Size**: `bb box kind set linux --cores 4` changes the cores of the
  kind's default preset. `--preset medium` changes another preset. Memory is
  `--memory-gib` and disk `--disk-gib`, or `base` for the image's own disk.
  `--default-preset medium` makes another preset the default. "Make Linux
  boxes 4 cores by default" can be either: say which you chose. Boxes made
  before keep their size. On the SSH host pool a box has its whole machine,
  so a size only chooses which machine fits it: say so when the pool makes
  the kind.
- **Largest**: `--largest-cores`, `--largest-memory-gib` and
  `--largest-disk-gib` set the most a custom size may ask for.
- **On and off**: `--off` stops offering a kind. The default kind stays
  on: make another the default first, with `--make-default`.
- **Spares**: `--spares 1` keeps a box of the kind ready, enrolled and owned
  by no thread, so a thread has one at once. Each spare holds its memory and,
  on a cloud backend, costs money while it waits.
- **Warm boxes** are per backend: `bb box backend set <id> --warm linux=1`.
  A warm box is started and waiting, but not yet a BB machine.
- `--reset` goes back to bb-box's own sizes for the kind.

## Options

`bb box option list` shows each option, its value and its default, and
`bb box option get <name>` shows one. Change
several in one save: `bb box option set boxesPerThread=4 enrol=true`.

- **The Monitor**: `bb box option set monitor.enabled=false` turns it off:
  machine status in the sidebar, its sampling, background monitoring and
  its notifications all stop, and its other options keep their values for
  when it is on again. BB's sidebar shows the change when BB next loads, so
  tell the person to reload BB. `bb box doctor`'s Monitor line confirms it.
- **Rebuild each night**: `nightlyImages=true` rebuilds the standard images
  that are due at 03:00 on BB's server. `bb box setup docker` turns it on.
- **Enrolment**: `enrol=false` keeps boxes from joining BB as machines.
  Turn it off when boxes cannot reach BB's server, as in a BB that listens
  only on localhost.
- **The tailnet**: cloud backends' machines must reach BB's server. When BB
  is on a Tailscale tailnet, bb-box joins them to it with an OAuth client.
  The person makes the client as `docs/guide/tailnet.md` says. Ask for its ID
  and secret with `bb secret request`, then save the mode and both secrets
  in one command:

  ```sh
  base64 < "$BB_THREAD_STORAGE/bb-box.env" | tr -d '\n' | \
    bb box option set general.tailnet.mode=oauth general.tailnet.tags=tag:bb-box \
      --secret general.tailnet.clientId=TS_CLIENT_ID \
      --secret general.tailnet.clientSecret=TS_CLIENT_SECRET --secrets-stdin
  ```

  `bb box option unset general.tailnet.mode` turns it off. The doctor's
  Tailnet section checks it.

## Images

The standard images are built by each backend's setup, or by bb-box itself
for Docker on a BB machine and the cloud backends. `bb box images list`
shows their age and what is due, and after them the Linux images each
Namespace backend builds in its own workspace, and each boat.dev backend's
templates. An image whose rebuild failed is skipped until something it is
built from changes, such as the build program after a BB Box update; `bb box
images build <name>` tries it again at once. Builds retry a package download
only when Ubuntu's archive did not serve it, for at most 10 minutes in all.
A failure that says the archive did not serve it for that long is an
outage: build again later. Any other apt error fails at once with apt's
own message, and needs a fix. Scripts that call `apt-get` themselves are
not retried. A check line "first docker command" that says "slow both
times" means Docker was slow at two fresh starts: a busy host, or a delay
in the image. A project's own image, a script run on the
standard image, is in the `bb-box` skill, under "A project's image".

## When it goes wrong

- **Refused with problems**: each problem names its field, such as
  `backends.docker.host`. Fix that field and run the command again. Nothing
  was saved.
- **"The configuration changed since revision n"**: someone else saved
  first. Run `bb box config show` and the command again, without
  `--revision`.
- **"Operation ... was saved at revision n with other changes"**: you used
  an operation ID again for another change. Leave out `--operation`, or give
  a new one.
- **Saved, but its checks failed (exit 2)**: the settings are kept. Fix the
  host as the check's `Fix:` line says, then `bb box backend set <id>
  --check`. Turn the backend off with `--off` if the person wants to finish
  later.
- **"Boxes will not join BB yet"**, or a box that does not join BB: boxes
  reach BB's server through BB's machine access. Signed in to a bb account,
  that is bb connect. Otherwise BB needs an address boxes can reach, and
  must listen on it (started with `npx bb-app --server-bind-host 0.0.0.0`).
  `bb settings show` shows BB's settings now. The address is one of this
  machine's own, from `hostname -I`, on BB's port, that a box can reach.
  Ask the person which, then set both:
  `bb settings general machineServerUrl http://<address>:<port>` and
  `bb settings general defaultMachineAccess direct`. These are BB's own
  settings, so ask first. Or turn enrolment off with
  `bb box option set enrol=false`: boxes then work, but not as BB machines.
- **A box fails for a missing image while a build runs**: the image is
  still building. `bb box setup docker` run again says how far it is.
- `bb plugin logs bb-box` says why each box was released, and how long each
  step took.
