#!/bin/sh
printf '%s %s\n' "$(date +%s.%N)" "$*" >> "$HOME/docker-calls.log"
once() {
  [ -e "$HOME/flags/$1" ] || return 1
  rm -f "$HOME/flags/$1"
}
if [ -e "$HOME/flags/exec-hangs" ]; then
  hung=$(cat "$HOME/flags/exec-hangs")
  case " $* " in
    *" exec "*" $hung "*) exec sleep 3600 ;;
  esac
fi
case " $* " in
  *" container ls "*)
    if [ -e "$HOME/flags/listing-fails" ]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
      exit 1
    fi ;;
  *" container start "*)
    if once start-fails; then
      echo "Error response from daemon: failed to create task for container: OCI runtime create failed: cgroup is frozen" >&2
      exit 1
    fi ;;
  *" container stop "*)
    if once stop-fails; then
      echo "Error response from daemon: cannot stop container: permission denied" >&2
      exit 1
    fi ;;
  *" container rm "*)
    if once rm-fails; then
      echo "Error response from daemon: could not remove container: device or resource busy" >&2
      exit 1
    fi ;;
esac
exec /usr/bin/docker "$@"
