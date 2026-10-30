# Live check run-2, 2026-10-30T05:17:06.070Z

Box: amber-coral (bxi4ygvp2o2x4i), container bbbox-bxi4ygvp2o2x4i.

- PASS [Follow-up] a thread with no title heads its card on the Threads tab with its first prompt, as BB's sidebar does: headed "CALL box_list", not thr_3ipni8xbqm
- PASS [Activity] the page shows Live tiles for a box being read, with the time of its last reading: Read at 5:17:14 AM, then Read at 5:17:19 AM; CPU tile "CPU pressure 1%  0 %  idle · 4 cores"
- PASS [Activity] the box's terminal: stress-ng --cpu 2 and top: typed into the page's Terminal view; screenshot terminal-top-1440.png
- PASS [CPU] the page's CPU against top in the box, under stress-ng --cpu 2, within 5 points: page 50, 48, 50, 50, 50, 50, 43, 47, 46 (mean 48.2%); top, every process's %CPU over 4 cores: 49.9, 50.0, 49.9, 50.0, 45.1, 44.9, 45.6, 46.4 (mean 47.7%), stress-ng's alone 47.7%; top's own %Cpu(s) line, the host's 94% and on; gap 0.5 points
- PASS [Activity] the processes card lists stress-ng at about 100% each, in amber at 100% or more: Top processes | By CPU, by name only | Process	PID	CPU	Memory |  | stress-ng | stress-ng | 	1385	97.5%	5.7 MiB | ; 0 amber
- PASS [Keyboard] Tab reaches the legend and the chart; the arrows move a read-out its live region says: application "chart", held while focused: yes; End: "5:18:24 AM: CPU 45%, Memory 19%"; Left: "5:18:19 AM: CPU 46%, Memory 19%"; summary: "Over the last 6 min, every 5 s: CPU averaged 38%, highest 50% at 5:17:59 AM; memory last 19%. With focus, Left and Right read each point, Home and End the first and last."
- PASS [Monitor] the Monitor turned off: nothing read, and the way to turn it on; then on again: Live back: off: link /settings/plugins/bb-box#option/monitor, processes card gone; on: Read at 5:18:29 AM
- PASS [G16] Live keeps reading while the box stops, and once stopped the card says so: while stopping: "Read at 5:18:37 AM" then "Read at 5:18:47 AM"; stopped: "Activity  amber-coral is stopped, so bb-box is not reading it. It stopped just now, today at 5:18 AM."
- PASS [Activity] started again, Live comes back on its own: Read at 5:19:03 AM
- PASS [Activity] a reading that fails after one worked keeps the last numbers under the Monitor's notice: "Can't reach amber-coral. Showing data from 5:18 AM."; CPU tile kept: "CPU pressure 2%  50 %  normal · 4 cores"
