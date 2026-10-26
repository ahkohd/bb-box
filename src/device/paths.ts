import { join } from "node:path";

export const DEVICE_HOME = ".bb-box/device";
export const SERVICE_LABEL = "app.bb-box.device";
export const SYSTEMD_UNIT = "bb-box-device.service";
export const LAUNCH_AGENT = `Library/LaunchAgents/${SERVICE_LABEL}.plist`;
export const SYSTEMD_USER_UNIT = `.config/systemd/user/${SYSTEMD_UNIT}`;
export const SERVER_ENTRY = "src/device/main.ts";
export const LAUNCHER = "bin/bb-box-device";

export const RESTART_DELAY_MS = 1000;
export const START_LIMIT_INTERVAL_MS = 60_000;
export const START_LIMIT_BURST = 10;

export const EXITS = { gaveUp: 3, noNode: 4, noServer: 5, locked: 75 } as const;

export function devicePaths(home: string) {
  const dir = join(home, DEVICE_HOME);
  return {
    dir,
    socket: join(dir, "device.sock"),
    lock: join(dir, "lock"),
    supervisorLock: join(dir, "supervisor.lock"),
    intent: join(dir, "intent.json"),
    state: join(dir, "state.json"),
    devices: join(dir, "devices.json"),
    servers: join(dir, "server"),
    current: join(dir, "current"),
    previous: join(dir, "previous"),
    launcher: join(dir, LAUNCHER),
    node: join(dir, "node"),
    log: join(dir, "server.log"),
    starts: join(dir, "starts"),
    gaveUp: join(dir, "gave-up"),
    lastError: join(dir, "last-error"),
    manager: join(dir, "manager"),
  };
}

export type DevicePaths = ReturnType<typeof devicePaths>;
