# Enrolment and warm pools

How a box becomes a BB machine, how long that takes, and whether a warm box
can be enrolled before a thread claims it.

Status: a recommendation from BB's source and local measurements. The full
timing needs one experiment on a real host. Checked against BB 0.44.0
(server protocol 219) on 30 September 2026.

## Recommendation

1. **Enrol through BB's machine provider API.**
   - bb-box registers one machine provider. To enrol a box, it calls
     `hosts.experimental_create` with the box ID as the key.
   - BB then calls the provider's `create`, which calls
     `machines.bootstrap` with an executor that runs over the box's command
     transport.
   - BB issues the credential and runs its own installer. The credential
     passes through the transport as stdin, and bb-box never stores or logs
     it.
2. **Templates carry what the installer needs.** That is Node.js 22.19 or
   newer, npm and curl. bb-app is pre-installed with its digest file, so the
   installer skips the download and `npm install`, which saves about 2 s.
3. **Templates with systemd enable linger for the box user.** Without it, the
   host daemon stops within 15 s of the SSH session that installed it
   (measured). An SSH pool machine turns linger on at claim, since its reset
   turns it off.
4. **Boxes without systemd need nothing more.** The installer keeps its
   daemon running. After a restart, bb-box calls `bootstrap` again with the
   same key, which starts the daemon without enrolling again.
5. **Enrol when a box is claimed, not before.** A box runs commands while it
   enrols, and nothing BB sends is fixed at enrolment. Pre-enrolled warm boxes
   would show in BB's machine list, where anyone could start a thread on them.
   Revisit this if the experiment below shows enrolment takes more than 3 s.

## How enrolment works

BB's machine providers are the way a plugin adds machines. A provider has
`create`, `remove` and optional `suspend` and `resume`. Inside `create`,
`machines.bootstrap({key, executor})` does the enrolment:

| Step | Who | What happens |
| --- | --- | --- |
| 1 | BB | makes a one-time enrolment credential for the host |
| 2 | executor | runs `sh -c` in the box with the credential on stdin, which fetches `/install.sh` with curl and runs it |
| 3 | installer | checks Node and npm, then asks for bb-app with the installed digest. A 304 skips the download and npm |
| 4 | installer | starts a temporary daemon with `host-daemon join`, and polls its `/status` every 1 s until it connects |
| 5 | installer | with a service manager: stops the temporary daemon (1 s polls), writes the systemd or launchd unit, starts it, and polls again every 1 s |
| 5 | installer | without one: keeps the temporary daemon running and exits |
| 6 | BB | waits for the host to connect, polling every 250 ms, for up to 120 s |

- If the host has connected before, `bootstrap` with the same key runs the
  installer's `--start` instead, so it is safe to repeat.
- The installer runs systemd's user scope in a container, even as root. It
  uses a service only when `systemctl --user` works. Otherwise it leaves the
  daemon running.

## What was measured

On a Linux devbox with 64 CPUs, close to its BB server on the network, with
`npm install` in fresh `node:24-bookworm-slim` containers:

| Step | Time |
| --- | --- |
| Download bb-app (1.2 MB) from the BB server | 0.012 s |
| The same request with the installed digest (304) | 0.008 s |
| `npm install` of bb-app (66 MB installed) | 1.61 to 1.86 s |
| `node -e 0` | 0.010 s |
| Start `bb-app` to print its help | 0.050 to 0.064 s |

The installer has 34 small `node -e` calls, though no single run makes all
of them. Pre-installing bb-app saves about 2 s. The rest is the 1 s polls,
one or two connection waits and the service handover. We estimate 4 to 7 s
with a service and 2 to 4 s without, which the experiment below will check.

Linger, in a Debian 12 container with systemd, run over SSH as root:

| Case | 15 s after the SSH session ended |
| --- | --- |
| no linger | root's user manager stopped, and the service with it |
| `loginctl enable-linger root` | user manager and service running |
| linger, container restarted | service running again |

## What BB sends to an enrolled box

Nothing thread-specific is fixed at enrolment:

- BB resolves a machine's environment each time it is used: its Git
  credentials, and the global and project machine variables. Commands,
  terminals, the thread runtime and plugin host calls each get the current
  values.
- BB pushes the machine environment again when the host connects and when
  the settings change.

So a pre-enrolled warm box would be safe, and renaming it on claim works
(`hosts.update` with a name). The case against pre-enrolment is that warm
boxes would be visible machines, not how long enrolment takes.

## bb-box inside an enrolled box

A plugin's host entry runs on every enrolled machine, through the daemon's
own connection to BB. Each call gets the machine environment as its process
environment. bb-box can use this to write the thread's environment to a file
in the box, which its SSH sessions then load. This works because SSH sessions
do not go through BB, so they do not get the environment otherwise. The file
is written on enrolment and refreshed before `run` when it is older than
5 minutes.

## A thread on a new box

A provider marked `ephemeral` can also be the place a thread runs. You pick
"new bb-box box" when starting a thread, BB calls `create`, and BB removes
the machine when no thread uses it. This fits BB well, but the box then
belongs to a machine, not a thread. It is a later step, after enrolment works
for boxes that threads acquire.

## What a template needs

| Need | Why |
| --- | --- |
| Node.js 22.19 or newer, npm, curl | the installer and bootstrap use them |
| bb-app in `~/.bb-machines/<server host>/npm`, and `host-artifact.sha256` beside it | the installer skips the download and npm |
| linger for the box user, where systemd runs | the daemon survives the SSH session |
| no `auth.json` in the data directory | the box enrols as a new machine |

A template built for an older BB still works: the digest differs, so the
installer downloads and installs bb-app again, adding about 2 s. The setup
script rebuilds templates when BB updates.

## Experiment for a real host

Time a real enrolment in a box made from the current template. This enrols
three machines, so remove them afterwards.

1. Get a machine enrolment command from BB's machine settings: the
   `curl ... | sh` line.
2. In a new box, run it with a timestamp on each line:

   ```sh
   sh -c '<the command>' 2>&1 | while IFS= read -r l; do
     printf '%s %s\n' "$(date +%T.%3N)" "$l"; done
   ```

3. Repeat in a second box after pre-installing bb-app:

   ```sh
   S=<server URL>; H=$(printf '%s' "${S#*://}" | tr -c 'a-zA-Z0-9.-' '-')
   D=$HOME/.bb-machines/$H; mkdir -p "$D"
   curl -fsS -D /tmp/h -o /tmp/bb-app.tgz "$S/install/bb-app.tgz"
   npm install -g --allow-scripts=node-pty,@parcel/watcher --prefix "$D/npm" /tmp/bb-app.tgz
   sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]*\).*/\1/Ip' /tmp/h > "$D/host-artifact.sha256"
   ```

4. In a third box, pre-install, run `loginctl enable-linger root`, enrol,
   log out, wait 30 s, and check the machine is still connected with
   `bb machine show <name>`. Do the same check on the first box, which has no
   linger.
