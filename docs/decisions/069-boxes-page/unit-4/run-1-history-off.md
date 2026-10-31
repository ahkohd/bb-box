# Live check checks-1, 2026-10-31T08:56:15.658Z

Boxes: lively-plover (bxpvwxae55rf5a, 2 cores, 4 GiB memory); no desktop; thread thr_ert3y5umv6.

- PASS [list] a thread working on its box says Working on its card, and Idle once it finishes: Working 0.4 s after the agent's call; "Idle 0 s" 0.0 s after its result
- PASS [G15] turning box history off removes Busy from the row and the page within a minute: the row lost its busy words 0.7 s after the switch; the page says nothing
- PASS [keys] keyboard only: Tab reaches a row's name with its line as its description, and Enter opens the page: the first name reached said "lively-plover: Ready · Busy: CPU 100% for 5 min · up 20 min · 2 cores · 4 GiB memory"
