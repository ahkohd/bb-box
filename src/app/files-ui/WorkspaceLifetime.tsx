import { useCallback, useEffect, useRef } from 'react';
import { useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { Contract } from '../../plugin/contract.ts';
import { forgetWorkspaceBox, workspaceBoxes } from './workspace-memory.ts';

export function WorkspaceLifetime() {
  const rpc = useRpc<Contract>();
  const generation = useRef(0);
  const connection = useRealtimeConnectionState();
  const refresh = useCallback(() => {
    const request = ++generation.current;
    for (const box of workspaceBoxes()) {
      void rpc.call('boxPage', { box }).then((page) => {
        if (request === generation.current && (!page.box || page.box.state === 'releasing')) forgetWorkspaceBox(box);
      }, () => undefined);
    }
  }, [rpc]);
  useRealtime('changed', refresh);
  useEffect(() => {
    if (connection === 'connected') refresh();
    return () => { generation.current++; };
  }, [connection, refresh]);
  return null;
}
