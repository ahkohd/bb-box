#!/bin/sh
printf '%s %s\n' "$(date +%s.%N)" "$*" >> "$HOME/docker-calls.log"
case " $* " in
  *" container stop "*)
    if [ -e "$HOME/flags/stop-times-out" ]; then
      rm -f "$HOME/flags/stop-times-out"
      ( sleep 8; /usr/bin/docker "$@" >/dev/null 2>&1 ) &
      echo "Error response from daemon: timed out waiting for the container to stop" >&2
      exit 1
    fi ;;
  *" container rm "*|*" rm -f "*)
    if [ -e "$HOME/flags/slow-rm" ]; then
      rm -f "$HOME/flags/slow-rm"
      /usr/bin/docker "$@"; code=$?
      printf '%s removed, now waiting\n' "$(date +%s.%N)" >> "$HOME/slow-rm.log"
      sleep 40
      exit $code
    fi ;;
esac
exec /usr/bin/docker "$@"
