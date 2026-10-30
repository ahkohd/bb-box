# Live check run-3, 2026-10-30T02:25:04.714Z

Boxes: clear-finch (bxnm6bvebiwzcc), workbench (bx6cblzkeq7cfn), polite-dune (bx7z2wppye7ttr), neat-reef (bxawolulaapvfd), bold-oriole (bxq2ewj6os623o); thread thr_b93pi4gax7.

## Entries
- PASS [entry] a link opens the page, its name focused: /plugins/bb-box/desktop/box/bxnm6bvebiwzcc
- PASS [entry] the Box panel's Open on the Boxes page opens the page: menu: Open terminal, Open on the Boxes page, Copy address, New thread on this box…, Stop, Resize…, Check now, Release…
- PASS [entry] the Monitor's Open menu has Page first, which opens the page: menu: Page, Open terminal, CALL box_list
- PASS [entry] the box's name in a view's bar opens its page, keeping the view's origin: /plugins/bb-box/desktop/box/bxnm6bvebiwzcc/from-list
- PASS [entry] an old path without from-settings: its back arrow goes to the box's page, replacing the view: replaced with the page
- PASS [entry] an old path with from-settings: its back arrow is a link to BB Box settings: settings
## Reload, back and forward, a new tab
- PASS [G8] a reload keeps the page: /plugins/bb-box/desktop/box/bxnm6bvebiwzcc
- PASS [G8] page, Terminal, browser Back and Forward, then the view's back goes back in history: Back, Forward and the back arrow agree
- PASS [G8] a reload on the view, then its back replaces with the page: replaced, and Back goes to the page before the view
- PASS [entry] Control-click on a view opens it in a new tab, whose back replaces with the page: new tab, then its page
## G8, origin in the path
- PASS [G8] a row's quick Terminal and back: the list, by going back: back at /plugins/bb-box/desktop/threads; focus on "
    New threadThreadsCALL box_list
    " (focus on the row is unit 1d's G9)
