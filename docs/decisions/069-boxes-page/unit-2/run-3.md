# Live check run-3, 2026-10-30T05:19:39.043Z

Box: amber-coral (bxi4ygvp2o2x4i), container bbbox-bxi4ygvp2o2x4i.

- PASS [Follow-up] a thread with no title heads its card on the Threads tab with its first prompt, as BB's sidebar does: headed "CALL box_list", not thr_3ipni8xbqm
- PASS [Activity] the page shows Live tiles for a box being read, with the time of its last reading: Read at 5:19:46 AM, then Read at 5:19:51 AM; CPU tile "CPU pressure 2%  7 %  idle · 4 cores"
- PASS [Activity] the box's terminal: stress-ng --cpu 2 and top: typed into the page's Terminal view; screenshot terminal-top-1440.png
- PASS [CPU] the page's CPU against top in the box, under stress-ng --cpu 2, within 5 points: page 43, 50, 50, 50, 50, 50, 50, 50, 50 (mean 49.2%); top, every process's %CPU over 4 cores: 50.0, 49.9, 49.9, 50.0, 49.9, 49.8, 50.0, 49.9 (mean 49.9%), stress-ng's alone 49.9%; top's own %Cpu(s) line, the host's 96.3% and on; gap 0.7 points
- PASS [Activity] the processes card lists stress-ng at about 100% each, in amber at 100% or more: Top processes | By CPU, by name only | Process	PID	CPU	Memory |  | stress-ng | stress-ng | 	726	99.3%	5.6 MiB | ; 0 amber
- PASS [Keyboard] Tab reaches the legend and the chart; the arrows move a read-out its live region says: application "chart", held while focused: yes; End: "5:20:56 AM: CPU 50%, Memory 20%"; Left: "5:20:51 AM: CPU 50%, Memory 20%"; summary: "Over the last 6 min, every 5 s: CPU averaged 41%, highest 50% at 5:20:36 AM; memory last 20%. With focus, Left and Right read each point, Home and End the first and last."
- PASS [Monitor] the Monitor turned off: nothing read, and the way to turn it on; then on again: Live back: off: link /settings/plugins/bb-box#option/monitor, processes card gone; on: Read at 5:20:56 AM
- PASS [G16] Live keeps reading while the box stops, and once stopped the card says so: while stopping: "Read at 5:20:56 AM" then "Read at 5:21:10 AM"; stopped: "Activity  amber-coral is stopped, so bb-box is not reading it. It stopped just now, today at 5:21 AM."
- PASS [Activity] started again, Live comes back on its own: Read at 5:21:21 AM
- PASS [Activity] a reading that fails after one worked keeps the last numbers under the Monitor's notice: "Couldn't get stats from amber-coral. Showing data from 5:21 AM."; CPU tile kept: "CPU pressure 0%  31 %  normal · 4 cores"
