// The terminal's WebSocket route, apart from the RPC contract, which imports
// the server's SDK: the panel imports this file's values, and the contract only
// as a type (#941 broke a deploy by importing a value from the contract).

/** The terminal's WebSocket route, under the plugin's HTTP path, which a tab opens without waiting for the box's state (#916). */
export const TERMINAL_ROUTE = "/terminal";

export function terminalPath(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${TERMINAL_ROUTE}`;
}
