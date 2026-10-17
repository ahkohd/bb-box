// The viewers web/page.html uses: the panel's own video client, and noVNC as the panel uses it (060).
// Built into web/client.js: npx esbuild scripts/measure/entry.ts --bundle --format=esm --outfile=scripts/measure/web/client.js --tsconfig=tsconfig.json
import { SelkiesSession } from "../../src/app/selkies.ts";
import { refreshLosslessly } from "../../src/app/rfb-refresh.ts";
import RFB from "@novnc/novnc";
Object.assign(globalThis, { SelkiesSession, RFB, refreshLosslessly });
