import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDir } from "../setup-dir.ts";

export const IDENTITY_DAEMON = "dev.bb-box.identity";
const TOOL_END = "BBBOX_IDENTITY_TOOL";
const PLIST_END = "BBBOX_IDENTITY_PLIST";
const INSTALL_END = "BBBOX_IDENTITY_INSTALL";

let tool: string | null = null;

export function macosIdentityTool(): string {
  tool ??= readFileSync(join(setupDir(), "tart", "guest", "bb-box-identity-macos.sh"), "utf8");
  return tool;
}

export function identityDaemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${IDENTITY_DAEMON}</string>
<key>ProgramArguments</key><array><string>/usr/local/sbin/bb-box-identity</string><string>boot</string></array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>/var/log/bb-box-identity.log</string>
<key>StandardErrorPath</key><string>/var/log/bb-box-identity.log</string>
</dict></plist>
`;
}

export function identityInstallScript(text = macosIdentityTool()): string {
  for (const end of [TOOL_END, PLIST_END, INSTALL_END]) if (text.includes(end)) throw new Error(`The identity tool holds ${end}, which ends its heredoc.`);
  return `case "$(sysctl -n hw.model 2>/dev/null)" in VirtualMac*) ;; *) echo "not a VM"; exit 0 ;; esac
sudo -n /bin/sh -s <<'${INSTALL_END}'
set -e
mkdir -p /usr/local/sbin /usr/local/lib/bb-box
cat > /usr/local/sbin/bb-box-identity.new <<'${TOOL_END}'
${text.endsWith("\n") ? text : `${text}\n`}${TOOL_END}
chmod 755 /usr/local/sbin/bb-box-identity.new
mv -f /usr/local/sbin/bb-box-identity.new /usr/local/sbin/bb-box-identity
cat > /Library/LaunchDaemons/${IDENTITY_DAEMON}.plist.new <<'${PLIST_END}'
${identityDaemonPlist()}${PLIST_END}
chown root:wheel /Library/LaunchDaemons/${IDENTITY_DAEMON}.plist.new
chmod 644 /Library/LaunchDaemons/${IDENTITY_DAEMON}.plist.new
mv -f /Library/LaunchDaemons/${IDENTITY_DAEMON}.plist.new /Library/LaunchDaemons/${IDENTITY_DAEMON}.plist
/usr/local/sbin/bb-box-identity enable
[ -e /var/run/bb-box-identity/boot ] || /usr/local/sbin/bb-box-identity boot >/dev/null
echo installed
${INSTALL_END}`;
}
