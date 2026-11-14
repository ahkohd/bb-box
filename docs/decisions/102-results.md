# 102 results: the agent's pointer on Linux desktops

Measured on 14 November 2026 on a linux-desktop-cpu box on Proxmox QEMU, Ubuntu 24.04.5, Xfce on Xtigervnc 1.16.2, with Cua Driver 0.28.3.

## Why Cua Driver's own cursor stays off

| Cua Driver | Xfce's compositor | Cua Driver's image of a window | Its image of the desktop |
| --- | --- | --- | --- |
| 0.28.3, overlay on | off, as in the images | a black shape where the cursor is | the cursor |
| 0.30.4, overlay on | off | a black shape where the cursor is | not read |
| 0.30.4, overlay on | on | clean | the cursor and its session badge |

## Where the agent's click lands

| Screen | Click | Where Cua clicked, in X's pixels | What BB Box noted |
| --- | --- | --- | --- |
| 1920 by 1080, scale 1 | Edit menu, by reference | Edit is 675 to 716 across, 116 to 141 down | 696, 129 by the first form; nothing now |
| 1920 by 1080, scale 1 | the text, by pixels | 1024, 432 | 1024, 432 |
| 2880 by 1800, scale 2 | Edit menu, by reference | Edit is 714 to 796 across, 116 to 166 down, twice its frame | 755, 141 by the first form; nothing now |
| 2880 by 1800, scale 2 | the text, by pixels | 1409, 720 | 1409, 720 |

At scale 2, Cua Driver gave Mousepad's Search menu the frame 398, 58, 60 by 25, and a click by pixels on it landed at 856, 140 in X's pixels, twice the frame. The first form of this decision doubled such frames when they lay outside their window and fitted it doubled. An independent review showed that test fails both ways: see the next section.

## Frames at scale 2 have no single space

On a second box, with the screen at 3840 by 2160:

| App | Its window, in X's pixels | An element's frame from Cua Driver | Where it is, in X's pixels |
| --- | --- | --- | --- |
| GTK 3 test window, at scale 2 | 4, 82, 1400 by 1000 | button 302, 241, 180 by 60 | 604, 482, 360 by 120 |
| Mousepad, at scale 2 | 1280, 639, 1280 by 960 | File menu 640, 319, 39 by 25 | twice the frame |
| Chrome 157, at scale 2 | 20, 74, 1890 by 2066 | its window's frame 10, 37, 945 by 1033 | twice the frame |
| Chrome 157, at scale 2 | the same | a page's button 646, 685, 360 by 120 | the frame as given |

Cua Driver's `get_screen_size` said a scale of 1.0, and its `window_bounds` were in X's pixels. For GTK apps it lists no frame for the window itself. The GTK button's frame lies inside its window read either way.

## The second form: a check of the desktop's scale

The second form read in the box whether the desktop was scaled, and placed an action by reference only where it was not. With the same GTK test window, a button at 300, 200 and 180 by 60 in its own points, it gave:

| Scale | Click | The button's centre, in X's pixels | What BB Box noted |
| --- | --- | --- | --- |
| 2 | by reference | 784, 542 | nothing: the check said scaled |
| 2 | by pixels | 784, 542 | 784, 541 |
| 1 | by reference | 394, 312 | 394, 312 |
| 1 | by pixels | 394, 312 | 394, 311 |

## The pointer over the picture

A page with noVNC 1.7.0, in headless Chrome at 960 by 600, showed the box's screen over VNC, with this decision's pointer drawn from the event BB Box's own computer code gave for each click, driving the real Cua Driver. In each frame 0.2 to 0.3 s after a click, the pointer and its ring were on the place clicked, at both screen sizes. The relay from the plugin to the panel was not part of this run: the plugin's tests check it.

A second review found the check cannot be trusted:

- A GTK app started with its own `GDK_SCALE=2` on an unscaled desktop read as unscaled. A click by reference was noted at 404, 268 for a button whose centre was 808, 536.
- A failed `xfconf-query` or `swaymsg`, as with no session bus, read as unscaled.
- A check still running as the box restarted could show the old click after the restart.
- A stalled check held the tool for 10.77 s.

## The decision as it stands

No check: on Linux an action by reference has no place. Through the plugin's tests:

| Case | Second form | Now |
| --- | --- | --- |
| Click by reference at scale 1, on an element partly above its window | 220, 110 | nothing |
| Click by reference at scale 2 | nothing | nothing |
| Click by pixels | where Cua clicked | where Cua clicked |
| Click by reference while reading a setting takes 5 s | 5019 ms | under 3 s, nothing read |
| An action begun before a stop and start, noted after | shown, and kept for a later viewer | neither |
