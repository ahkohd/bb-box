# Live check final-2, 2026-10-31T09:19:17.655Z

Boxes: lively-plover (bxpvwxae55rf5a, 2 cores, 4 GiB memory); lively-maple (bxir7ovfnbi2tj); thread thr_ert3y5umv6.

- PASS [list] the list's rows and height do not move as data arrives: each row's top and height, and the list's height, sampled every frame for 5 s from the first frame with a row, on a fresh load: threads: 302 frames, 1 shape; machines: 302 frames, 1 shape
- PASS [list] a thread working on its box says Working on its card, and Idle once it finishes: Working 14.9 s after the agent's call; "Idle" 14.5 s after its result
- PASS [list] a person takes control: the row says You have control, then nothing once handed back: Ready · You have control · up 15 min · 2 cores · 4 GiB memory
  09:20:46 load started
  09:26:00 busy after 5.2 min: {"reason":"cpu","value":98.5,"cores":null,"since":1793438460000,"at":1793438760000,"slot":false}
  09:28:46 load ended
- PASS [G15] a loaded box says busy after 5 minutes of load and stops after the load ends (2 yes on 2 cores for 8 min, read through allBoxes every 5 s): busy 5.2 min after the load began; row "Ready · Busy: CPU 99% for 5 min · up 44 min · 2 cores · 4 GiB memory"; page "Busy: CPU 99% for 5 min", reached by Tab, and Enter moved focus to Top processes; at 390 px "Busy: CPU 99% for 5 min" shown whole on a line of 2; calm 14 s after the load ended
- PASS [keys] keyboard only: Tab reaches a row's name with its line as its description, and Enter opens the page: the first name reached said "lively-maple: Ready · up 24 min · 2 cores · 4 GiB memory"
