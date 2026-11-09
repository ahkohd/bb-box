import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { activateWorkspace, keepWorkspace, restoreWorkspace, type WorkspaceMemory, type WorkspaceState } from './workspace-memory.ts';

const MemoryContext = createContext<WorkspaceMemory | null>(null);

export function WorkspaceSession({ threadId, boxId, children }: { threadId: string; boxId: string; children: ReactNode }) {
  const [memory] = useState(() => restoreWorkspace(threadId, boxId));
  useLayoutEffect(() => {
    activateWorkspace(memory);
    return () => keepWorkspace(memory);
  }, [memory]);
  return <MemoryContext value={memory}>{children}</MemoryContext>;
}

export const useWorkspaceMemory = () => useContext(MemoryContext);

export function useWorkspaceState<K extends keyof WorkspaceState>(key: K, initial: WorkspaceState[K] | (() => WorkspaceState[K])) {
  const memory = useWorkspaceMemory();
  const state = useState<WorkspaceState[K]>(() => {
    const saved = memory?.state[key];
    return saved !== undefined ? saved : typeof initial === 'function' ? initial() : initial;
  });
  useLayoutEffect(() => {
    if (memory?.valid) memory.state[key] = state[0];
  }, [memory, key, state[0]]);
  return state;
}
