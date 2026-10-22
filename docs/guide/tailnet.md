# Joining cloud machines to your tailnet

BB Box can rent machines for your boxes, such as Macs from Namespace or servers from Hetzner Cloud. Each machine, and each box on it, must reach your BB server. If your BB server is on a Tailscale tailnet, each machine joins the tailnet as it starts and leaves it when its box goes. This page sets that up.

You do this once. It takes about 10 minutes, in two places: Tailscale's admin console, and BB Box's settings.

## Before you start

You need:

- to be an Owner, Admin, Network admin or IT admin of the tailnet in Tailscale
- BB Box installed, with its settings open in BB

If your BB server is not on a tailnet, you do not need any of this: see [when BB is not on a tailnet](#when-bb-is-not-on-a-tailnet).

## How it works

You give BB Box a Tailscale OAuth client. For each machine it starts, BB Box uses the client to make a key that:

- works once, for that one machine
- expires after 10 minutes if it is not used
- joins the machine already approved, so nobody has to approve it
- marks the machine with a tag, `tag:bb-box`, so your tailnet policy decides what it may reach
- makes the machine ephemeral, so Tailscale removes it soon after it goes offline

The key reaches the machine over an encrypted connection. It is never written in a log or shown on a page. When the box is released, the machine logs out of the tailnet before it is deleted.

## 1. Add the tag to your tailnet policy

In Tailscale's admin console, go to **Access controls**. In the policy file, add `tag:bb-box` under `tagOwners`, owned by your admins:

```json
"tagOwners": {
  "tag:bb-box": ["autogroup:admin"],
},
```

If `tagOwners` is already there, add only the `"tag:bb-box"` line to it.

If your policy is still Tailscale's default, which lets every device reach every other, it needs no rule. If you have written your own rules, add two:

- `tag:bb-box` reaches your BB server, on the port BB uses
- your BB server reaches `tag:bb-box` on port 22, which bb-box uses to reach its cloud machines over SSH, such as the Docker hosts the Hetzner backend makes

Select **Save**.

## 2. Make the OAuth client

Still in the admin console, go to **Settings**, then **Trust credentials**.

1. Select **Credential**, then **OAuth**.
2. Choose these two operations, each with **Write**, and give each the tag `tag:bb-box`:
   - the `auth_keys` operation, under Keys: BB Box makes the key for each machine with it.
   - the `devices:core` operation, under Devices: BB Box finds and removes the devices of machines that went without logging out.
3. Add a description, such as "BB Box".
4. Select **Generate credential**.

Tailscale shows the client's ID and its secret. Keep the page open: the secret is shown only once.

## 3. Enter it in BB Box

In BB, open BB Box's settings, and find the **Tailnet** part.

1. For **Join machines to the tailnet**, choose **Yes, with a Tailscale OAuth client**.
2. Leave **Tags** as `tag:bb-box`, unless you chose another tag in step 1.
3. Paste the client's ID into **OAuth client ID**, and its secret into **OAuth client secret**.
4. Select **Save**.

The fields then show **Set**. BB Box never shows them again. You can now close Tailscale's page.

## 4. Check it

In a terminal on a computer with BB, run:

```sh
bb box doctor
```

Under **Tailnet**, the doctor should say:

- **OAuth client**: Tailscale signs the client in, with the tags machines join with.
- **Devices**: how many devices on the tailnet have the tag. This is none until BB Box starts a machine.

If **OAuth client** fails, check the ID and secret, and that the client has the `auth_keys` operation with the tag. If **Devices** warns, give the client the `devices:core` operation too.

## Replacing or revoking the client

To replace the client, make a new one as in step 2, enter it as in step 3, and then revoke the old one.

To revoke a client, go to **Settings**, then **Trust credentials**, in Tailscale's admin console, and revoke it there. Then:

- BB Box cannot make keys any more, so new cloud machines cannot join the tailnet, and their boxes fail to start with the reason. The doctor says so.
- Machines that already joined stay on the tailnet, as their keys were used when they joined. They leave when their boxes are released, as before.
- Until you enter a new client, BB Box cannot remove the devices of machines that went without logging out. Tailscale still removes them, as they are ephemeral.

## When BB is not on a tailnet

If your BB server is reached through bb Connect, or at a public address, machines do not need to join a tailnet. In the **Tailnet** part of BB Box's settings, choose **No: BB is reached without one**, and select **Save**.

## Next

Set up the cloud machines themselves, such as [a cloud server as a Docker host](cloud-docker-host.md).
