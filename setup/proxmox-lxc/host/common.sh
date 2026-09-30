# Shared by bb-box's Proxmox host scripts: reads /etc/bb-box/bb-box.env (or
# $BBBOX_ENV) and fills in defaults. Sourced, not run.
# shellcheck shell=bash

BBBOX_ENV=${BBBOX_ENV:-/etc/bb-box/bb-box.env}
if [ -f "$BBBOX_ENV" ]; then
  # Settings already in the environment win over the file, so one run can
  # override one value (for example BBBOX_BUILD_ADDRESS for a second build).
  _bbbox_set=$(declare -p $(compgen -v BBBOX_) 2>/dev/null || true)
  # shellcheck disable=SC1090
  . "$BBBOX_ENV"
  eval "$_bbbox_set"
  unset _bbbox_set
fi

BBBOX_NODE=${BBBOX_NODE:-$(hostname)}
BBBOX_POOL=${BBBOX_POOL:-bbbox}
BBBOX_STORAGE=${BBBOX_STORAGE:-local-lvm}
BBBOX_OS_TEMPLATE=${BBBOX_OS_TEMPLATE:-local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst}
BBBOX_BRIDGE=${BBBOX_BRIDGE:-vmbr200}
BBBOX_GATEWAY_CIDR=${BBBOX_GATEWAY_CIDR:-10.200.0.1/24}
BBBOX_BUILD_ADDRESS=${BBBOX_BUILD_ADDRESS:-10.200.0.2}
BBBOX_DNS=${BBBOX_DNS:-1.1.1.1 9.9.9.9}
BBBOX_DNAT=${BBBOX_DNAT:-}
BBBOX_BB_URL=${BBBOX_BB_URL:-}
BBBOX_BB_RESOLVE=${BBBOX_BB_RESOLVE:-}
BBBOX_SSH_KEY=${BBBOX_SSH_KEY:-/root/bb-box/ssh/id_ed25519}
BBBOX_API_USER=${BBBOX_API_USER:-bbbox@pve}
BBBOX_API_TOKEN=${BBBOX_API_TOKEN:-plugin}
BBBOX_API_ROLE=${BBBOX_API_ROLE:-BBBoxPlugin}
BBBOX_TOKEN_FILE=${BBBOX_TOKEN_FILE:-/root/bb-box/proxmox-token.env}

BBBOX_GATEWAY=${BBBOX_GATEWAY_CIDR%/*}
BBBOX_PREFIX=${BBBOX_GATEWAY_CIDR#*/}

die() {
  echo "${0##*/}: $*" >&2
  exit 1
}

# The subnet in CIDR form, for example 10.200.0.0/24.
bbbox_subnet() {
  python3 -c 'import ipaddress, sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$BBBOX_GATEWAY_CIDR"
}

[ "$(id -u)" = 0 ] || die "run as root on the Proxmox host"
