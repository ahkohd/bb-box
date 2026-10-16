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

While you have control, most desktops change size to fit your tab, and the toolbar says so. A macOS desktop on a Mac keeps its own size. When you hand back, the desktop goes back to the size the agent had.

## Your keyboard

On a Mac, Cmd works as Ctrl in a Linux or Windows box. So Cmd+C copies, Cmd+V pastes, and Cmd+A, Cmd+Z, Cmd+F and Cmd+S do what Ctrl would. In a macOS box, Cmd stays Cmd.

## Copying and pasting

Copying and pasting between your computer and the box works while you have control. After you paste, or select Copy to this computer, the toolbar says 'Pasted' or 'Copied' for a few seconds.

To paste text from your computer into the box, click where it should go and press Cmd+V on a Mac, or Ctrl+V elsewhere. You can also select **Paste from this computer** in the toolbar's menu. If your browser does not let BB Box read your clipboard, a field opens: paste your text there and select **Paste into the box**.

When you copy text in the box, it comes to your computer's clipboard. You can also select **Copy to this computer** in the menu. If your browser does not let BB Box write to your clipboard, a field shows the text so you can copy it yourself.

On Linux the text moves at once. On a macOS desktop on a Mac, and on Windows, BB Box moves it with commands in the box, so it can take a moment. On Windows it takes a few seconds, and up to about 8 seconds on Windows on a Mac.

If nothing has come from the box, the menu's Copy says why: take control first, or copy something in the box first.

## The pointer

Without control, your own pointer shows over the desktop. With control, the pointer takes the box's shape. If the box hides its pointer, yours shows instead, so it never disappears.

## Video

A Linux desktop can also show as video, which follows a dragged window far more closely than the usual stream (VNC), and stays smooth on a slow connection where VNC falls to a few frames a second. It is on unless **Linux desktops as video** is off in [settings](settings.md#general), and works only for X11 desktops drawn by the CPU. Other desktops show as before.

Such a desktop opens as video. To see it over VNC instead, select **Show as VNC** in the toolbar's menu; it is ticked while the desktop shows over VNC. Your choice lasts for that box in that tab; select it again to go back to video.

If the video cannot start, the desktop shows over VNC, and the toolbar says 'Video did not start, so this shows VNC.' Point at the note to see why: for example, the box was made before video came, or your browser cannot decode video, which needs a secure connection to BB.

Everything else works the same with video: taking control, copying and pasting, your keyboard, the pointer and the desktop's size. Copying and pasting carry images too, both ways: paste an image into the box, or copy one there and it comes to your computer. If your browser does not let BB Box write an image to your clipboard, the image shows so you can right-click it and copy it.

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
