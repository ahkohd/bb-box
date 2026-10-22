# Mac boxes on Namespace

Namespace rents Macs by the minute. With a Namespace backend, each Mac box is a Mac of its own that BB Box makes in Namespace when a thread asks for one, and destroys when the box is released. You need no Mac of your own.

This page sets it up from a new Namespace workspace. It was first done on 22 October 2026.

## What it costs

Namespace bills a Mac for every minute it exists, from when BB Box makes it until BB Box destroys it. Nothing is billed while you have no Mac boxes.

Namespace's prepaid prices on 22 October 2026, excluding tax:

| A box of | A minute | An hour |
| --- | --- | --- |
| 4 vCPU, 7 GB | $0.04 | $2.40 |
| 6 vCPU, 14 GB | $0.06 | $3.60 |

Larger Macs cost more: see Namespace's pricing page. Minutes beyond what you prepaid cost half as much again.

BB Box gives each box the smallest Mac Namespace offers that has at least the cores, memory and disk the box's size asks for. Namespace's Macs come in fixed shapes, so a box can have more than it asked for, and you pay for the Mac it gets.

### What your plan allows

Your Namespace plan sets 2 limits that matter here:

- **How long a Mac can live**: 3 hours on Developer, 5 on Team, up to 24 on Business. A box ends then, whatever it is doing. Its thread hears an hour before, and the Box panel shows when it ends.
- **How many Mac cores you can have at once**: 12 on Developer. Namespace's trial allowed 6, which is one box of 6 vCPU. When you have as many as your plan allows, a thread that asks for another Mac box is told there is no room.

BB Box also has its own limit, **Most machines**, which is 2 by default.

## Before you start

You need:

- a Namespace workspace for BB Box, made at namespace.so. Use one that runs nothing else, so what BB Box makes is easy to see
- a computer with a terminal, to make the token in step 2
- a way for the Macs to reach BB's server: if BB is on a Tailscale tailnet, [set BB Box up to join them to it](tailnet.md); otherwise BB's server needs a URL they can reach, such as bb Connect

## Set it up

### 1. Install Namespace's command line, and sign in

```sh
curl -fsSL https://get.namespace.so/cloud/install.sh | sh
nsc login
```

`nsc login` opens Namespace in your browser. Sign in, and choose the workspace for BB Box.

### 2. Make a token for BB Box

BB Box uses a token that can only make, find, extend, reach and destroy machines. Make it with:

```sh
nsc token create \
  --name bb-box \
  --description "BB Box's Mac boxes" \
  --expires_in 8760h \
  --grant '{"resource_type":"instance","resource_id":"*","actions":["create","destroy","get","list","refresh","wait","ssh","exec","dial_host","suspend","resume"]}'
```

It prints the token once. Keep it for step 4, and do not save it anywhere else. The token lasts a year, the longest Namespace allows. Make a new one before then.

### 3. Choose where the Macs run

Namespace puts a workspace's Macs where its regional preference says. You cannot choose a place for each Mac. On 22 October 2026, a new workspace's Macs ran in Namespace's sites in the eastern US.

If BB's server is in Europe and you want the Macs near it, ask Namespace's support to set the workspace's regional preference to Europe. Boxes work from either continent. A box's details say on which continent it runs.

### 4. Add the backend to BB Box

1. In BB Box's settings, find **Namespace** under **Backends** and select **Set up**.
2. Paste the token from step 2 into **API token**.
3. Set **API region** to `eu` if BB's server is in Europe, or leave it as `us`. It only says which of Namespace's API addresses BB Box calls.
4. Set **Longest life (hours)** to your plan's limit: 3 on Developer, 5 on Team.
5. Set **Most machines** to how many Mac boxes you are willing to pay for at once.
6. Select **Save**, and turn the backend on.

The token is kept as a secret. BB Box's settings show only that it is set.

### 5. Turn on the kinds

Under **Kinds**, turn on:

- **macOS**, for Mac boxes you use through a terminal
- **macOS desktop**, for Mac boxes whose desktop you can watch and use

## Check it works

```sh
bb box doctor
```

The doctor checks that Namespace accepts the token, and lists the Macs BB Box has there, each with when it ends. If you turned the tailnet on, it checks the tailnet too.

Then make a Mac box from the Box panel, or ask an agent to.

## What a box is like

A box is a Mac virtual machine on Apple silicon, with macOS 26. You use it as `runner`, who is an administrator and can use `sudo`. Xcode and Homebrew are installed.

A Mac is ready about 20 seconds after BB Box asks for it. BB Box then gets it ready for its kind:

- a **macOS desktop** box builds BB Box's video helper with the Mac's Xcode, lets it and Screen Sharing see and control the screen, and keeps the display awake. You can watch its desktop over Screen Sharing or as video
- with the tailnet on, it joins the tailnet as `bb-box-ns-`, then the install's ID and the box's name

When the box is released, BB Box takes it off the tailnet and destroys the Mac. Nothing on it is kept.

A Mac cannot outlive your plan's limit. BB Box keeps each Mac's end an hour ahead while its box is held, up to that limit, so a Mac that BB Box loses track of ends within the hour.

## Check that nothing is left running

BB Box labels every Mac it makes. To list every Mac in the workspace:

```sh
nsc list --all
```

Without `--all`, `nsc list` leaves out machines made through the API, which is how BB Box makes them.

Each Mac listed should be a box in BB Box's Boxes page. BB Box checks its backends every few minutes, and destroys a Mac whose box has gone once BB says the box's thread has ended. `bb box doctor` lists any Mac no box claims. If one stays, destroy it with `nsc destroy` followed by its ID.

With the tailnet on, the Macs show in Tailscale's admin console, under **Machines**, with the tag `tag:bb-box`. BB Box removes any it no longer has within 15 minutes.

## Turn it off

1. Release the Mac boxes.
2. Turn the Namespace backend off in BB Box's settings. Boxes it already has keep working until they are released.
3. Check that `nsc list --all` lists nothing of BB Box's.
4. Revoke the token. `nsc token list` shows its ID:

   ```sh
   nsc token revoke --token_id <ID>
   ```

Once the token is revoked, BB Box cannot make Macs, and Namespace bills for nothing more.
