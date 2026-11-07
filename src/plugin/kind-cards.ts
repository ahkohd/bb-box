import type { GpuRoom } from "../backends/types.ts";
import type { KindCards } from "./contract.ts";

export async function kindCardReads(
  offered: readonly { readonly backend: { readonly id: string; gpuRoom?(kind: string): Promise<GpuRoom> }; readonly kind: { readonly id: string } }[],
): Promise<KindCards[]> {
  return Promise.all(
    offered.map(async ({ backend, kind }) => {
      if (!backend.gpuRoom) return { backend: backend.id, room: null, failed: false };
      try {
        return { backend: backend.id, room: await backend.gpuRoom(kind.id), failed: false };
      } catch {
        return { backend: backend.id, room: null, failed: true };
      }
    }),
  );
}
