import { generateKeyPair } from "../transports/ssh.ts";
import type { BackendStorage } from "./types.ts";

export interface StoredKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

let keysInTurn: Promise<unknown> = Promise.resolve();

export function storedKeyPair(storage: BackendStorage, key: string): Promise<StoredKeyPair> {
  const turn = keysInTurn.then(async () => {
    const stored = await storage.get<StoredKeyPair>(key);
    if (stored) return stored;
    const made = await generateKeyPair();
    await storage.set(key, made);
    return made;
  });
  keysInTurn = turn.catch(() => undefined);
  return turn;
}