- PASS [G8] after visiting another box, a quick icon and back: the list: /plugins/bb-box/desktop/threads
- PASS [G8] settings, a machine's page, Terminal and back: the page, then settings: page, then settings
- PASS [G8] the same after a reload on the view: page, then settings
- PASS [G8] a page opened by URL, then Boxes, then browser Back does not return to the page: Back went to /plugins/bb-box/desktop/threads
- PASS [G8] a row's quick Terminal, a reload, then back: the list it names: /plugins/bb-box/desktop
## Keyboard only
- FINDING [keyboard] from the terminal, 12 presses of Shift-Tab stay in it, as xterm keeps Tab for the shell, so the back arrow is out of the keyboard's reach there
- PASS [keyboard] Tab from the name, Shift-Tab to the trail, Enter on a view and back: Tab order: Box ID bxnm6bvebiwzcc: copy → Copy link → CALL box_list → Terminal → Stop → clear-finch actions → Address 172.16.1.2: copy → New thread on this box… → Toggle sidebar (Ctrl + \); from the terminal, Shift-Tab stays in the terminal (a finding), and Back returned to the page with focus on its name
## G3 and G6: Stop, Start and a failed stop from the page
- PASS [G6] a stop that fails says so, with what bb-box then saw, said once by the page's one announcer: Stop failed just nowStopping the box failed: docker container stop failed: Error response from daemon: cannot stop container: permission denied. It is still running (checked 2:25 AM).Stop again | said: Stop failed. Stopping the box failed: docker container stop failed: Error response from daemon: cannot stop container: permission denied. It is still running (checked 2:25 AM).
- PASS [G3] with the box's own thread working, Stop asks from the row, its menu, the page and the notice's retry: row: "Stop clear-finch anyway?" "CALL box_list is working on clear-finch.CALL box_list"; menu: "Stop clear-finch anyway?" "CALL box_list is working on clear-finch.CALL box_list"; page: "Stop clear-finch anyway?" "CALL box_list is working on clear-finch.CALL box_list"; notice: "Stop clear-finch anyway?" "CALL box_list is working on clear-finch.CALL box_list"
- PASS [G3] Stop it anyway stopped it; Start from the page: stopped: "Stopped· just now, today at 2:25 AM, by you"; then started
- PASS [G3] an idle thread's box stops at once, by you, and starts again: "Stopped· just now, today at 2:25 AM, by you", then "Last started today at 2:25 AM, by you: ready in 0.3 s."
- PASS [G3] a machine of yours stops at once with no thread on it, as today: stopped and started
## A start that fails
- PASS [review 6] a failed stop goes from the page once the box is stopped outside bb-box: header: Ready· up 0 s
- PASS [G6] a start that fails says so, with what bb-box then saw, and Start again starts it: Start failed just nowStarting the box failed: docker container start failed: Error response from daemon: failed to create task for container: OCI runtime create failed: cgroup is frozen. It is still stopped (checked 2:25 AM).Start again
## Release from the page, one that does not finish, and the link after
- PASS [release] a release that does not finish says so on the page and the row, with Release again: Release did not finish just nowReleasing the box failed: docker container rm failed: Error response from daemon: could not remove container: device or resource busy. The box may still run on crisp-petrel; bb-box keeps its record until a release is confirmed.Release again… | row menu: Copy address, Check now (disabled), Release again…
- PASS [release] Release again releases it, and the page says so, by you: Released just now, today at 2:25 AM, by you. bb-box remembers a released box for 24 hours.
- PASS [release] the released box's link after a reload and after a restart of bb-box: Released just now, today at 2:25 AM, by you. bb-box remembers a released box for 24 hours.
## G20: a box that does not answer, and a backend that does not answer
- PASS [G20] a box that does not answer keeps Stop, Start and Resize, says it can still be stopped, and loses only its views and New thread: notice: polite-dune does not answerThe box bbbox-bx7z2wppye7ttr did not answer through docker exec. Since 2:26 AM, bb-box cannot reach it on crisp-petrel, so it cannot read it or run commands in it. You can still stop, start or release it: those go through Docker on crisp-petrel.bb-box checks again in 59 s.Check now | off: Terminal is off: polite-dune does not answer. | page menu: Copy address, New thread on this box…polite-dune does not answer (disabled), Resize…, Check now, Release… | row menu: Open terminal, Copy address, Stop, Resize…, Check now, Release… | stopped from its page, mark cleared
- PASS [G20] started again, it answers: Ready
- PASS [G20] a backend whose listing fails turns off Stop, Start, Resize and New thread, saying why in words, until it lists again: notice: Docker on crisp-petrel does not answerListing the boxes on Docker on crisp-petrel failed: docker container ls failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? Since 2:26 AM, bb-box cannot check, stop, start or resize clear-finch through it, and the box may still be running.bb-box asks it again every 3 minutes.Check now | off: Terminal and Stop are off: Docker on crisp-petrel does not answer. | page menu: Copy address, New thread on this box…Docker on crisp-petrel does not answer (disabled), Resize…Docker on crisp-petrel does not answer (disabled), Check now, Release… | row menu: Open terminal, Copy address, StopDocker on crisp-petrel does not answer (disabled), Resize…Docker on crisp-petrel does not answer (disabled), Check now, Release… | cleared once it listed again
## G20: a backend removed from settings, Forget, and the link after
- PASS [G20] a box whose backend is not in settings: the notice, and no Stop, Start, Resize or New thread, each saying why: notice: Its backend is not in settingsDocker on crisp-petrel was removed from bb-box's settings, so bb-box cannot check, stop or release bold-oriole, which may still be running on crisp-petrel. Add the backend back to manage it, or forget it here.Open BB Box settingsForget… | page menu: Copy address, New thread on this box…Its backend is not in settings (disabled), Resize…Its backend is not in settings (disabled), Check now, Forget… | row menu: Open terminal, Copy address, StopIts backend is not in settings (disabled), Resize…Its backend is not in settings (disabled), Check now, Forget…
- PASS [G5 words] Forget from the page says forgotten, never released, and the box still runs: asked: Forget bold-oriole?bb-box removes its record of bold-oriole, and nothing else. Its box is not deleted: if it still runs on crisp-petrel, it keeps running there. | page: bb-box removed its record. Its box was not deleted and may still run on crisp-petrel. Forgotten just now, today at 2:26 AM, by you. | container running: true
- PASS [G5 words] the forgotten box's link after a reload and after a restart of bb-box: bb-box removed its record. Its box was not deleted and may still run on crisp-petrel. Forgotten just now, today at 2:26 AM, by you.
- removed bold-oriole's container by hand, then restored the configuration, so the sweep has no guest of it to restore

33 of 33 checks passed.
