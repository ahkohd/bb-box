#!/bin/sh
# A stand-in for a whole-machine reset, for the test rig only: it removes
# what boxes left in Docker and in the temporary directories. A real
# whole-machine reset restores everything a box could change as root; see
# the setup guide.
set -u
docker ps -aq | xargs -r docker rm -f >/dev/null
docker system prune -af --volumes >/dev/null
find /tmp /var/tmp /dev/shm -mindepth 1 -delete 2>/dev/null
exit 0
