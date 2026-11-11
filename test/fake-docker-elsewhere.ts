import { DockerBackend } from "../src/backends/docker/backend.ts";
import type { Backend, BackendStorage } from "../src/backends/types.ts";
import { dockerConfig } from "./fake-docker.ts";
import { testContext } from "./helpers.ts";

export function create(storage: BackendStorage, installId: string, args: readonly string[]): Backend {
  const [binary] = args;
  if (!binary) throw new Error("Give the fake docker CLI.");
  return new DockerBackend(dockerConfig(), testContext(storage, installId, { id: "fake" }), { binary, readyTimeoutMs: 2_000 });
}
