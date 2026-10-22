import type { DoctorCheck, DoctorReport } from "../backends/types.ts";
import { isInstallDevice, type Tailnet } from "./tailnet.ts";

export async function tailnetDoctor(tailnet: Tailnet, installId: string, signal?: AbortSignal): Promise<DoctorReport> {
  const signedIn = await tailnet.check(signal);
  const checks: DoctorCheck[] = [
    signedIn.ok
      ? { id: "tailnet.client", name: "OAuth client", status: "ok", detail: `Tailscale signs the OAuth client in; machines join with the tags ${tailnet.tags.join(", ")}.`, fix: null }
      : { id: "tailnet.client", name: "OAuth client", status: "fail", detail: signedIn.reason, fix: "Check the OAuth client's ID and secret in BB Box's General settings, and that it has the auth_keys scope with these tags." },
  ];
  if (signedIn.ok) {
    try {
      const devices = await tailnet.devices(signal);
      const own = devices.filter((device) => isInstallDevice(device.hostname, installId));
      const others = devices.length - own.length;
      const ownWords = own.length ? `${own.length} of bb-box's on the tailnet: ${own.map((device) => device.hostname).join(", ")}.` : "None of bb-box's on the tailnet.";
      const otherWords = others ? ` ${others} other ${others === 1 ? "device has" : "devices have"} the tags ${tailnet.tags.join(", ")}; bb-box leaves ${others === 1 ? "it" : "them"} alone.` : "";
      checks.push({ id: "tailnet.devices", name: "Devices", status: "ok", detail: ownWords + otherWords, fix: null });
    } catch (error) {
      checks.push({
        id: "tailnet.devices",
        name: "Devices",
        status: "warn",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Give the OAuth client the devices:core scope too, so bb-box can find and remove the devices of machines that went without logging out.",
      });
    }
  }
  const ok = checks.every((check) => check.status !== "fail");
  return { ok, summary: ok ? "bb-box's machines join the tailnet with single-use keys." : "bb-box cannot make keys for the tailnet.", checks, notes: [] };
}
