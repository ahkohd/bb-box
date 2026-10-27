import { TartBackend } from "../src/backends/tart/backend.ts";
import { slotConformance } from "./conformance/suite.ts";
import { IOS_HOST_FAKES, IOS_HOST_SETTINGS, fakeIosHostMac } from "./fake-ios-host.ts";
import { tartConfig } from "./fake-mac.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

fakeIosHostMac();
await slotConformance({
  name: "Tart shared iOS hosts on a fake Mac",
  create: () => new TartBackend(tartConfig(IOS_HOST_SETTINGS), testContext(new MemoryStorage(), "conformance"), IOS_HOST_FAKES),
  kind: "macos",
  elastic: true,
  timeoutMs: 60_000,
});
