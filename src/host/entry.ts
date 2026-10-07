// bb-box's host entry, which BB's daemon runs in a worker on each BB machine
// bb-box calls: "access" holds the thread's access for commands in a box
// (src/host/access.ts), "relay" opens the Docker API relay (042,
// src/host/relay.ts), "file" streams a file box_copy moves (#492,
// src/host/files.ts), and "microsandbox" and "msbRelay" run bb-box's msb
// here (053, src/host/msb.ts).

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accessHandlers } from "./access.ts";
import { hostContract } from "./contract.ts";
import { fileHandlers, type FileOptions } from "./files.ts";
import { msbHandlers, type MsbOptions } from "./msb.ts";
import { relayHandlers, type RelayOptions } from "./relay.ts";

export function hostEntry(options: { access?: { command?: readonly string[] }; relay?: RelayOptions; files?: FileOptions; msb?: MsbOptions } = {}) {
  const access = accessHandlers(options.access);
  const relay = relayHandlers(options.relay);
  const files = fileHandlers(options.files);
  const msb = msbHandlers(options.msb);
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: { ...access.handlers, ...relay.handlers, ...files.handlers, ...msb.handlers },
    async dispose() {
      await Promise.all([access.dispose(), relay.dispose(), files.dispose(), msb.dispose()]);
    },
  });
}
