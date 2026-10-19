# Desktops

A desktop box has a screen you can watch while an agent works, and use yourself when you take control. Only one of you, you or the agent, sends input to it at a time.

## Opening a desktop

You can open a box's desktop from:

- the Box panel: select **Open desktop** on the box's row, which opens a tab named after the box in the thread's right panel
- the thread's Desktop tab: it opens the thread's desktop straight away, lists them when there are several, or offers the Box panel when there is none
- a browser tab of its own: select **Open in browser** in the box's menu
- the Boxes page: the desktop shows on the page, with a back arrow to the list

The thread's Desktop tab counts the machine the thread runs on, if it is a desktop.

![A desktop box in the thread's right panel](../media/desktop-box.png)

When you switch to another tab and back, the desktop is still there, with no wait. A desktop you have not looked at for 10 minutes disconnects, and connects again when you come back.

## Taking and handing back control

At first the agent has control. You see the screen, but your keyboard and mouse do nothing there. The toolbar says 'The agent has control.'

To use the desktop yourself, select **Take control**. The toolbar says 'You have control.', and a coloured ring around the screen shows which tab sends input. Anyone else watching sees 'Another viewer has control.' While you have control, agents leave the desktop alone.

![A desktop's toolbar and menu, while this tab has control](../design/mockups/built/desktop-menu-light.png)

To give it back, select **Hand back to the agent**. The agent also gets control back when your tab has been closed or hidden for a minute. It does the same when your tab loses its connection and does not connect again soon.

If you ask an agent to carry on while you have control, it can take control back. The toolbar then says 'The agent took control.', and **Take control again** gives it back to you.

### The desktop's size

Taking control does not change what you see: the desktop keeps its size. While you have control, resizing your tab or window resizes most desktops to fit it. On video, the last picture stretches to fill the new space until the desktop has its new size, so you see one change. A macOS desktop on a Mac keeps its own size. When you hand back after resizing, the desktop goes back to the size the agent had.

## Your keyboard

On a Mac, Cmd works as Ctrl in a Linux or Windows box. So Cmd+C copies, Cmd+V pastes, and Cmd+A, Cmd+Z, Cmd+F and Cmd+S do what Ctrl would. In a macOS box, Cmd stays Cmd. The left Option types accents and symbols as on your Mac, so Option+E then E gives é, and with an arrow, Tab or a function key it works as Alt; the right Option is always Alt, for an app's Alt+letter menu keys.

Accented letters and other characters reach the box as your keyboard types them, such as é, ß or ж, whatever your keyboard's layout. Shortcuts go by the key you press, as on the box's own keyboard.

## Copying and pasting

Copying and pasting between your computer and the box works while you have control. After you paste, or select Copy to this computer, a BB notification says 'Pasted' or 'Copied' for a few seconds. Notes like these come as notifications, not in the toolbar, and you can close one early.

To paste text from your computer into the box, click where it should go and press Cmd+V on a Mac, or Ctrl+V elsewhere. You can also select **Paste from this computer** in the toolbar's menu. If your browser does not let BB Box read your clipboard, a field opens: paste your text there and select **Paste into the box**.

When you copy text in the box, it comes to your computer's clipboard. You can also select **Copy to this computer** in the menu. If your browser does not let BB Box write to your clipboard, a field shows the text so you can copy it yourself.

On Linux, and on any desktop shown as video, the text moves at once. Over VNC on a macOS desktop on a Mac, and on Windows, BB Box moves it with commands in the box, so it can take a moment: on Windows a few seconds, and up to about 8 seconds on Windows on a Mac.

If nothing has come from the box, the menu's Copy says why: take control first, or copy something in the box first.

## The pointer

Without control, your own pointer shows over the desktop. With control, the pointer takes the box's shape. If the box hides its pointer, yours shows instead, so it never disappears.

## Video

A Linux desktop can also show as video, which follows a dragged window far more closely than the usual stream (VNC), and stays smooth on a slow connection where VNC falls to a few frames a second. It is on unless **Linux desktops as video** is off in [settings](settings.md#general), and works for Linux desktops drawn by the CPU, X11 and Wayland, and, by choice, on a GPU desktop. Other desktops show as before.

Such a desktop opens as video, on arm64 under microsandbox too. To see it over VNC instead, select **Show as VNC** under **Display** in the toolbar's menu; it is ticked while the desktop shows over VNC. Your choice lasts for that box in that tab; select it again to go back to video. A Linux desktop on a Tart Mac opens over VNC instead, with **Show as VNC** ticked; select it to see the desktop as video.

A macOS desktop on a Mac of the SSH host pool opens as video. One on a Tart Mac opens over VNC instead, as VNC is already smooth there, with **Show as VNC** ticked. Select it to see the desktop as video, which uses much less bandwidth, though a key shows a little later. Your choice lasts in the same way. The Tart backend's **Video by default for macOS desktops** setting makes such desktops open as video.

A Linux desktop on a GPU opens over VNC, with **Show as VNC** ticked. Select it to see the desktop as video, encoded on the box's GPU (NVENC). This needs a GPU box made from a recent image; an older one shows over VNC only.

A Windows desktop on a Mac opens as video, as one on Proxmox does. The Mac makes the video from QEMU's own picture of the desktop, rather than Windows capturing it: it keeps up with VNC on a fast connection, is ahead of it on a slow one, never tears, and uses a fifteenth of the bandwidth. People watching see the agent's pointer, over video and over VNC. This needs a box made from a recent image, and Xcode's Command Line Tools on the Mac; `bb box doctor` says when a Mac lacks them.

A Linux desktop on Wayland, which runs Ubuntu 26.04, also opens as video, which follows a drag more closely than VNC, does not tear while you scroll, and uses about a sixth of the bandwidth, though a key on its own shows a little later. This needs a Wayland box made from a recent image; an older one shows over VNC. High resolution is not offered on Wayland.

If the video cannot start, the desktop shows over VNC, and a notification says 'Video did not start, so this shows VNC.', with why under it: for example, the box was made before video came, or your browser cannot decode video, which needs a secure connection to BB.

Everything else works the same with video: taking control, copying and pasting, your keyboard, the pointer and the desktop's size. Copying and pasting carry images too, both ways: paste an image into the box, or copy one there and it comes to your computer. If your browser does not let BB Box write an image to your clipboard, the image shows so you can right-click it and copy it. On Windows, a pasted image reaches the box's clipboard as the very file you pasted, not compressed again, which browsers and Office paste, and as a picture for apps that take only that; this needs a box made from a recent image. On a Mac it is the same; this needs a Tart Mac made from a recent image, or a pool Mac whose owner has run setup-mac.sh again since.

### The pointer over video

Video shows the box's pointer as the agent moves it, so you can see where it points while you watch. While you hold control, the video leaves the box's pointer out: your own pointer shows instead, with the box's shape (an arrow, a text cursor, a hand), so it never trails behind your hand. One picture serves everyone watching a box, so while one person holds control, others watching see no pointer in the video either.

On Windows, this needs a box made from a recent image, which keeps the pointer apart from the picture. On a box from an older image, Windows draws the pointer into the picture, so the video always shows it: while you hold control, you see your own pointer and, a little behind it, the box's.

Over VNC, a Windows box shows no pointer in the picture until a mouse has moved in it, its own or yours; from then on the picture shows where the box's pointer is. While you hold control and watch over VNC, Windows' pointer is hidden, so only your own pointer shows, as a plain arrow, not the box's trailing behind it; it comes back when you hand control back or stop watching over VNC. To see the agent's pointer from the start, use video, which Windows desktops on Proxmox show by default.

On a Linux desktop on Wayland made from a recent image, video and VNC both show the box's pointer as the agent moves it, in its own shape. While you hold control, your own pointer takes the box's shape, and other people watching see where you point.

On a Wayland box made from an older image, the box draws its pointer into the picture, which shows it as the agent moves it. While you hold control, the box leaves it out, so it does not trail behind your own, and your own pointer is then a plain arrow, whatever the box's shape. On a box from an older image still, you see your own pointer and, a little behind it, the box's.

## High resolution

On a high-resolution screen, such as a Mac's, a desktop's text can look soft: each of its pixels is stretched over several of yours. In the toolbar's menu, under **Display**, select **High resolution** to give the desktop twice the pixels, with everything on it drawn twice the size, so it looks the same size but its text is sharp. Point at its info icon to see what it costs. It is ticked while it is on, and stays on for that box until you turn it off, even after the box starts again. While it switches on or off, video keeps the last picture until the desktop has its new size and scale, then shows the new one, so you see one change; anyone else watching sees the same.

On a Linux desktop drawn by the CPU, High resolution takes about three times the processor while someone watches the desktop, and the box's apps draw four times the pixels, so scrolling in a browser costs more too. It works best on boxes with 8 cores or more.

On a Windows desktop on Proxmox shown as video, High resolution sets the screen to twice the pixels, such as 2560x1600, at 200% scaling, so everything keeps its size. The video then shows about half as many frames a second, and a key takes about 85 ms to show. More cores do not help, as copying the screen is the limit, so turn it on for what needs sharp text and off again after.

Other desktops do not have it. While it is on, resizing your tab in control keeps the desktop's pixels doubled; over VNC, the desktop keeps its size. While anyone watches it in a browser that cannot show larger video, as Safari, the desktop is no larger than 3840x2304 pixels, or the same area in another shape, the largest such a browser shows at 60 frames a second: in a larger tab, it has a little less than twice the pixels. While everyone watching can show more, as Chrome can, it has the full twice, up to 7680x4320. When such a viewer comes or goes, the desktop changes size, and everyone watching keeps the last picture until it has. If your browser still cannot show the video, the desktop shows over VNC, and a notification says why.

Video also keeps coloured text sharp: when every browser watching a desktop can decode full colour, as Chrome can, the video carries it, for a little more processor and no more bandwidth.

## When the desktop is not showing

The screen tells you why, and what you can do. It uses the box's name, here calm-otter:

| What it says | What to do |
| --- | --- |
| Connecting to the desktop… | wait a moment |
| The connection to the desktop ended. Trying again in 4 s | wait, or select **Reconnect now** |
| calm-otter is stopped. | select **Start**, where the box can start again |
| calm-otter is starting… | wait: the desktop shows once the box is ready |
| This box has been released. | close the tab |

After a lost connection, the viewer tries again by itself, waiting a little longer each time, up to 15 seconds. **Reconnect** in the toolbar or its menu tries at once.

## Agents and the desktop

Agents see and use a desktop through computer tools, such as taking a screenshot, clicking and typing. See [agent tools](../reference/tools.md).

An agent can record a Linux, macOS or Windows desktop with `box_record` and show you the clip in the thread, rather than describe what it did. Still stretches are cut, so a long session makes a short clip. A recording runs for at most 5 minutes. While it records, it uses about a tenth of a core on an X11 or Windows desktop, a quarter on macOS, and two thirds on Wayland.
