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
RUN BBBOX_ENV=/nonexistent BBBOX_BB_URL= bash /src/template/fetch-artifacts.sh /artifacts linux

FROM fetch AS fetch-desktop
RUN BBBOX_ENV=/nonexistent BBBOX_BB_URL= bash /src/template/fetch-artifacts.sh /artifacts desktop-cpu

# BB's host app from BB's server, to pre-install it, so a box enrols without
# downloading it. Empty BB_URL: boxes download it when they enrol.
# BB_APP_SHA256 is the app's digest on the server, which build.sh reads: a new
# build of BB's app changes it, so the build fetches and installs the new app,
# and what comes before stays cached (#95).
FROM fetch AS app
ARG BB_URL=
ARG BB_APP_SHA256=
RUN mkdir /app && if [ -n "$BB_URL" ]; then \
      curl -fsS -D /app/bb-app.headers -o /app/bb-app.tgz "${BB_URL%/}/install/bb-app.tgz" && \
      { echo "$BB_APP_SHA256  /app/bb-app.tgz" | sha256sum -c --quiet - || { \
        echo "BB's app on $BB_URL is not the build $BB_APP_SHA256 that build.sh read: build again" >&2; exit 1; }; }; \
    fi

# Each image is one layer from Ubuntu's, then one with BB's app: customize.sh
# runs the guest scripts and finalize.sh together, so what finalize.sh removes
# takes no room. The app's layer comes last, as it changes with each build of
# BB's app, and bbbox.bb-app says which build it has, for the plugin to see.
FROM ${UBUNTU} AS linux
RUN --mount=type=bind,source=proxmox-lxc/template,target=/mnt/template \
    --mount=type=bind,source=docker/customize.sh,target=/mnt/customize.sh \
    --mount=type=bind,from=fetch,source=/artifacts,target=/mnt/artifacts \
    --mount=type=bind,from=fetch,source=/etc/ssl/certs/ca-certificates.crt,target=/mnt/ca-certificates.crt \
    bash /mnt/customize.sh linux
ARG BB_URL=
ARG BB_APP_SHA256=
RUN --mount=type=bind,source=proxmox-lxc/template/guest/install-bb-app.sh,target=/mnt/install-bb-app.sh \
    --mount=type=bind,from=app,source=/app,target=/mnt/app \
    if [ -n "$BB_URL" ]; then \
      bash /mnt/install-bb-app.sh box "$BB_URL" /mnt/app && rm -rf /home/box/.npm /home/box/.cache /tmp/*; \
    fi
COPY --chmod=0755 docker/start /usr/local/sbin/bb-box-start
LABEL bbbox.image-version="1" bbbox.bb-app="$BB_APP_SHA256"
CMD ["/usr/local/sbin/bb-box-start"]

FROM ${UBUNTU} AS desktop
RUN --mount=type=bind,source=proxmox-lxc/template,target=/mnt/template \
    --mount=type=bind,source=docker/customize.sh,target=/mnt/customize.sh \
    --mount=type=bind,from=fetch-desktop,source=/artifacts,target=/mnt/artifacts \
    --mount=type=bind,from=fetch,source=/etc/ssl/certs/ca-certificates.crt,target=/mnt/ca-certificates.crt \
    bash /mnt/customize.sh desktop
ARG BB_URL=
ARG BB_APP_SHA256=
RUN --mount=type=bind,source=proxmox-lxc/template/guest/install-bb-app.sh,target=/mnt/install-bb-app.sh \
    --mount=type=bind,from=app,source=/app,target=/mnt/app \
    if [ -n "$BB_URL" ]; then \
      bash /mnt/install-bb-app.sh box "$BB_URL" /mnt/app && rm -rf /home/box/.npm /home/box/.cache /tmp/*; \
    fi
COPY --chmod=0755 docker/start /usr/local/sbin/bb-box-start
COPY --chmod=0755 docker/gpu-bus-id /usr/local/libexec/bb-box/gpu-bus-id
LABEL bbbox.image-version="1" bbbox.bb-app="$BB_APP_SHA256"
CMD ["/usr/local/sbin/bb-box-start"]
