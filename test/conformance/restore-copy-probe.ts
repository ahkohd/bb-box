import type { BackendStorage, Guest } from "../../src/backends/types.ts";

export interface RestoreCopyProbe {
  readonly copying: (claimed: Guest, signal: AbortSignal) => Promise<boolean>;
  readonly leftAfterRelease: (claimed: Guest, storage: BackendStorage, signal: AbortSignal) => Promise<readonly string[]>;
}
