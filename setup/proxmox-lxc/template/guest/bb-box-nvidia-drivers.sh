#!/bin/bash
# usage: bb-box-nvidia-drivers [--check]
#   --check  prints each file's state and changes nothing
# BB_BOX_ROOT: the root its files and device nodes are under, for tests.
set -euo pipefail

root=${BB_BOX_ROOT:-}
hidden_suffix=.bb-box-no-card
card_files=(
  /usr/share/glvnd/egl_vendor.d/10_nvidia.json
  /etc/glvnd/egl_vendor.d/10_nvidia.json
  /etc/vulkan/icd.d/nvidia_icd.json
  /usr/share/vulkan/icd.d/nvidia_icd.json
  /etc/vulkan/implicit_layer.d/nvidia_layers.json
  /usr/share/vulkan/implicit_layer.d/nvidia_layers.json
  /usr/share/egl/egl_external_platform.d/10_nvidia_wayland.json
  /usr/share/egl/egl_external_platform.d/20_nvidia_xcb.json
  /usr/share/egl/egl_external_platform.d/20_nvidia_xlib.json
)
render_files=(/usr/share/egl/egl_external_platform.d/15_nvidia_gbm.json)

check=
case "${1:-}" in
  "") ;;
  --check) check=1 ;;
  *) echo "usage: bb-box-nvidia-drivers [--check]" >&2; exit 2 ;;
esac

any_of() {
  local path
  for path in "$@"; do [ -e "$path" ] && return 0; done
  return 1
}
has_card() { [ -e "$root/dev/nvidiactl" ] && any_of "$root"/dev/nvidia[0-9]*; }
has_render_node() { any_of "$root"/dev/dri/renderD*; }

state_of() {
  local file=$root$1
  if [ -e "$file" ]; then echo shown
  elif [ -e "$file$hidden_suffix" ]; then echo hidden
  else echo absent; fi
}

place() {
  local file=$root$1 wanted=$2
  if [ "$wanted" = shown ]; then
    if [ -e "$file" ]; then rm -f "$file$hidden_suffix"
    elif [ -e "$file$hidden_suffix" ]; then mv "$file$hidden_suffix" "$file"; fi
  elif [ -e "$file" ]; then
    mv -f "$file" "$file$hidden_suffix"
  fi
}

card=hidden
render=hidden
has_card && card=shown
[ "$card" = shown ] && has_render_node && render=shown
changed=()
for listed in "${card_files[@]}" "${render_files[@]}"; do
  wanted=$card
  [[ " ${render_files[*]} " != *" $listed "* ]] || wanted=$render
  before=$(state_of "$listed")
  [ "$before" != absent ] || continue
  if [ -n "$check" ]; then
    echo "$listed $before"
    continue
  fi
  place "$listed" "$wanted"
  [ "$before" = "$wanted" ] || changed+=("$listed $wanted")
done
[ -z "$check" ] || exit 0
if [ "$card" = shown ]; then words="a card's device nodes"; else words="no card's device nodes"; fi
[ "$render" = shown ] || [ "$card" = hidden ] || words="$words and no DRM render node"
if [ "${#changed[@]}" -eq 0 ]; then
  echo "bb-box-nvidia-drivers: $words; nothing to change"
else
  summary=$(printf '%s; ' "${changed[@]}")
  echo "bb-box-nvidia-drivers: $words; ${summary%; }"
fi
