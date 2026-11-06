import { tailnetHostname } from "../../core/tailnet.ts";

export const METADATA_ADDRESS = "169.254.169.254";
export const TAILSCALE_KEY_PATH = "/run/bb-box/tailscale-auth-key";
export const HOST_SETUP_PATH = "/usr/local/sbin/bb-box-host-setup";

export function metadataRule(): string {
  return [
    "iptables -N DOCKER-USER 2>/dev/null || true",
    `iptables -C DOCKER-USER -d ${METADATA_ADDRESS}/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER -d ${METADATA_ADDRESS}/32 -j REJECT`,
  ].join("; ");
}

export const LXCFS_KEPT_RUNNING = "/etc/systemd/system/lxcfs.service.d/bb-box-keep-running.conf";

const LXCFS_SETUP = [
  "command -v lxcfs >/dev/null || { apt-get update -qq && apt-get install -y -qq lxcfs; }",
  "systemctl enable --now lxcfs",
  "apt-mark hold lxcfs >/dev/null",
  "mkdir -p /etc/systemd/system/lxcfs.service.d",
  `printf '[Unit]\\nRefuseManualStop=yes\\n' > ${LXCFS_KEPT_RUNNING}`,
  "systemctl daemon-reload",
];

export function hostSetupScript(input: { serverName: string; joinsTailnet: boolean }): string {
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    metadataRule(),
  ];
  if (input.joinsTailnet) {
    lines.push(
      "command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh",
      `if [ -s ${TAILSCALE_KEY_PATH} ]; then tailscale up --auth-key=file:${TAILSCALE_KEY_PATH} --hostname=${tailnetHostname(input.serverName)} --accept-dns=false --timeout=120s; fi`,
      `rm -f ${TAILSCALE_KEY_PATH}`,
    );
  }
  lines.push(
    "command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh",
    "systemctl stop docker.socket docker.service || true",
    "rm -f /var/lib/docker/engine-id",
    "systemctl enable --now docker",
    ...LXCFS_SETUP,
    metadataRule(),
  );
  return lines.join("\n") + "\n";
}

export function hostUserData(input: { serverName: string; tailnetKey: string | null }): string {
  const files = [
    { path: HOST_SETUP_PATH, permissions: "0755", content: hostSetupScript({ serverName: input.serverName, joinsTailnet: input.tailnetKey !== null }) },
    ...(input.tailnetKey ? [{ path: TAILSCALE_KEY_PATH, permissions: "0600", content: input.tailnetKey }] : []),
  ];
  return [
    "#cloud-config",
    "write_files:",
    ...files.flatMap((file) => [`  - path: ${file.path}`, "    owner: root:root", `    permissions: '${file.permissions}'`, `    content: ${JSON.stringify(file.content)}`]),
    "bootcmd:",
    `  - ${JSON.stringify(["sh", "-c", metadataRule()])}`,
    "runcmd:",
    `  - ${JSON.stringify([HOST_SETUP_PATH])}`,
    "",
  ].join("\n");
}
