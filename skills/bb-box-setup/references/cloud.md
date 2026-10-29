# Cloud backends: Hetzner Cloud, Namespace and boat.dev

These need no machine of the person's own. They cost money while a host or
box exists, so ask before you turn one on, and tell the person the limits
you set. Each needs an API token from the person's account: get it with
`bb secret request`, never in a message or on a command line. Never sign
the person up for an account; ask them to.

Their machines must reach BB's server. When BB is on a Tailscale tailnet,
set up the tailnet first (SKILL.md, Options); otherwise BB's server needs a
URL they can reach, such as bb connect's.

## Hetzner Cloud

bb-box rents Docker hosts by the hour as Linux boxes need them, and deletes
them after `idle-minutes`. It makes `linux`, `linux-desktop-cpu` and
`linux-desktop-wayland-cpu`, and with `arm-server-type` the arm64 kinds.
The guide is `docs/guide/hetzner.md`.

Ask the person to make a Hetzner Cloud project for bb-box alone, a **Read &
Write** API token in it, and a cost alert under Usage. Ask how much a month
they will spend, and which location is nearest BB's server: `nbg1`, `fsn1`
or `hel1` in western Europe.

```sh
bb secret request HCLOUD_TOKEN --write-env "$BB_THREAD_STORAGE/bb-box.env" \
  --purpose "bb-box rents Hetzner Cloud hosts for Linux boxes" \
  --describe HCLOUD_TOKEN="Read & Write API token of the bb-box project"
grep '^HCLOUD_TOKEN=' "$BB_THREAD_STORAGE/bb-box.env" | \
  bb box backend add hetzner --secret token=HCLOUD_TOKEN --secrets-stdin \
    --field location=nbg1 --field most-hosts=2 --field monthly-limit-eur=20
```

- `most-hosts` (2), `monthly-limit-eur` (20) and `idle-minutes` (30) keep
  the cost down. A new account may have only 20 vCPUs: a CPX42 host takes 8.
- The first host image takes 10 to 30 minutes to build after the backend
  turns on. A box before then waits about 6 minutes for a host.
- Prove it with `bb box acquire linux --on hetzner`, then release it. The
  host stays for `idle-minutes`, and is billed by the started hour.

To use a server the person rents and runs themselves, make it a BB machine
and use Docker on it instead: `docs/guide/cloud-docker-host.md`, then `bb
box setup docker --machine <name>`.

## Namespace

Each box is a machine of its own, billed by the minute: Macs for `macos` and
`macos-desktop`, and Linux. A Mac ends at the plan's longest life whatever
happens. The guide is `docs/guide/namespace.md`.

The person makes a Namespace workspace for bb-box, installs `nsc`, signs in
with `nsc login`, and makes a token with the grants the guide gives
(`nsc token create --name bb-box ...`). The token is printed once: they give
it to you through `bb secret request`, not by pasting it in the thread.

```sh
bb secret request NSC_TOKEN --write-env "$BB_THREAD_STORAGE/bb-box.env" \
  --purpose "bb-box makes Namespace machines for boxes" --describe NSC_TOKEN="The Bearer Token nsc token create printed"
grep '^NSC_TOKEN=' "$BB_THREAD_STORAGE/bb-box.env" | \
  bb box backend add namespace --secret token=NSC_TOKEN --secrets-stdin \
    --field region=us --field longest-life-hours=3 --field machines=2
```

`region` is `eu` when BB's server is in Europe. `longest-life-hours` is the
plan's limit: 3 on Developer, 5 on Team. `machines` is the most boxes, Mac
and Linux together, at once. Prove it with `bb box acquire macos --on
namespace`, ready in about 20 s, and release it.

## boat.dev

Each box is a boat.dev sandbox, a Linux VM with KVM, billed by the second.
It makes `linux`. bb-box keeps a stopped template sandbox, which takes about
6 minutes to build. The guide is `docs/guide/boat.md`.

The person makes an API key, starting `boat_`, in boat.dev's dashboard or
with `boat api-key create bb-box`, with a long life or none.

```sh
bb secret request BOAT_API_KEY --write-env "$BB_THREAD_STORAGE/bb-box.env" \
  --purpose "bb-box makes boat.dev sandboxes for boxes" --describe BOAT_API_KEY="An API key starting boat_"
grep '^BOAT_API_KEY=' "$BB_THREAD_STORAGE/bb-box.env" | \
  bb box backend add boat --secret api-key=BOAT_API_KEY --secrets-stdin --field most-boxes=2
```

A plain `linux` box goes to boat.dev only when no other backend has room.
Prove it with `bb box acquire linux --on boat`, and release it.

## After each

`bb box doctor` checks the token, the limits and what bb-box has made there.
Each guide has a "Check that nothing is left running" section: bb-box labels
what it makes with its install ID, which `bb box install-id` shows.
