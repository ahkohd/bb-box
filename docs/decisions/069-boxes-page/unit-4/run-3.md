# Live check final-3, 2026-10-31T09:33:57.160Z

Boxes: lively-plover (bxpvwxae55rf5a, 2 cores, 4 GiB memory); lively-maple (bxir7ovfnbi2tj); thread thr_ert3y5umv6.

- PASS [list] the list's rows and height do not move as data arrives: each row's top and height, and the list's height, sampled every frame for 5 s from the first frame with a row, on a fresh load: threads: 301 frames, 1 shape; machines: 301 frames, 1 shape
- PASS [list] a thread working on its box says Working on its card, and Idle once it finishes: Working 14.9 s after the agent's call; "Idle" 14.5 s after its result
- PASS [list] a person takes control: the row says You have control, then nothing once handed back: Ready · You have control · up 30 min · 2 cores · 4 GiB memory
- PASS [keys] keyboard only: Tab reaches a row's name with its line as its description, and Enter opens the page: the first name reached said "lively-maple: Ready · up 30 min · 2 cores · 4 GiB memory"
