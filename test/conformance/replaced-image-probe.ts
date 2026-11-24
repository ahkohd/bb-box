import type { ImageBuild } from "../../src/backends/types.ts";

export interface ReplacedImageProbe {
  readonly currentId: (current: ImageBuild, built: ImageBuild, signal: AbortSignal) => Promise<string | null>;
  readonly exists: (id: string, signal: AbortSignal) => Promise<boolean>;
}
