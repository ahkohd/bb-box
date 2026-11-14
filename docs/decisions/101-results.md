# 101 results: the agent's pointer on Linux desktops

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
| 1920 by 1080, scale 1 | Edit menu, by reference | Edit is 675 to 716 across, 116 to 141 down | 696, 129, its centre |
| 1920 by 1080, scale 1 | the text, by pixels | 1024, 432 | 1024, 432 |
| 2880 by 1800, scale 2 | Edit menu, by reference | Edit is 714 to 796 across, 116 to 166 down, twice its frame | 755, 141, its centre |
| 2880 by 1800, scale 2 | the text, by pixels | 1409, 720 | 1409, 720 |

At scale 2, Cua Driver gave Mousepad's Search menu the frame 398, 58, 60 by 25, and a click by pixels on it landed at 856, 140 in X's pixels, twice the frame.

## The pointer over the picture

A page with noVNC 1.7.0, in headless Chrome at 960 by 600, showed the box's screen over VNC, with this decision's pointer drawn from the event BB Box's own computer code gave for each click, driving the real Cua Driver. In each frame 0.2 to 0.3 s after a click, the pointer and its ring were on the place clicked, at both screen sizes. The relay from the plugin to the panel was not part of this run: the plugin's tests check it.
