# Live check final, 2026-10-31T09:05:28.989Z

Boxes: lively-plover (bxpvwxae55rf5a, 2 cores, 4 GiB memory); lively-maple (bxir7ovfnbi2tj); thread thr_ert3y5umv6.

- PASS [list] the list's rows and height do not move as data arrives: each row's top and height, and the list's height, sampled every frame for 5 s from the first frame with a row, on a fresh load: threads: 303 frames, 1 shape; machines: 302 frames, 1 shape
- PASS [list] a thread working on its box says Working on its card, and Idle once it finishes: Working 13.7 s after the agent's call; "Idle" 14.5 s after its result
- PASS [list] a person takes control: the row says You have control, then nothing once handed back: Ready · You have control · up 2 min · 2 cores · 4 GiB memory
  09:06:57 load started
  09:12:00 busy after 5.0 min: {"reason":"cpu","value":99.2,"cores":null,"since":1793437620000,"at":1793437920000,"slot":false}
  09:14:57 load ended
- PASS [G15] a loaded box says busy after 5 minutes of load and stops after the load ends (2 yes on 2 cores for 8 min, read through allBoxes every 5 s): busy 5.0 min after the load began; row "Ready · Busy: CPU 99% for 5 min · up 30 min · 2 cores · 4 GiB memory"; page "Busy: CPU 99% for 5 min", reached by Tab, and Enter moved focus to Top processes; at 390 px "Busy: CPU 99% for 5 min" shown whole on a line of 2; calm 63 s after the load ended
