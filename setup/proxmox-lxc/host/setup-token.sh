#!/bin/bash
# The bb-box plugin's Proxmox identity: a pool, a user with no password, an
# API token with privilege separation, a role with only what the plugin uses,
# and ACLs on the pool, the storage and the box bridge. Writes the token to
# BBBOX_TOKEN_FILE (0600) and never prints the secret.
#
# Idempotent; an existing token is kept (delete it with
# `pveum user token remove` to make a new one).
# usage: setup-token.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$here/common.sh"
command -v jq >/dev/null || die "jq is required (apt install jq)"
tokenid="$BBBOX_API_USER!$BBBOX_API_TOKEN"

pveum pool list --output-format json | jq -e --arg p "$BBBOX_POOL" '.[] | select(.poolid == $p)' >/dev/null ||
  pveum pool add "$BBBOX_POOL" --comment "bb-box: CT templates and boxes"

# What the plugin does with boxes in the pool: linked-clone a template, set
# cores, memory, disk size, the network, description and tags, clear the
# protection a clone inherits, start, stop, delete, read status and config,
# and list the pool.
privs="VM.Audit,VM.Clone,VM.Allocate,VM.Config.CPU,VM.Config.Memory,VM.Config.Disk,VM.Config.Network,VM.Config.Options,VM.PowerMgmt,Pool.Audit"
if pveum role list --output-format json | jq -e --arg r "$BBBOX_API_ROLE" '.[] | select(.roleid == $r)' >/dev/null; then
  pveum role modify "$BBBOX_API_ROLE" --privs "$privs"
else
  pveum role add "$BBBOX_API_ROLE" --privs "$privs"
fi

pveum user list --output-format json | jq -e --arg u "$BBBOX_API_USER" '.[] | select(.userid == $u)' >/dev/null ||
  pveum user add "$BBBOX_API_USER" --comment "bb-box plugin; API token only, no password"

if ! pveum user token list "$BBBOX_API_USER" --output-format json |
  jq -e --arg t "$BBBOX_API_TOKEN" '.[] | select(.tokenid == $t)' >/dev/null; then
  secret=$(pveum user token add "$BBBOX_API_USER" "$BBBOX_API_TOKEN" --privsep 1 \
    --comment "bb-box plugin: boxes in pool $BBBOX_POOL" --output-format json | jq -er .value)
  fingerprint=$(openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256 | cut -d= -f2)
  address=$(ip -o -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  install -d -m 0700 "$(dirname "$BBBOX_TOKEN_FILE")"
  umask 077
  cat >"$BBBOX_TOKEN_FILE.tmp" <<EOF
# bb-box plugin: Proxmox API access. Secret: keep 0600.
# Header: Authorization: PVEAPIToken=\${PROXMOX_TOKEN_ID}=\${PROXMOX_TOKEN_SECRET}
PROXMOX_API_URL=https://$address:8006/api2/json
PROXMOX_NODE=$BBBOX_NODE
PROXMOX_TOKEN_ID=$tokenid
PROXMOX_TOKEN_SECRET=$secret
# pveproxy's certificate is signed by the cluster's own CA (/etc/pve/pve-root-ca.pem).
PROXMOX_TLS_SHA256_FINGERPRINT=$fingerprint
EOF
  mv "$BBBOX_TOKEN_FILE.tmp" "$BBBOX_TOKEN_FILE"
  unset secret
  echo "created token $tokenid in $BBBOX_TOKEN_FILE"
else
  echo "token $tokenid already exists; $BBBOX_TOKEN_FILE kept"
fi

# With privilege separation a token has the intersection of its own ACLs and
# its user's, so both get the same ones. Clone needs VM.Clone on the template
# and VM.Allocate on the pool, Datastore.AllocateSpace on the storage and
# SDN.Use on the bridge.
for who in "$BBBOX_API_USER" "$tokenid"; do
  flag=--users
  [ "$who" = "$BBBOX_API_USER" ] || flag=--tokens
  pveum acl modify "/pool/$BBBOX_POOL" "$flag" "$who" --roles "$BBBOX_API_ROLE"
  pveum acl modify "/storage/$BBBOX_STORAGE" "$flag" "$who" --roles PVEDatastoreUser
  pveum acl modify "/sdn/zones/localnetwork/$BBBOX_BRIDGE" "$flag" "$who" --roles PVESDNUser
done
pveum acl list --output-format json |
  jq -r --arg u "$BBBOX_API_USER" '.[] | select(.ugid | startswith($u)) | "  \(.path)  \(.ugid)  \(.roleid)"'
