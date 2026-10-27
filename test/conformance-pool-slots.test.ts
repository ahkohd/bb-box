import { slotConformance } from "./conformance/suite.ts";
import { fakePoolMac } from "./fake-pool-mac.ts";

const pool = fakePoolMac();
await slotConformance({
  name: "SSH host pool iOS slots on a fake Mac",
  create: () => pool.backend(),
  kind: "ios",
  elastic: false,
  timeoutMs: 60_000,
});
