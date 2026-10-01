# 012: A kind names what it promises, and offers may add features

Status: accepted, 30 September 2026. Partly supersedes
[011](011-interface-v1.md). Partly superseded by
[027](027-a-kind-says-when-it-has-a-desktop.md): the kinds without a desktop
are `linux` and `linux-docker`.

## Context

Interface v1 says the offers of one kind must agree on `docker` and
`features`. Reviewing it against the later backends showed this is too
strict:

- An unprivileged Docker box cannot run Docker inside it
  ([013](013-docker-boxes-run-unprivileged.md)), and an LXC box can. With
  exact agreement they cannot offer the same headless kind, so an agent that
  does not need Docker is limited to one backend.
- An SSH pool machine may have more installed than any template. Exact
  agreement would force a new kind for each difference.

v1 also left two names for one thing: the capability's `transport` and the
built transport's `kind`.

## Decision

- A kind lists the features it requires, in `BoxKind.requires`, which every
  offer of the kind must give the same. Each offer's `features` must include
  them, and may add more. `doctor` warns otherwise.
- The box records its offer's full list, and the panel and `status` show the
  extra features for each box. The agent can rely on the required ones only.
- Docker inside a box becomes the feature `docker`, and the `docker`
  capability is dropped.
- A kind ID names what the kind promises, never what it lacks, since an offer
  may have more. The default kinds are the ones most backends can offer.
- `gpu` still has to agree exactly: a GPU is scarce, so a box without one
  must not take one.
- `CommandTransport` drops `kind`. The capability's `transport` is the one
  name.

The first kinds:

| Kind | Promises | Offered by |
| --- | --- | --- |
| `linux-headless` | Linux, no GPU | Proxmox LXC, Docker, an SSH pool machine |
| `linux-headless-docker` | as above, plus `docker` | Proxmox LXC (`nesting=1`), Docker when privileged |
| `linux-desktop` | a Linux desktop with a GPU | Proxmox LXC on a GPU host, Docker with NVIDIA's container toolkit |
| `linux-desktop-cpu` | a Linux desktop without a GPU | Docker, an SSH pool machine, Proxmox LXC on a host with no GPU |

## Consequences

- Other agreements from 011 stay exact: `os`, `arch`, `gpu`, `computerUse`,
  `enrol` and having a desktop display.
- An agent that needs Docker, Xcode or anything else asks for a kind that
  requires it, rather than hoping an offer has it.
- Proxmox LXC offers both headless kinds from one template, and its desktop
  kind keeps its ID.
