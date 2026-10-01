# Pool machines for testing the SSH host pool on one computer with Docker.
# "plain" runs only sshd, with no systemd. "systemd" boots systemd, with
# Docker, and needs --privileged. Host keys are made when a container starts,
# so each machine has its own.
FROM debian:bookworm AS plain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server sudo procps cron at curl ca-certificates util-linux passwd findutils tar \
  && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
  && mkdir -p /run/sshd
CMD ["sh", "-c", "ssh-keygen -A >/dev/null && exec /usr/sbin/sshd -D -e"]

FROM plain AS systemd
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus libpam-systemd docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service \
    sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
  && printf '[Unit]\nDescription=SSH host keys\nBefore=ssh.service\nConditionPathExists=!/etc/ssh/ssh_host_ed25519_key\n[Service]\nType=oneshot\nExecStart=/usr/bin/ssh-keygen -A\n[Install]\nWantedBy=multi-user.target\n' >/etc/systemd/system/ssh-host-keys.service \
  && systemctl enable ssh-host-keys.service ssh.service docker.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
