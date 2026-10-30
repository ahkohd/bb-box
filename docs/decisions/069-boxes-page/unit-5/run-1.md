# Live check run-1, 2026-10-30T07:04:44.246Z

Boxes: polite-prairie (bxze4nzjqa5343), desktop; zesty-acorn (bxjsdweqvxio5k), device; thread thr_2v47gs7eic.

## Switch, then back, from every origin of G8

### polite-prairie, desktop
- PASS [G8] polite-prairie: a row's quick Desktop, Terminal, Desktop, then back goes back in history to the list: desktop/from-list, terminal/from-list, desktop/from-list, then /plugins/bb-box/desktop/threads; history 4
- PASS [G8] polite-prairie: a row's quick Desktop and Terminal, then the browser's Back goes to the list, as the switch replaced its entry: /plugins/bb-box/desktop/threads
- PASS [G8] polite-prairie: a row's quick Desktop, Terminal, a reload, then back: the list it names, replacing: /plugins/bb-box/desktop
- PASS [G8] polite-prairie: the page, Desktop, Terminal, Desktop, then back goes back in history to the page: back at /plugins/bb-box/desktop/box/bxze4nzjqa5343
- PASS [G8] polite-prairie: settings, the page, Desktop, Terminal, Desktop, then back: the page, then settings: the page, then settings
- PASS [G8] polite-prairie: the same with a reload after the switch: the page, then settings
- PASS [G8] polite-prairie: a view opened from settings by its link, Terminal, Desktop: its back is still the link to BB Box settings: settings
- PASS [G8] polite-prairie: a view by URL with no origin, Terminal, Desktop, then back replaces with the page: /plugins/bb-box/desktop/box/bxze4nzjqa5343

### zesty-acorn, device
- PASS [G8] zesty-acorn: a row's quick Emulator, Terminal, Emulator, then back goes back in history to the list: device/from-list, terminal/from-list, device/from-list, then /plugins/bb-box/desktop/threads; history 16
- PASS [G8] zesty-acorn: a row's quick Emulator and Terminal, then the browser's Back goes to the list, as the switch replaced its entry: /plugins/bb-box/desktop/threads
- PASS [G8] zesty-acorn: a row's quick Emulator, Terminal, a reload, then back: the list it names, replacing: /plugins/bb-box/desktop
- PASS [G8] zesty-acorn: the page, Emulator, Terminal, Emulator, then back goes back in history to the page: back at /plugins/bb-box/desktop/box/bxjsdweqvxio5k
- PASS [G8] zesty-acorn: settings, the page, Emulator, Terminal, Emulator, then back: the page, then settings: the page, then settings
- PASS [G8] zesty-acorn: the same with a reload after the switch: the page, then settings
- PASS [G8] zesty-acorn: a view opened from settings by its link, Terminal, Emulator: its back is still the link to BB Box settings: settings
- PASS [G8] zesty-acorn: a view by URL with no origin, Terminal, Emulator, then back replaces with the page: /plugins/bb-box/desktop/box/bxjsdweqvxio5k

## Each view works after a switch
- PASS [live] polite-prairie: Desktop shows, Terminal connects after the switch, and Desktop shows again after the switch back: Desktop: "The agent has control."; Terminal connected 436 ms after the click and ran a typed command; Desktop "The agent has control." 419 ms after the click back
- PASS [live] zesty-acorn: Emulator shows, Terminal connects after the switch, and Emulator shows again after the switch back: Emulator: "The agent has control."; Terminal connected 432 ms after the click and ran a typed command; Emulator "The agent has control." 421 ms after the click back

