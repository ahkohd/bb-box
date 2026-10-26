# Android template

The Android template is a Proxmox QEMU template for Android emulator boxes
([063](../../docs/decisions/063-device-boxes.md)). It is the Linux VM
template with:

- the Android SDK's command-line tools, the emulator and platform-tools
- the Android 15 (API 35) Google APIs system image for x86_64, with no Google
  Play
- an AVD for each device bb-box offers: Pixel 8, Pixel Fold and Pixel Tablet,
  each booted once and saved to its snapshot
- `bb-box-h264`, the device's frame encoder
- the device's firewall, which keeps the emulator's ports to the box

bb-box offers android boxes from the template once it is listed in Proxmox
QEMU's settings, `linux-kvm` is on, and the template's record lists its
devices. A box clones the template, and its device server boots the box's
device from its snapshot, as [below](#a-box-from-the-template).

## What you need

- A Proxmox QEMU backend set up as its [guide](../proxmox-qemu/README.md)
  says, with a Linux template built by `build.sh linux`.
- Nested virtualization on the host. `build.sh linux` says whether KVM works
  in a clone. If it does, `linux-kvm` is on in Proxmox QEMU's settings. The
  emulator needs KVM, and the Android build stops without it.
- About 50 GiB on the box storage for the template, and about 40 GiB more
  beyond the disk kept free for a refresh's build and trial boxes and a box
  in use.
- Your acceptance of the Android SDK's licence, below.

## Steps

### 1. Accept the Android SDK's licence

The SDK, the emulator and the system image are Google's, under the Android
Software Development Kit License Agreement. bb-box does not pass them on:
each template downloads them from Google, and stays in your install. You
accept the terms, once, as root on the Proxmox host:

```sh
cd setup/android
./accept-sdk-licence.sh
```

It shows the terms, as Google's repository manifest gives them, and checks
that they are the terms bb-box pins. Type `yes` to accept them. It then
writes `/etc/bb-box/android-sdk-license`, which the build needs. The
template keeps your acceptance, and its refreshes use it. If a bb-box update
pins other terms, a refresh stops and says so: run this step again, then
build the template again.

### 2. Build the template

As root on the Proxmox host:

```sh
cd setup/proxmox-qemu
./build.sh android 9108
```

It builds the Linux VM template as `build.sh linux` does, then runs
[`customize-android.sh`](customize-android.sh) in the build VM. That installs
the SDK, each part pinned by URL and SHA-256 in [`pins.json`](pins.json),
then boots each device cold, sets its defaults, and saves its snapshot. It
removes Java, which only `avdmanager` needs. At the end it checks a clone of
the new template with `bb-box-check-android`: each device boots from its
snapshot, its screens' pixels match bb-box's model table, its defaults hold,
its gRPC refuses no token and a wrong one, and its ports are closed. Then it
hibernates and resumes the clone.

`bb-box-h264` uses Cisco's OpenH264 binary, downloaded from Cisco. To use
x264, built from source in the template, add `--with-x264`. x264 takes about
two thirds of OpenH264's time a frame, for a better picture
([063 results](../../docs/decisions/063-results.md#e7-x264-against-openh264)).
A refresh keeps the encoder the template has.

`--replace` and `--keep` work as for the other templates.

### 3. Configure bb-box

Add the template's VMID to `android-templates` in Proxmox QEMU's settings.
Then run `bb box doctor`. Its checks for an Android template:

- **Android template**: the template is there, on storage with room.
- **Image of Android template**: its age, pins and tools, and that its record
  offers Android devices. It warns at 60 days old.
- **KVM for Android**: `linux-kvm` is on.
- **Disk for Android**: its storage has about 40 GiB beyond the disk kept
  free.

## What the template has

| Part | Disk |
| --- | --- |
| Android SDK: emulator, platform-tools, command-line tools, system image | 4.6 GB |
| Pixel 8, with its snapshot | 3.4 GB |
| Pixel Fold, with its snapshot | 4.7 to 4.9 GB |
| Pixel Tablet, with its snapshot | 4.7 to 5.1 GB |

That is about 18 GB more than the Linux template
([063 results](../../docs/decisions/063-results.md#e24-disk)). Each device's
AVD has a hardware keyboard (`hw.keyboard = yes`) and 4 cores, and asks for
2 GiB of memory. The emulator raises that to 2.5 GiB for the Pixel 8 and
4 GiB for the Pixel Fold and the Pixel Tablet, and each snapshot holds it.
Before its snapshot is saved, each device has:

- stylus handwriting off, so Gboard's "Try out your stylus" sheet does not
  take the typing
- the system spell checker off
- auto-rotate on, which rotation by the emulator needs
- the screen always on, with no lock screen
- an empty clipboard, and logcat cleared

Keys from a hardware keyboard reach apps as typed: "Hello idb 123", "teh",
"adn" and a double space arrived unchanged, with no capital added, so the
template leaves Gboard's own settings as they are.

The emulator is started by `bb-box-emulator`, with no window, its gRPC on
port 8554, and a token made new at each start, which the emulator writes to
its discovery file under `/run/user/<uid>/avd/running/`. With a token, the
pinned emulator listens for gRPC on loopback only. Its console, adb and
adb's server listen on loopback too.

## A box from the template

bb-box delivers its device server to each android box, as a service of the
box user's, `bb-box-device.service`. The server starts the emulator in a
service of its own, `bb-box-emulator@<avd>.service`, so a restart of the
server leaves the device running, and reattaches to it. The service checks
the device's firewall before each start. Stopping it saves the device's
snapshot, as `adb emu kill` does, so a switch of model, a stop of the box
and a restart keep each device's apps and data. If the emulator ends
without saving, as when it crashes or the VM does, the next start boots
the device cold, in about 15 s, as its snapshot would lose what was written
since it was saved.

The server reads the screen from the emulator's gRPC, by shared memory in
`~/.bb-box/device/frames`, and encodes it with `bb-box-h264`. Its log is
`~/.bb-box/device/server.log`, and the emulator's
`~/.bb-box/device/emulator.log`.

## The device's firewall

`bb-box-device-firewall.service` loads a table of bb-box's own, `inet
bb_box_device`, at each boot, before the network. Its input hook, at
priority -300, accepts loopback and drops TCP ports 5037, 5554 to 5585 and
8554 on every other interface, over IPv4 and IPv6. Docker and Tailscale
write their own tables, never this one. `bb-box-emulator` checks the table
before each start, and refuses to start the device without it. To check it
by hand:

```sh
bb-box-device-firewall check && echo in place
```

## Update

bb-box refreshes each Android template monthly, in the nightly run of `bb
box images refresh`. In a box cloned from the template it runs the Linux
template's guest scripts, then `customize-android.sh`, which installs any
SDK part whose pin changed and makes each device's AVD and snapshot again.
The trial box runs `bb-box-check-android`, and the new template takes the
old one's place only if every check passes. The old one stays as a
rollback, as for the other templates. To refresh one now, or to try a
refresh:

```sh
bb box images build proxmox-qemu/9108
bb box images build proxmox-qemu/9108 --try
```

The pins move with bb-box's releases. To change one, change its URL,
SHA-1 and SHA-256 in [`pins.json`](pins.json): the SHA-1 is the one Google's
repository manifest lists, and the SHA-256 is of the file it names.

## When it goes wrong

- **The build says the licence is not accepted:** run step 1.
- **The build says KVM does not work in the build VM:** the host does not
  allow nested virtualization. Turn it on for the host's CPU (`kvm_amd` or
  `kvm_intel`, `nested=1`), then build again.
- **A device does not boot from its snapshot in a box:** the snapshot is tied
  to the emulator and may be to the host's CPU. The image record names both
  for each device. Refresh the template on the host its boxes run on.
- **An android box's device does not boot:** `box_status` gives the
  device's state in words. In the box, `~/.bb-box/device/server.log` and
  `~/.bb-box/device/emulator.log` have the rest.
- **Anything else:** build again with `--keep`, and look in the build VM.
  `~/.bb-box/device/emulator/emulator.log` has the last emulator's output.
