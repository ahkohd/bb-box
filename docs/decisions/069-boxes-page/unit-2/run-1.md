# Live check run-1, 2026-10-30T04:22:47.304Z

Box: amber-coral (bxi4ygvp2o2x4i), container bbbox-bxi4ygvp2o2x4i.

- PASS [Activity] the page shows Live tiles for a box being read, with the time of its last reading: Read at 4:22:49 AM, then Read at 4:22:55 AM; CPU tile "CPU pressure 2%  0 %  idle · 4 cores"
- PASS [Activity] the box's terminal: stress-ng --cpu 2 and top: typed into the page's Terminal view; screenshot terminal-top-1440.png
- PASS [CPU] the page's CPU against top in the box, under stress-ng --cpu 2, within 5 points: page 47, 49, 47, 39, 43, 47, 50, 50, 50 (mean 46.9%); top, every process's %CPU over 4 cores: 48.9, 36.9, 46.5, 43.7, 49.9, 49.5, 49.8, 47.4 (mean 46.6%), stress-ng's alone 46.5%; top's own %Cpu(s) line, the host's 75.3% and on; gap 0.3 points
- PASS [Activity] the processes card lists stress-ng at about 100% each, in amber at 100% or more: Top processes | By CPU, by name only | Process	PID	CPU	Memory |  | stress-ng | stress-ng | 	1555	96.1%	5.4 MiB | ; 0 amber
- PASS [Keyboard] Tab reaches the legend and the chart; the arrows move a read-out its live region says: End: "4:24:05 AM: CPU 47%, Memory 21%"; Left: "4:24:00 AM: CPU 50%, Memory 22%"; summary: "Over the last 6 min, every 5 s: CPU averaged 36%, highest 50% at 4:23:50 AM; memory last 21%. With focus, Left and Right read each point, Home and End the first and last."
- PASS [Monitor] the Monitor turned off: nothing read, and the way to turn it on; then on again: Live back: off: link /settings/plugins/bb-box#option/monitor, processes card gone; on: Read at 4:24:10 AM
- PASS [G16] Live keeps reading while the box stops, and once stopped the card says so: while stopping: "Read at 4:24:18 AM" then "Read at 4:24:28 AM"; stopped: "Activity  amber-coral is stopped, so bb-box is not reading it. It stopped just now, today at 4:24 AM."
- PASS [Activity] started again, Live comes back on its own: Read at 4:24:44 AM
- PASS [Activity] a reading that fails after one worked keeps the last numbers under the Monitor's notice: "Can't reach amber-coral. Showing data from 4:24 AM."; CPU tile kept: "CPU pressure 2%  50 %  normal · 4 cores"
