#!/bin/sh
set -eu
: "${PROXMOX_URL:?} ${PROXMOX_NODE:?} ${PROXMOX_FINGERPRINT:?} ${PROXMOX_TOKEN_ID:?} ${POOL:?} ${TEMPLATE:?}"
: "${VMID_FIRST:?} ${VMID_LAST:?} ${ADDRESSES:?} ${BRIDGE:?} ${SUBNET:?} ${GATEWAY:?}"
: "${SECRETS:=$HOME/lent/token.env}" "${SSH_KEY:=$HOME/lent/ssh_key}"
[ -r "$SECRETS" ] || { echo "no $SECRETS with PROXMOX_TOKEN_SECRET=" >&2; exit 1; }
[ -r "$SSH_KEY" ] || { echo "no $SSH_KEY" >&2; exit 1; }
cd "$HOME"
./bbc box backend add proxmox-lxc --id proxmox-lxc \
  --field url="$PROXMOX_URL" --field node="$PROXMOX_NODE" --field tls-fingerprint="$PROXMOX_FINGERPRINT" \
  --field token-id="$PROXMOX_TOKEN_ID" --secret token-secret=PROXMOX_TOKEN_SECRET --secrets-file "$SECRETS" \
  --secret-file ssh-private-key="$SSH_KEY" \
  --field pool="$POOL" --field linux-templates= --field desktop-templates="$TEMPLATE" \
  --field desktop-cpu-templates= --field desktop-wayland-cpu-templates= \
  --field vmid-first="$VMID_FIRST" --field vmid-last="$VMID_LAST" --field addresses="$ADDRESSES" \
  --field bridge="$BRIDGE" --field subnet="$SUBNET" --field gateway="$GATEWAY" \
  --field desktops-per-gpu=2 --field voxl=true
./bbc box kinds | grep -A2 "^linux-desktop"
