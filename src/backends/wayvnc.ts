// wayvnc 0.7.2, which Ubuntu 24.04 ships, can freeze at a viewer's sign-in
// right after a resize with no viewer has restarted it, until it crashes 5 s
// or more later (#411): 4 of 600 rounds in a Docker Wayland desktop. Killing
// it has the desktop start a new wayvnc, which signs viewers in, in about
// 0.2 s. As the box user, whose wayvnc it is.

import type { CommandTransport } from "../transports/types.ts";

const RESTART = `old=$(pgrep -u "$(id -u)" -x wayvnc | head -1)
[ -z "$old" ] || kill -KILL "$old"
for _ in $(seq 1 100); do
  new=$(pgrep -u "$(id -u)" -x wayvnc | head -1)
  [ -n "$new" ] && [ "$new" != "$old" ] && wayvncctl version >/dev/null 2>&1 && exit 0
  sleep 0.05
done
echo "wayvnc did not start again within 5 s" >&2
exit 1`;

/** Kills the box user's wayvnc, and waits for the desktop's next to answer. */
export async function restartWayvnc(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  const result = await command.run(RESTART, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) throw new Error(`wayvnc could not be started again: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
}