## The bar's numbers against the page's
- PASS [numbers] polite-prairie: the desktop view's bar against the page, under load, the same reading: 7:05:15 AM: bar CPU 57%, memory 20%; page CPU 57%, memory 20%; 7:05:22 AM: bar CPU 61%, memory 20%; page CPU 61%, memory 20%; 7:05:28 AM: bar CPU 58%, memory 20%; page CPU 58%, memory 20%
- PASS [numbers] polite-prairie: the terminal view's bar against the page, under load, the same reading: 7:05:34 AM: bar CPU 51%, memory 18%; page CPU 51%, memory 18%; 7:05:40 AM: bar CPU 50%, memory 18%; page CPU 50%, memory 18%; 7:05:47 AM: bar CPU 50%, memory 18%; page CPU 50%, memory 18%
- PASS [numbers] polite-prairie: the numbers show above 640 px and not below: 641 px shown, 639 px hidden
- PASS [numbers] zesty-acorn: the device view's bar against the page, under load, the same reading: 7:05:55 AM: bar CPU 26%, memory 32%; page CPU 26%, memory 32%; 7:06:01 AM: bar CPU 27%, memory 31%; page CPU 27%, memory 31%; 7:06:07 AM: bar CPU 27%, memory 31%; page CPU 27%, memory 31%
- PASS [numbers] zesty-acorn: the terminal view's bar against the page, under load, the same reading: 7:06:13 AM: bar CPU 26%, memory 31%; page CPU 26%, memory 31%; 7:06:20 AM: bar CPU 26%, memory 31%; page CPU 26%, memory 31%; 7:06:26 AM: bar CPU 29%, memory 32%; page CPU 29%, memory 32%
- PASS [numbers] zesty-acorn: the numbers show above 640 px and not below: 641 px shown, 639 px hidden

## Keyboard only
- PASS [keyboard] polite-prairie: from the row's quick Desktop by Enter, Tab through the bar, Enter on Terminal, then on Desktop, then on the way back: opened with focus on "(page)", 3 Tabs to Terminal; the bar in Tab order: Back to boxes | polite-prairie | Terminal | polite-prairie: CPU 61%, memory 21%. Open polite-p | Take control | Desktop actions; after Enter on Terminal focus on "Terminal input"; Tab and Shift-Tab there stay on "Terminal input", as the shell takes them; Ctrl+Shift+Up moved focus to "Desktop"; after Enter on Desktop focus on "Desktop"; Enter on Back to boxes reached the list
- PASS [keyboard] zesty-acorn: from the row's quick Emulator by Enter, Tab through the bar, Enter on Terminal, then on Emulator, then on the way back: opened with focus on "(page)", 3 Tabs to Terminal; the bar in Tab order: Back to boxes | zesty-acorn | Terminal | zesty-acorn: CPU 29%, memory 32%. Open zesty-acorn | Desktop actions | Home; after Enter on Terminal focus on "Terminal input"; Tab and Shift-Tab there stay on "Terminal input", as the shell takes them; Ctrl+Shift+Up moved focus to "Emulator"; after Enter on Emulator focus on "Emulator"; Enter on Back to boxes reached the list

## The terminal's keys
- PASS [terminal-keys] polite-prairie: Ctrl+Shift+Up moves focus to the bar and sends the shell nothing; Tab, Shift+Tab, arrows with Ctrl or Shift, and Escape reach it: focus on "Desktop"; the shell read: \t 033 [ Z 033 [ A 033 [ 1 ; 5 A 033 [ 1 ; 2 A 033 x y
- PASS [terminal-keys] polite-prairie: vim, less and tmux still get their keys: vim wrote "hello from vim" after Escape, Ctrl+Up and Shift+Up; less took G, Tab and s and saved 1000 lines; tmux took Ctrl+B c and had 2 windows (hello from vim)
- PASS [terminal-keys] zesty-acorn: Ctrl+Shift+Up moves focus to the bar and sends the shell nothing; Tab, Shift+Tab, arrows with Ctrl or Shift, and Escape reach it: focus on "Emulator"; the shell read: \t 033 [ Z 033 [ A 033 [ 1 ; 5 A 033 [ 1 ; 2 A 033 x y
- PASS [terminal-keys] zesty-acorn: vim, less and tmux still get their keys: vim wrote "hello from vim" after Escape, Ctrl+Up and Shift+Up; less took G, Tab and s and saved 1000 lines; tmux took Ctrl+B c and had 2 windows (hello from vim)
