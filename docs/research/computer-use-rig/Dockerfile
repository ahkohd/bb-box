# syntax=docker/dockerfile:1.7
# Local desktop rig for comparing computer-use tools. Not a bb-box template.
# See docs/research/computer-use.md. Build from this directory:
#   docker build -t bbbox-cu-rig .

FROM ubuntu:24.04 AS acli-build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config git \
      libdbus-1-dev libatspi2.0-dev libx11-xcb-dev libxcb1-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.95.0
ENV PATH=/root/.cargo/bin:$PATH
# accessibility-cli has no releases; pin the commit that was measured.
ARG ACLI_COMMIT=f64c036915095fbb9187b6fdf0f039879618a159
RUN git clone https://github.com/DioxusLabs/accessibility-cli.git /src \
 && git -C /src checkout --detach "$ACLI_COMMIT"
COPY acli-no-getall.patch /tmp/
WORKDIR /src
# Build it as released, then with the patch that stops Chrome crashing on the
# first tree read (see "accessibility-cli on Linux" in the research doc).
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p accessibility-cli \
 && cp target/release/accessibility-cli /usr/local/bin/accessibility-cli \
 && git apply /tmp/acli-no-getall.patch \
 && cargo build --release -p accessibility-cli \
 && cp target/release/accessibility-cli /usr/local/bin/acli-patched

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl sudo python3 python3-pil procps iproute2 \
      dbus dbus-x11 dbus-user-session \
      tigervnc-standalone-server tigervnc-tools xfce4-session xfwm4 xfce4-panel \
      xfdesktop4 xfce4-terminal xfconf xfce4-settings xauth \
      x11-xserver-utils x11-utils xinput xterm xdotool wmctrl xclip xsel \
      fonts-dejavu-core fonts-liberation arc-theme at-spi2-core thunar mousepad \
      gnome-calculator ffmpeg scrot python3-gi gir1.2-atspi-2.0 \
      libatspi2.0-0t64 libdbus-1-3 libx11-xcb1 \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb
# Chrome builds a page's accessibility tree only with this flag. --no-sandbox
# is for this Docker rig only.
RUN dpkg-divert --local --rename --divert /usr/bin/google-chrome-stable.real --add /usr/bin/google-chrome-stable \
 && printf '#!/bin/sh\nexec /usr/bin/google-chrome-stable.real --force-renderer-accessibility --no-sandbox --no-first-run --no-default-browser-check --password-store=basic "$@"\n' \
      > /usr/bin/google-chrome-stable && chmod 755 /usr/bin/google-chrome-stable
# Cua Driver release binaries, checked against the release's SHA256 list.
ADD --checksum=sha256:51de56e37e1e57cca613cff06e22a3c64bf8285ed97e518660f3d1cb2a4e6fcf \
    https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.3/cua-driver-rs-0.28.3-linux-x86_64-binary.tar.gz \
    /tmp/cua-0.28.3.tgz
ADD --checksum=sha256:fff2016e0dea320df9be3aa52fc942c4ea4ca651df32cf3e950119bbc3097d29 \
    https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.4/cua-driver-rs-0.30.4-linux-x86_64-binary.tar.gz \
    /tmp/cua-0.30.4.tgz
RUN mkdir -p /opt/cua-0.28.3 /opt/cua-0.30.4 \
 && tar xzf /tmp/cua-0.28.3.tgz -C /opt/cua-0.28.3 \
 && tar xzf /tmp/cua-0.30.4.tgz -C /opt/cua-0.30.4 \
 && rm /tmp/cua-*.tgz
COPY --from=acli-build /usr/local/bin/accessibility-cli /usr/local/bin/acli-patched /usr/local/bin/
RUN userdel -r ubuntu && useradd -m -u 1000 -s /bin/bash agent
COPY files/start-desktop files/restart-chrome files/acli-bench files/mcpc.py \
     files/cua_bench.py files/cua_bench2.py files/gtk_bench.py /usr/local/bin/
COPY files/desktop-env /etc/profile.d/desktop-env.sh
COPY files/web /srv/web
CMD ["/usr/local/bin/start-desktop"]
