# 016: Changes from building Interface v1

Status: accepted, 30 September 2026. Partly supersedes
[009](009-conformance-suite-and-doctor.md) and
[011](011-interface-v1.md).

## Context

Interface v1 with [012](012-offers-may-add-features.md) and
[013](013-docker-boxes-run-unprivileged.md) is built and passes 192 tests
against the fake backend and a fake Proxmox API. The build found five places
where the design did not fit or said too little:

| Point | What the build found |
| --- | --- |
| Jump host | OpenSSH's `ProxyJump` drops `-i` and the `-o` options for the jump hop, so each hop cannot have its own key and known_hosts file. |
| A fresh guest's first key | Recording it needs a key scan on first connect. It protects nothing the operator asked for. |
| Setup | A driver named one setup script and a guide. The Proxmox LXC setup has four scripts (host, network, API token, template build), and its guide says which to run and when. |
| Stale releases | A real pool machine outlives its box. A repeated release of an old box must not reset the machine the next box holds. |
| Facts about a box | `Guest.data` is for the backend and is not shown. A desktop's display mode, and why, had nowhere to go but an error message. |

## Decision

- **Jump host.** The SSH transport reaches a jump host with `ProxyCommand`
  (`ssh <options for the jump> -W %h:%p`), so each hop has its own options.
  A nested jump escapes `%` for the next `ssh`.
- **First keys.** A guest with no known host keys is reached with
  `StrictHostKeyChecking=no` and an empty known_hosts file. Its key is not
  recorded. Pinned keys are checked as before, on both hops.
- **Setup.** A driver names a guide and a list of scripts:
  `setup: { guide: string; scripts: readonly string[] }`. The guide is the
  entry point. The settings page links it first, then the scripts in the
  order the guide runs them. The list may be empty.
- **Stale releases.** A real backend keeps the pool member's generation in
  `Guest.data.generation`. `release` does nothing when the machine's stored
  generation has moved on.
- **Facts.** `Guest` gains
  `facts?: readonly { label: string; value: string }[]`, short facts the
  backend wants you to see, such as a desktop's display mode and its
  reason. `status` and the panel show them in order. Like `data`, facts are
  stored with the box and are never a secret.

## Consequences

- The core names no SSH option in the interface. `SshAccess` is unchanged.
- A fresh guest's key is never checked. That is acceptable on the
  operator's own network, where bb-box's boxes run.
- Setup scripts can be split as a backend needs, and a backend with nothing
  to run still has a guide.
- Releases stay safe to repeat on real pools, as
  [004](004-acquire-and-release.md) requires.
- A backend can explain a box without failing it. Errors stay for boxes that
  cannot be used.
