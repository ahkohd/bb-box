# bb-box's images for the Docker backend: a linux image and a desktop image,
# made by the same guest scripts as the Proxmox LXC templates
# (setup/proxmox-lxc/template/guest), with BOX_RUNTIME=docker. build.sh builds
# them, with setup/ as the context; see README.md.

# Ubuntu 24.04, pinned, and no newer than the apt snapshot
# (proxmox-lxc/template/apt-snapshot): the build applies the snapshot's
# updates, and apt does not take a package back to an older version.
ARG UBUNTU=ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

# The artifacts the guest scripts install, each checked against its pinned
# SHA-256, as fetch-artifacts.sh does on a Proxmox host.
FROM ${UBUNTU} AS fetch
RUN apt-get update -q && apt-get install -y -q --no-install-recommends ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*
COPY proxmox-lxc/host/common.sh /src/host/
COPY proxmox-lxc/template/fetch-artifacts.sh proxmox-lxc/template/pins.json proxmox-lxc/template/desktop-pins.tsv /src/template/
# BB's server URL, to pre-install BB's host app, so a box enrols without
# downloading it. Empty: boxes download it when they enrol.
ARG BB_URL=
RUN BBBOX_ENV=/nonexistent BBBOX_BB_URL="$BB_URL" bash /src/template/fetch-artifacts.sh /artifacts linux

FROM fetch AS fetch-desktop
RUN BBBOX_ENV=/nonexistent BBBOX_BB_URL= bash /src/template/fetch-artifacts.sh /artifacts desktop-cpu

# Each image is one layer from Ubuntu's: customize.sh runs the guest scripts
# and finalize.sh together, so what finalize.sh removes takes no room.
FROM ${UBUNTU} AS linux
ARG BB_URL=
RUN --mount=type=bind,source=proxmox-lxc/template,target=/mnt/template \
    --mount=type=bind,source=docker/customize.sh,target=/mnt/customize.sh \
    --mount=type=bind,from=fetch,source=/artifacts,target=/mnt/artifacts \
    --mount=type=bind,from=fetch,source=/etc/ssl/certs/ca-certificates.crt,target=/mnt/ca-certificates.crt \
    BB_URL="$BB_URL" bash /mnt/customize.sh linux
COPY --chmod=0755 docker/start /usr/local/sbin/bb-box-start
LABEL bbbox.image-version="1"
CMD ["/usr/local/sbin/bb-box-start"]

FROM ${UBUNTU} AS desktop
ARG BB_URL=
RUN --mount=type=bind,source=proxmox-lxc/template,target=/mnt/template \
    --mount=type=bind,source=docker/customize.sh,target=/mnt/customize.sh \
    --mount=type=bind,from=fetch-desktop,source=/artifacts,target=/mnt/artifacts \
    --mount=type=bind,from=fetch,source=/etc/ssl/certs/ca-certificates.crt,target=/mnt/ca-certificates.crt \
    BB_URL="$BB_URL" bash /mnt/customize.sh desktop
COPY --chmod=0755 docker/start /usr/local/sbin/bb-box-start
LABEL bbbox.image-version="1"
CMD ["/usr/local/sbin/bb-box-start"]
