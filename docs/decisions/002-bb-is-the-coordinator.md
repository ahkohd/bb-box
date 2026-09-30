# 002: BB is the coordinator

Status: accepted, 30 September 2026.

## Context

Giving agents machines usually needs a control plane: auth, a scheduler, an
API, a web portal and a relay for desktops. BB already has most of this for
its threads.

## Decision

bb-box is a BB plugin with no service of its own.

- BB provides:
  - auth, threads, events and agent tools;
  - the panel and settings page;
  - HTTP and WebSocket routes;
  - plugin storage;
  - machine enrolment.
- The plugin calls each backend directly from the BB server.
- A box that can enrol becomes an ordinary BB machine. That is how it gets the
  thread's Git credentials and machine variables, and how a child thread can
  run on it.
- There is no separate coordinator, adapter, relay or portal to deploy.

## Consequences

- Setting up bb-box means installing a plugin and configuring a backend.
- The BB server must reach each backend's API and each box's transports. A
  backend whose boxes are not directly reachable composes a transport that
  tunnels, for example SSH through a jump host.
- bb-box depends on BB's plugin API, including experimental parts (WebSocket
  routes, machine providers). When bb-box needs something BB lacks, it asks
  BB for it rather than building around it.
- Desktop streams pass through the BB server, so its network and CPU carry
  them.
