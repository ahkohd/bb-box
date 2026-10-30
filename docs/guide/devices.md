# Device boxes

A device box gives a thread a phone or tablet to install, run and test apps on. An `ios` box has an iPhone or iPad in the iOS Simulator. An `android` box has a Pixel phone, foldable or tablet in the Android emulator. You and the thread's agent share the device's screen, as you share a desktop.

An `ios` box's commands run on its macOS host, which has Xcode. An `android` box's commands run on its Linux VM, as the box user with sudo, with the Android SDK in `/opt/android-sdk`.

## Where device boxes come from

| Backend | Device boxes | What it needs |
| --- | --- | --- |
| [Tart](../../setup/tart/README.md#ios) | `ios`, as a VM of its own or a slot on a shared iOS host | a Mac with Apple silicon, and the iOS image that `prepare-ios-image.sh` makes, set as the backend's `ios-image` |
| [SSH host pool](../../setup/ssh-pool/README.md#ios-slots-on-a-mac) | `ios`, as a slot on a pool Mac | a pool Mac with Xcode and an iOS runtime, whose line lists `ios` |
| [Namespace](namespace.md#ios-boxes-on-a-shared-namespace-host) | `ios`, as a slot on a Namespace Mac | **Shared iOS hosts** on, and a Namespace Mac that BB Box has measured to run the iOS Simulator |
| [Proxmox QEMU](../../setup/android/README.md) | `android` | KVM in its VMs, so `linux-kvm` is on, and the Android template, which you build once you accept the Android SDK's licence |
| [boat.dev](boat.md#android-boxes) | `android` | the Android SDK's licence accepted in BB Box's settings, and the **Android emulator** kind on |

An `ios` box that can share a host goes to a ready slot on a pool Mac first, then to a shared host on Tart, and to Namespace last, as its Macs cost by the minute. The devices each image offers are in [kinds and sizes](../reference/kinds.md#devices).

## Shared, or a VM of its own

Where a shared iOS host is set up, an `ios` box is shared by default:

- **Shared**: a macOS user of its own on a Mac or VM that other `ios` boxes share, with its own device, files and keychain. It is ready in seconds. It has no sudo, no Homebrew installs, no desktop and no app windows. Other `ios` boxes on the host share its cores and see its processes, and it uses its own ports, from `BB_PORT_BASE`. It has no size of its own, and cannot be stopped and started.
- **A VM of its own**: a macOS VM on a Tart Mac, with sudo, Homebrew, its own cores and ports, and a desktop beside the device. It takes one of the Mac's two VMs, so it can wait for one.

Where no shared host has room, an `ios` box gets a VM of its own. In the New box form, choose **iOS device** for its system, then under Machine, **Shared** or **A VM of its own**. An agent asks for one with `dedicated: true` or `shared: true` on `box_acquire`, and from a terminal `bb box acquire ios` takes `--dedicated` or `--shared`. A size needs `dedicated`: where a shared iOS host is set up, a size without it is refused. A box that asks for another device than the first, or for the simulator with every service (`slim: false`, or `--no-slim`), gets a VM of its own. With `shared`, a box that cannot have a slot is refused rather than given a VM.

An `ios` box's simulator is slimmed unless it asks otherwise: it runs without services a device box does not need, such as widgets, Siri, iCloud, Health and Wallet, in about a quarter of the memory. Ask for the full simulator for an app that uses one of them.

## Choosing a device

Each kind's first device is its default: the iPhone 18 Pro for `ios`, and the Pixel 8 for `android`. On Namespace, an `ios` box has the first of them that the Mac's Xcode has. To choose another, use the **Device** menu in the New box form, `device` on `box_acquire`, or `--device` on `bb box acquire`, such as `--device "Pixel Fold"`. The devices on offer, with their screens, are in [kinds and sizes](../reference/kinds.md#devices).

To switch a box to another device later, use the device picker in its toolbar, described under [the device's controls](#the-devices-controls), or the agent's `box_device`. Each device keeps its own apps and data.

## Opening the device

A device has a tab of its own in the thread's right panel, named for what it shows: **Simulator** for an `ios` box's device, **Emulator** for an `android` box's, with a phone for its icon. Open it with **Open simulator** or **Open emulator** on the box's row, or from the thread's **Device** tab, which opens the thread's device straight away, lists them when there are several, or offers the Box panel when there is none. When the thread has another box whose tab would have the same name, the name says which box, as in 'Simulator · box-2', or on a narrow screen the box's name alone, beside the phone.

The Monitor's machine status opens a box's device on the Boxes page: when it shows the box, select **Open** beside its name, then **Open simulator** or **Open emulator**.

A box with both a device and a desktop, such as a dedicated `ios` box, has two tabs: **Simulator** and **Desktop**. Each tab's toolbar has a button that opens the other. A shared `ios` box has no desktop, so it has only **Simulator**. The thread's Desktop tab, opened from the panel's launcher, shows a box's desktop if it has one; for a box with only a device, it shows the device and renames itself **Simulator** or **Emulator**. On the Boxes page and in a browser tab of its own, the same button switches the box's view between the two. Each keeps its own connection while you look at the other, so switching is instant.

Take control to use the device, as with a desktop: one control covers the device and the box's desktop. The device's own controls are in a bar beside it, described under [The device's controls](#the-devices-controls). Commands work too: `xcrun simctl` in the box's terminal takes `booted` as the device, and `adb` reaches an Android device as `emulator-5554`.

The display you see is the only one that gets your keys, your pointer and your clipboard. Control is one for the box, covering both: switching between them keeps it, and does not start the minute after which a hidden tab hands control back.

On an `ios` box, the Desktop tab is the macOS host's, for Xcode. It says above it: 'Do not open Device Hub here. It takes the device's clipboard, so pasting stops working, and bb-box closes it. The device is in the Simulator tab.' Xcode's Run opens Device Hub even so. bb-box closes it within 5 seconds, by stopping its process: quitting it would shut the device down. `bb box doctor` says whether Device Hub runs on each `ios` box, and how often bb-box has closed it.

## How the device shows

A device always shows as video. It has no VNC, no **Show as VNC** and no High resolution, and it ignores the **Linux desktops as video** setting. Resizing the panel does not resize the device.

The device shows in a frame drawn by bb-box: a phone or tablet in its body, with its side buttons and, on an iPhone, its Dynamic Island. The body is graphite in both of BB's themes, with a light edge in the dark theme and a soft shadow in the light one. The device, its frame and its bar of controls fit the panel, and the screen is never drawn larger than its own pixels on your display. In the bar's **More** menu, two choices change how it shows, and last for that box in that browser:

- **Show frame**, on at first: off, the screen shows alone, with its own corners and island.
- **Pixel for pixel**: each of the device's pixels is one of your display's, and the panel scrolls.

When the device turns, the frame turns with it in a third of a second, its last picture turning too, as a phone held sideways does, and the new picture shows once the device has drawn it. If that takes longer, as it can while iOS turns its own layout, the old picture waits under a faint veil. A phone held sideways whose app stays upright, as the iPhone's Home Screen does, shows its picture on its side, as the phone would. With reduced motion set on your computer, the frame turns at once.

While the device starts, its screen is black, with its name and 'Booting'. A device that is asleep shows its last picture dimmed, with 'Asleep' and **Wake**, and one that failed shows why, with **Reboot device**. Either button takes control if you do not have it.

Where your browser cannot play the device's video, as where it has no WebCodecs, the device shows a picture of its screen a few times a second instead, over the same connection, and says so above it: 'This browser cannot play the device's video, so it shows a picture a few times a second.' Where the video does not start within 3 seconds, as on a busy Mac, it shows pictures the same way, says 'The device's video did not show within 3 s, so this shows a picture a few times a second and tries the video again shortly.', and tries the video again after 10 seconds, then after longer waits up to a minute, until a frame shows. It never shows the box's desktop in its place, so a click never lands on the wrong screen. While it waits for its first picture, it shows the device's name and 'Connecting', or 'Booting' while the device starts.

While nobody watches a device, it sends no video at all: its video starts when a panel shows it, a recording runs, or the agent waits for the screen to settle, and stops 10 seconds after the last of them.

## The device's controls

A narrow bar beside the device holds the controls you use most when testing an app. A control the device does not have is not shown: an iPhone has no **Back**, and only a foldable has **Fold**.

| Control | What it does |
| --- | --- |
| **Home** | goes to the Home Screen |
| **Back**, **Recent apps** | Android only: goes back, or shows the recent apps |
| **Rotate left**, **Rotate right** | turns the device a quarter turn the way the arrow points |
| **Fold** | foldables only: closed, half open or open |
| **Dark appearance** | turns dark mode on or off. Its icon shows which is on: a moon for dark, a sun for light. On a shared ios box the device reboots to show the change, in about 7 to 10 seconds, and apps that were open close |
| **Text size** | a slider of the platform's own steps, such as iOS's content sizes, with smaller, larger and **Default**. On a shared ios box the device reboots to show the change, as for **Dark appearance** |
| **Copy screenshot** | copies the device's own pixels to your computer's clipboard as a PNG, or downloads it where your browser will not let bb-box copy a picture |
| **More** | **Lock** or **Wake**; **Open link…**, which opens a web address in the device's browser or an app's own link, such as `myapp://settings`, in that app; **Location**, a few cities or your own latitude and longitude; **Clean status bar**, which shows 9:41, full signal and a full battery for screenshots, or on Android the battery as **Battery** set it; **Battery**; **Network** on Android: **Online**, **Offline** (airplane mode) or **Slow** (474 kbit/s each way, 100 ms later out); **Show frame** and **Pixel for pixel**; and **Reboot device**, which keeps apps and data |

Using a control takes control from the agent, as **Take control** does, and the toolbar says 'You have control. Hand back when done.' **Copy screenshot** does not take control: it sends the device nothing. On a touch screen the bar says 'Using a control takes control from the agent.' once, under it, until you first use one. While the device boots or switches, the controls wait, and say why.

Controls the device shows for itself, such as Home or a turn, say nothing more. Those that change what you cannot see, such as the location or the battery, say what they did in a note. If the device refuses a control, as when another is still under way, the note says why.

In a panel narrower than 480 pixels, or where the device's screen beside the bar would be narrower than 280 pixels and the row leaves it wider, the bar goes below the device as one row: **Home**, **Back** and **Recent apps** on Android, **Rotate left**, **Fold** on a foldable, and **More**, which holds the rest.

On a shared ios box, iOS shows a change made in the device's own Settings app, such as Dark or Bold Text, only at the device's start: the setting takes, but the screen keeps the old look until **Reboot device**. A dedicated ios box shows such a change at once. The reason is in [063's results](../decisions/063-results.md#f-20-settings-taps-the-front-app-and-web-pages).

The bar is one stop for the Tab key: the arrow keys move along it, and Enter or Space uses a control. Menus and the text size slider close with Escape. A screen reader hears each control's name and whether **Dark appearance** is on, and what changed on the device, such as 'Turned left. Dark appearance.'

**The device picker**, the device's name in the toolbar, lists the box's devices and switches to another. Each device keeps its own apps and data, so install your app again on the one you switch to. A device not started in this box before says it may take a minute: about 9 to 12 seconds to boot an iPhone or iPad from the image cold, and a minute or more the first time a device is booted at all. One started before takes about 8 seconds.

While a person has control, the agent's `box_device` is refused but for installing an app the device does not have, so it cannot press Home or turn the device while you test.

## Touch, keys and the clipboard

With control, the device takes your pointer, keys and text:

| You | The device gets |
| --- | --- |
| Click, or drag | a touch where you click, which follows the pointer until you let go |
| Right-click | a long press, held for 1.2 seconds |
| Alt and drag (Option on a Mac) | a pinch: two fingers mirrored about the screen's centre. Alt itself never reaches the device |
| Scroll with a wheel or trackpad | a swipe from the pointer, a twelfth of the screen for each notch, held still before it lifts so the list does not fling |
| Two fingers on a touch screen | two touches |
| Keys | the same keys, by name. Cmd is Command, Option is Option |
| A letter with an accent, from your keyboard or a dead key | on iOS, typed as Option keys, as a Mac's keyboard types it; on Android, pasted, as Android's keyboard has no key for it |
| Japanese, Chinese or Korean from your input method, an emoji, or Arabic, Cyrillic and other letters with no Option key | pasted, as one paste for each word your input method commits, or for letters you type within half a second of each other |
| Cmd+V (Ctrl+V off a Mac) | your computer's clipboard, pasted into the device |
| **Type text** | the whole text: as keys when every letter has a key, otherwise as one paste |

When bb-box pastes for you or the agent, it puts the device's own clipboard back afterwards, your Cmd+V and **Paste from this computer** too. BB Box reads your clipboard only when you paste, as text, never when you take control, so a paste from the device's own menu uses the device's own clipboard. If your browser does not let BB Box read your clipboard, a field opens: paste your text there and select **Paste into the device**.

On iOS, each paste shows 'pasted from CoreSimulatorBridge' at the top of the screen for about 2.5 seconds, and the device takes no keys while it shows, so bb-box holds your keys until it goes. Touches are not held. iOS also adds a space before pasted text that follows a word or a punctuation mark directly, as it does on a phone; type long or mixed text with **Type text**, which pastes it in one piece.

On Android a paste adds no space and holds no keys. Android may say for a moment that an app pasted from the clipboard. bb-box pastes into the focused text field through Android's accessibility paste, which Chrome's pages take, and presses the Paste key only where no text field has the focus. A page sees a Shift key pressed and let go just before each paste: bb-box sends it to know that the keys typed before the paste have landed. Ctrl+V or the Paste key sent as keys, such as an agent's `computer_type` of `ctrl+v`, pastes nothing in Chrome on the device: send the text itself instead.

While someone watches without control, each touch, the agent's or the person's with control, shows as a circle where it lands.

Control changes hands cleanly. When you take control, the agent's input stops at once: a swipe under way ends where it is, and a paste whose paste key has not gone is dropped, with the device's clipboard put back. When you hand back, or your connection ends, or bb-box reloads, every touch and key you held is let go. Turning or switching the device ends a touch under way, and a touch that starts before the new picture comes is not sent.

## Agents and the device

On a box with a device, the agent's computer tools drive the device and never the box's desktop. The agent reads the device's screen as a list of its elements, taps, swipes, types, and opens apps and links. While you have control, the agent can still read the screen and take screenshots, but every touch, key and launch of its own is refused, so it cannot change what you are testing.

On a device, a click is a tap, a right-click a long press, a scroll a swipe, and a drag drags, as across a slider. The agent's `box_device` tool uses the device's controls, as the bar does: Home, Back and Recents, lock and wake, turning, folding, appearance, text size, location, the status bar, battery, network, installing an app, switching device and rebooting. See [agent tools](../reference/tools.md#box_device).

## Recording a device

An agent records a device box as it records a desktop, with `box_record`. The clip shows the device in its frame, with each touch and the captions around it. See [recording a device](recording.md#recording-a-device).

## The Mac's video encoder

An `ios` box sends its device's video at the size your panel draws it, not at the device's own size, as the Mac's video encoder is what limits how many devices can be watched at once. The video comes at a third, a half, two thirds or all of the device's own size, the smallest of those that covers what the panel draws on your display. After you resize the panel, zoom, choose **Show frame** or **Pixel for pixel**, or move the window to a screen of another pixel density, the video changes to the new size within about 2 seconds; until then the picture is a little softer, never smaller. **Pixel for pixel** always gets the full size. When two people watch, the video comes at the size the larger of them draws. Touches land where you make them whatever the video's size, and an agent's screenshots and element references stay good when the panel is resized. An `android` box sends its device's video at full size.

Every `ios` device bb-box streams on one Mac shares that Mac's video encoder, whether it is in a VM of its own or a slot on a shared iOS host. bb-box keeps them within it. When too many are watched at once, it shows some at a lower resolution: first the devices only watched, then those being recorded, and the device a person has control of last. A recording never drops below half size, and a person who has control of a device keeps **Pixel for pixel** at full size. At most two devices on a Mac show at full size at once: the device a person has control of first, then those already at full size. A device whose screen changes takes a full-size place from one whose screen is still once it has waited 10 seconds for one. A panel shown lower says so under its toolbar, naming the boxes that use the encoder: "Shown at a lower resolution: this Mac's video encoder is busy with 3 other devices (box ios-2, box ios-5, box ios-7)." When the encoder is full even so, it says "This Mac's video encoder is full, so frames come more slowly." For about 30 seconds after bb-box starts a VM on that Mac, it says "A VM is starting on this Mac; video may slow for about 30 s." The resolution rises again once there has been room for 10 seconds. box_status and `bb box doctor` say how much of the Mac's encoder is in use. The **encoderLedger** setting turns this off, and then each shared `ios` box's video is capped at two thirds and nothing else is.

bb-box measures what each Mac offers `ios` boxes, rather than assuming it: whether it can run the iOS Simulator, and whether it has a hardware H.264 encoder, a software one, or both. It measures a pool's Mac and a Tart Mac when it first reaches them and then daily, a Tart Mac's iOS image when the image is checked, and each Namespace Mac it starts. box_list says what the Macs behind each offer have, without naming them, such as "its Mac: iOS devices, video by its hardware H.264 encoder", and `bb box doctor` has a check for each Mac, **iOS devices on** the Mac, with when and where it was measured. A Mac measured to have no way to stream a device lends no shared `ios` slot, and the doctor says what to install.

Where a Mac has no hardware H.264 encoder, or its encoder fails, an `ios` device's video is encoded in software by `bb-box-h264`, which reads the device's screen directly: about 45 to 50 frames a second of a busy device at any size, a tap shown in about 65 to 75 ms, for a tenth of a core at a third of the device's size up to about half a core at full size. bb-box counts these streams against the Mac's CPU, a quarter of its cores, rather than its encoder, and shows the passive viewers lower first, in the same order as above: "Shown at a lower resolution: this Mac encodes video on its CPU, busy with 2 other devices (box ios-2, box ios-5)." box_status and `bb box doctor` say how many of those cores are in use. The **iosEncoder** setting, advanced, chooses: `auto`, the default, uses the hardware encoder where the Mac has one; `software` always encodes in software, as to try it on a Mac that has an encoder; `hardware` never does. A box takes it when bb-box next delivers its device server.

**iOS video encoding** and **Share each Mac's encoder fairly**, under Devices in BB Box's settings, are these two settings. See [settings](settings.md#devices).

## Spare boxes

Device kinds keep no spare boxes unless you set a number on the kind's page, as each spare costs disk while it waits with its device booted. See [spares of device boxes](spares.md#spares-of-device-boxes).

## The test device

The test device is a test card that stands in for a phone, to check the device path with no simulator or emulator. With **Test device** on, under Devices in BB Box's settings, `linux`, `linux-desktop-cpu`, `macos` and `macos-desktop` boxes offer it: on Linux in place of an Android phone or tablet, and on macOS in place of an iPhone, under those models' names. It is off by default. See `testDevice` in the [configuration reference](../reference/configuration.md).
