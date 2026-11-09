// The fetch the Proxmox backends reach the API with: a pinned certificate or
// a CA, as their settings give.

import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { FetchLike } from "./api.ts";
import { PRODUCT } from "../../brand.ts";

export interface ProxmoxHttp {
  fetch: FetchLike;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export function proxmoxHttp(fetch: FetchLike): ProxmoxHttp {
  return { fetch, close: async () => {}, destroy: async () => {} };
}

function httpOf(agent: Agent): ProxmoxHttp {
  return {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }),
    close: () => agent.close(),
    destroy: () => agent.destroy(),
  };
}

/**
 * A fetch for the Proxmox API. With a fingerprint it trusts that certificate
 * alone, which suits Proxmox's self-signed one; otherwise it trusts `ca`, or
 * the system roots when that is null.
 */
export function proxmoxFetch(tls: { ca: string | null; fingerprint: string | null }): ProxmoxHttp {
  let agent: Agent;
  if (tls.fingerprint) {
    const expected = tls.fingerprint;
    // No cached sessions: a resumed session may not carry the certificate to check.
    const connect = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
    agent = new Agent({
      connect: (options, callback) =>
        connect(options, (error, socket) => {
          if (error) return callback(error, null);
          if (options.protocol !== "https:") return callback(null, socket!);
          const actual = (socket as TLSSocket).getPeerCertificate().fingerprint256;
          if (actual === expected) return callback(null, socket!);
          socket!.destroy();
          callback(
            new Error(
              `the API's certificate has SHA-256 fingerprint ${actual || "(none)"}, not the one in ${PRODUCT}'s settings. ` +
                "If the certificate was renewed, set the new fingerprint.",
            ),
            null,
          );
        }),
    });
  } else if (tls.ca) {
    agent = new Agent({ connect: { ca: tls.ca } });
  } else {
    agent = new Agent();
  }
  return httpOf(agent);
}
