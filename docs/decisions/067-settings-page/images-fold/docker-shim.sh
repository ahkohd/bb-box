#!/bin/sh
case " $* " in
  *" build "*bb-live/fails*)
    echo "ERROR: failed to solve: process \"/bin/sh -c apt-get install -y build-essential\" did not complete successfully: exit code: 100" >&2
    exit 1 ;;
esac
exec /usr/bin/docker "$@"
