# 055: Cloud boxes run on cloud hosts first, and a cloud VM per box later

Status: accepted, 7 October 2026. Reviewed on 22 October 2026 against
BB 0.46.0 and that day's code: see [Since 7 October](#since-7-october), and
the plan for steps 1 and 2 in [Cloud hosts](../research/cloud-hosts.md).
Research only: nothing is built, and no cloud account was used. Extends
[042](042-a-docker-host-can-be-a-bb-machine.md): a cloud VM is a Docker
host like any other; and
[053](053-microsandbox-runs-light-linux-boxes-as-microvms.md): a cloud
host with KVM runs microsandbox.

## Context

The operator wants boxes in a public cloud, and has Hetzner and AWS
accounts to test on. There are two ways to build it:

- **A. A cloud VM per box.** bb-box creates and deletes a server for each
  box through the provider's API: a Hetzner Cloud server or an EC2
  instance.
- **B. Cloud hosts for the backends we have.** A cloud VM or bare-metal
  server runs Docker or microsandbox, and bb-box places boxes on it as it
  does on any Docker or microsandbox host. What is new is making, sizing
  and removing the hosts.

What the providers give, from their documentation and price lists on
7 October 2026 (prices excluding VAT; Hetzner's in Germany and Finland
after its change of 15 June 2026, AWS's in us-east-1). Hetzner's were read
again on 22 October 2026: Hetzner now shows them with a public IPv4
included, and they are 055's figures with its EUR 0.50 a month added. AWS's
were not read again.

| | Hetzner Cloud | Hetzner dedicated (AX) | AWS EC2 |
| --- | --- | --- | --- |
| Billing | hourly, capped at a monthly price | monthly, and a setup fee | per second, after the first minute |
| A stopped server | billed in full until deleted | billed | instance free; its disk and Elastic IPs billed |
| KVM in the guest | no: "not possible on cloud server" | yes, bare metal | C7i, M7i, R7i, C8i, M8i, R8i and kin with `CpuOptions` `NestedVirtualization=enabled`, since February 2026, at no extra cost; or `.metal` |
| Create to SSH | about 15 to 30 s | ordered through the Robot API; delivery not immediate | about 7 s to running, 12 to 15 s to SSH on a stock image |
| Small box: 2 vCPU, 4 GB | CX23 EUR 0.0088/h (EUR 5.49 a month); with its IPv4, EUR 0.0096/h (EUR 5.99). Out of stock on 22 October: CPX22 EUR 0.032/h with its IPv4 | | t3.medium $0.0416/h; c7i.large $0.089/h |
| Desktop box: 4 vCPU, 8 GB | CX33 EUR 0.0136/h; with its IPv4, EUR 0.0144/h. CPX32 EUR 0.0577/h with its IPv4 | | c7i.xlarge $0.179/h |
| A host | CX53, 16 vCPU, 32 GB: EUR 0.0473/h; with its IPv4, EUR 0.0481/h (EUR 29.99 a month). CX43, 8 vCPU, 16 GB, 160 GB: EUR 0.0264/h with its IPv4. With no CX in stock: CPX42, 8 vCPU, 16 GB, 320 GB, EUR 0.1122/h; CPX62, 16 vCPU, 32 GB, EUR 0.2091/h | AX42, 8 cores, 64 GB: EUR 97.30 a month and EUR 49 setup | m7i.2xlarge, 8 vCPU, 32 GiB: $0.403/h ($0.174 spot); c7i.metal-24xl: $4.284/h |
| Public IPv4 | EUR 0.50 a month, now shown within each server's price | included | $0.005/h |
| Disk images | snapshots, EUR 0.0143 per GB-month, compressed | | AMIs: EBS snapshots, $0.05 per GB-month; root disks gp3 $0.08 per GB-month |
| Traffic out | 20 TB a month included (EU) | included | $0.09/GB after 100 GB a month |
| Spending limits | cost alerts only; the account has a resource limit that Hetzner raises on request | | Budgets, with actions that stop instances or apply a deny policy; vCPU quotas per family |
| API limits | 3,600 requests an hour per project, refilling one a second, with `RateLimit-*` headers; `resource_limit_exceeded` past the project's limits | Robot API | per action, with retries |
| Records on a server | labels, listed by label selector; server names unique in a project | | tags set at launch (`TagSpecifications`); `ClientToken` makes a launch idempotent |

From bb-box's own measurements: a Docker or microsandbox box is ready 0.3
to 0.7 s after it is asked for on a host that has room
([031](031-docker-boxes-are-reached-through-docker-exec.md),
[053](053-microsandbox-runs-light-linux-boxes-as-microvms.md)), and a box
enrols in BB about 5 s after it is ready.

## Decision

**Build B first, in two steps, then A only for what B cannot serve.**

1. **Hosts made by hand, now, with no new code.** A cloud VM that runs
   Docker and is a BB machine is a Docker host through BB's relay
   ([042](042-a-docker-host-can-be-a-bb-machine.md)): it needs no inbound
   port, and its boxes start in under a second. Where BB's server is
   reachable only on a tailnet, as it is for the operator's, the VM joins
   the tailnet first. A Hetzner CX or CCX server
   serves Docker boxes; an AWS C7i or M7i instance with nested
   virtualization, or a Hetzner AX server, serves microsandbox boxes too,
   once 053's backend is built. The setup guide gains a page for it.
2. **Hosts made by bb-box.** A cloud backend makes hosts through the
   provider's API from a host image, places boxes on them as the Docker
   and microsandbox backends do, and deletes a host that has had no box for
   a set time. Hetzner Cloud first, with Docker, as it is the cheaper and
   simpler API and has no KVM; then AWS, with Docker and microsandbox on
   instances with nested virtualization.
3. **A cloud VM per box, later**, for kinds a container or microVM on a
   host cannot give: Windows desktops (AWS's licensed Windows images), GPU
   desktops (AWS's GPU instances), and arm64 Linux where no arm64 host is
   running. Not before B is in use.

Why B first:

- **Speed.** A box on a running host is ready in under a second; a VM per
  box takes 15 to 40 s, and longer with our larger image and enrolment.
- **Fewer things to leak.** A few hosts carry many boxes, so the sweep
  watches hosts, not every box, and a leaked box on a host costs nothing
  extra.
- **One bill, shared.** Idle boxes share their host. Packing saves about a
  quarter at Hetzner's prices, where a CX23 per box costs EUR 0.0095/h and a
  share of a CX53 about EUR 0.007/h; at AWS's, a t3.medium per box is
  cheaper than a share of an m7i.2xlarge unless idle boxes are packed beyond
  their size (see Cost).
- **It reuses what works.** The Docker backend, its images and the relay
  through BB machines are built, and microsandbox is being built. A VM per
  box needs a new image pipeline for each provider.
- **It suits the operator's choice of microsandbox**, which needs KVM:
  only a host can give it on Hetzner, and nested virtualization does on
  AWS.

**Infrastructure as code stays out of the hot path.** bb-box creates and
deletes hosts and boxes by calling the provider's API itself, recording
the claim first and the owner on the server, as every backend does. A
state file would be a second record that can disagree with the provider's,
and would slow each call (see [The tools](#the-tools-opentofu-and-alchemy)).

- **For our tests: OpenTofu**, for the environment we create and destroy
  whole: the AWS security group and key pair, and a test host.
- **For users: neither is needed.** On Hetzner, bb-box needs only an API
  token: it makes its SSH key, firewall and images itself. On AWS, the one
  thing the account's owner must make is bb-box's IAM policy, which the
  setup guide gives as JSON, with an OpenTofu module beside it for those
  who use one.
- **Alchemy, not now.** It is TypeScript like bb-box, and has Hetzner and
  EC2 resources, but version 2 is in beta (its 81st), built on Effect, a
  programming model bb-box does not use, and needs the provider's API even
  to plan.

## How the two models compare

| | A: a VM per box | B: boxes on cloud hosts |
| --- | --- | --- |
| Time to a ready box | 15 to 40 s, plus enrolment | 0.3 to 0.7 s on a host with room, plus enrolment; a new host 30 s to a few minutes |
| Cost of a small box running | Hetzner EUR 0.0095/h with its IPv4; AWS t3.medium about $0.05/h with IPv4 and disk | a share of the host: Hetzner about EUR 0.007/h, AWS m7i.2xlarge about $0.058/h at its nominal size |
| Cost of a stopped box | Hetzner: the full price; AWS: its disk, about $0.003/h | nothing extra; the host costs the same |
| Cost at rest, with no boxes | nothing | the hosts kept, until bb-box deletes them |
| Images | a snapshot or AMI per provider, from our guest scripts | a host image with Docker, microsandbox and our OCI images loaded |
| Reaching BB | each box reaches BB's server; on a tailnet, each joins it | the host reaches BB, and its boxes reach it through the host |
| bb-box reaching boxes | SSH to each box's public address, or the tailnet | a host made by hand: as a BB machine, through BB (042). A host bb-box makes: one SSH connection over the tailnet, forwarding Docker's socket ([plan](../research/cloud-hosts.md#how-bb-box-reaches-a-host-it-made)). No inbound port either way |
| Desktops | RFB through SSH to the box | RFB through `docker exec` or `msb exec`, through BB |
| Tailscale (050) | each box joins, with a TUN device of its own | Docker boxes join through the host's TUN; microsandbox guests join, but reach peers through DERP (053) |
| Leaks | every box is a server to sweep | the hosts are the servers to sweep |
| What a user sets up | a token or IAM policy, and an image build | the same, and the host's type and how long an idle host lives |

### Time to a ready box

- **A.** Reviews report 15 to 30 s from create to SSH on Hetzner, and
  benchmarks 12 to 15 s on AWS with a stock image. Our image has more to
  start, and enrolment adds about 5 s. A warm VM would make it faster, but
  Hetzner bills a stopped server in full, so a warm VM costs its running
  price. On AWS a stopped warm instance costs only its disk; how fast it
  starts is to be measured.
- **B.** A box on a host with room is ready in 0.3 to 0.7 s. bb-box makes a
  new host before the last one fills, so an acquire waits for a host only
  when demand jumps.

### Cost

For a small box of 2 vCPU and 4 GB:

- **A on Hetzner**: CX23 at EUR 0.0088/h, and EUR 0.50 a month for its IPv4,
  about EUR 0.0095/h. A stopped one costs the same.
- **A on AWS**: t3.medium at $0.0416/h, burstable, plus $0.005/h for a
  public IPv4 and about $0.003/h for 30 GB of gp3, about $0.05/h. Stopped,
  only the disk.
- **B on Hetzner Cloud**: a CX53, 16 vCPU and 32 GB at EUR 0.0473/h, holds
  seven such boxes beside bb-box's 4 GiB reserve: about EUR 0.007/h a box,
  full.
- **B on AWS**: an m7i.2xlarge, 8 vCPU and 32 GiB with nested
  virtualization at $0.403/h, holds seven: about $0.058/h a box, full, or
  $0.025/h on spot. A c7i.metal-24xl at $4.284/h for about 45 boxes is no
  cheaper.
- **B on Hetzner dedicated**: an AX42 at EUR 97.30 a month, with KVM, holds
  about 14, about EUR 0.0095/h a box when full, but it is billed every hour of
  the month.

Packing saves real money only when idle boxes are packed beyond their
nominal size, as microsandbox allows: an idle box held 92 to 120 MiB in
053's spike. bb-box counts each box at its size today. Whether a cloud host
counts boxes at less than their size is for the backend's PRs to measure.

Desktops cost more on AWS than their instance: traffic out costs $0.09/GB,
and a desktop stream of 2 Mbit/s is about 0.9 GB an hour. Hetzner includes
20 TB a month.

### Images

- **A** needs a VM image per provider. Our guest scripts already build full
  VMs with systemd: the Proxmox LXC templates and Tart's Linux image. A
  build would start a server from Ubuntu 24.04, run them over SSH,
  finalize, and save a Hetzner snapshot or an AMI, as 049's rebuilds do on
  other backends. An AMI belongs to one region.
- **B** needs one host image per provider: Ubuntu with Docker,
  microsandbox where there is KVM, and our OCI images loaded, so a host
  starts ready. The OCI images are those the Docker backend builds today. A
  registry of our images would let a host pull them in seconds rather than
  build them.

### Reaching BB, and enrolment

A box enrols by reaching BB's server. When BB is on a private network or a
tailnet, a cloud machine must join it first.

- **A**: each box joins the tailnet as an ephemeral node (050), with a TUN
  device of its own.
- **B**: the host joins once, and its boxes reach BB through it: Docker
  boxes by the host's routes, microsandbox guests with
  `--net public,private`, as 053's spike found for a server on a
  100.64.0.0/10 address.

bb-box reaches a host made by hand, a BB machine, through BB, as 042 does,
with no inbound port. A host bb-box makes is not a BB machine: BB would list
it for threads, as root on the host, and BB's installer adds about a minute
to its start. bb-box reaches it over the tailnet instead, with one SSH
connection that forwards Docker's socket to BB's server (see the plan). A box of A is reached by SSH at its public address, with a
firewall that lets in only BB's server, which breaks when BB's address
changes, or over the tailnet.

### Desktops and VNC over a public network

No VNC port is ever open. The relay reaches a desktop through SSH (A) or
`docker exec` and `msb exec` through BB (B), as on every backend, and the
viewer's stream goes through BB's server. Latency is the region's
distance.

### Tailscale (050)

- **A**: each box joins with its own TUN device and public address, so
  connections are direct.
- **B with Docker**: a privileged box gets the host's TUN device, as 050
  plans for Docker hosts.
- **B with microsandbox**: a guest has TUN, but microsandbox's UDP relay
  sends Tailscale through DERP relays (053).

### Sweeping leaks

A leaked server costs money every hour, so a cloud backend follows the
rules every backend follows
([018](018-guests-name-their-install-and-box.md),
[019](019-lost-records-are-restored-from-guests.md)) and adds four:

- **The claim first, and an idempotent create.** bb-box records the server
  it is about to make before the call. On Hetzner the name is
  `bb-box-<box or host ID>`, unique in the project, so a retried create
  meets `uniqueness_error` and finds the first; on AWS the box or host ID is
  the launch's `ClientToken`.
- **Owner at the provider, from the create.** Labels on Hetzner, tags in
  `TagSpecifications` on AWS: the install, the box or host, and the time.
  The sweep lists by them and deletes what no record claims.
- **Delete, not stop.** A host with no box for its idle time is deleted. On
  AWS, a host's shutdown behaviour is `terminate`, so a host that bb-box has
  stopped hearing from can shut itself down after a set time.
- **The doctor counts them**, with each server's age and cost so far, and
  warns of any it does not know.

### Budget limits

Neither provider stops spending by itself, so bb-box keeps its own limits
and leans on the providers' where they have them:

- **bb-box**: the most hosts, or boxes for A, at once; the server types
  allowed; and an hourly spend limit, from the provider's prices
  (Hetzner's pricing API, or a figure in the configuration for AWS), past
  which acquires are refused with the reason.
- **Hetzner**: the account's resource limit, which Hetzner sets and
  raises on request, as a hard cap; a separate project for bb-box, so its
  token reaches nothing else; and cost alerts.
- **AWS**: a budget with an action that stops instances or applies a deny
  policy, the account's vCPU quotas, and an IAM policy that allows only
  some instance types.

### What a user sets up

- **B made by hand (step 1)**: a cloud VM with Docker, on the tailnet where
  BB's server is reachable only there, enrolled in BB, then "Docker on BB
  machines" in BB Box's settings. About 30 minutes, most of it bb-box
  building its images there, and it works today.
- **Hetzner, for steps 2 and 3**: a project and an API token with Read &
  Write, pasted into BB Box's settings, a location, and a way for hosts to
  join the tailnet: a Tailscale auth key, or an OAuth client that makes a
  one-off key for each host. bb-box makes its SSH key, firewall and images.
- **AWS, for steps 2 and 3**: an IAM user or role with bb-box's policy, its
  keys in BB Box's settings unless BB runs on EC2 with a role, a region, and
  the default VPC or a subnet. bb-box makes its security group, key pair
  and images. New accounts may need a larger vCPU quota.

## The tools: OpenTofu and Alchemy

Both were run on 7 October 2026 in a scratch folder, against configurations
with a Hetzner SSH key, firewall and server, and an AWS budget and security
group, with no real credentials:

| | OpenTofu 1.13.1 | Alchemy 2.0.0-beta.81 |
| --- | --- | --- |
| Install | one binary, 109 MB; `init` fetched the hcloud and aws providers, 815 MB, in 8.3 s | `npm install`, 1.4 GB in `node_modules`, with SDKs for 16 providers, in 16 s |
| Plan of new resources | 1.65 s, with no API call | 1.3 s; it calls the API to plan, and failed on the bad token |
| State | a state file, locked while in use | a state store: local, Postgres, HTTP, AWS or Cloudflare |
| Hetzner | Hetzner's own provider | `Server`, `Firewall`, `Network`, `SshKey`, `Image`, `PrimaryIp` and more |
| Language | HCL, which Terraform users know | TypeScript with Effect |
| Maturity | stable | beta, with breaking changes before 2.0 |

Per-box use of either would put seconds of start-up, a lock, and a second
record of what exists in front of every acquire and release. The sweep,
which must find what a crash left, already does the job a state file does,
from the provider's own labels.

## Testing, and what it needs

Tests run in a separate Hetzner project and a separate AWS account with a
budget alarm. OpenTofu makes the AWS security group and key pair, and a
test host where one is needed. A run ends with bb-box's sweep, then a
script that deletes every server labelled or tagged for the tests, then
`tofu destroy`, since servers bb-box made are not in OpenTofu's state.

Credentials, with the least access each test needs:

1. **Hetzner Cloud**: one API token for the test project, Read & Write.
   Hetzner has no narrower scope that can create a server, so the separate
   project is the boundary. No Robot (dedicated server) account yet.
2. **AWS**: one IAM user, `bb-box-test`, with access keys and only the
   policy below, in one region. No IAM permissions, so it cannot give
   itself more. The account's standard vCPU quota in that region should
   allow 32 vCPUs.
3. **Tailscale**, only for tests that enrol in BB, while BB's server is on
   a tailnet: a reusable, ephemeral, pre-approved auth key with
   `tag:bb-box` (050).

The AWS policy, with `<region>` and `<account>` filled in:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Read",
      "Effect": "Allow",
      "Action": ["ec2:Describe*"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "<region>" } }
    },
    {
      "Sid": "LaunchTaggedOfAllowedTypes",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "arn:aws:ec2:<region>:<account>:instance/*",
      "Condition": {
        "Null": { "aws:RequestTag/bbbox:install": "false" },
        "StringEquals": { "ec2:InstanceType": ["t3.medium", "c7i.large", "c7i.xlarge", "m7i.2xlarge"] }
      }
    },
    {
      "Sid": "LaunchResources",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": [
        "arn:aws:ec2:<region>:<account>:volume/*",
        "arn:aws:ec2:<region>:<account>:network-interface/*",
        "arn:aws:ec2:<region>:<account>:subnet/*",
        "arn:aws:ec2:<region>:<account>:security-group/*",
        "arn:aws:ec2:<region>:<account>:key-pair/*",
        "arn:aws:ec2:<region>::image/*",
        "arn:aws:ec2:<region>:<account>:image/*"
      ]
    },
    {
      "Sid": "TagOnCreateOnly",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "*",
      "Condition": { "StringEquals": { "ec2:CreateAction": ["RunInstances", "CreateImage", "CreateSecurityGroup", "ImportKeyPair"] } }
    },
    {
      "Sid": "ActOnOwnInstancesImagesAndSnapshots",
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances", "ec2:TerminateInstances", "ec2:CreateImage", "ec2:DeregisterImage", "ec2:DeleteSnapshot"],
      "Resource": "*",
      "Condition": { "Null": { "aws:ResourceTag/bbbox:install": "false" } }
    },
    {
      "Sid": "TagNewImagesAndSnapshots",
      "Effect": "Allow",
      "Action": "ec2:CreateImage",
      "Resource": ["arn:aws:ec2:<region>::image/*", "arn:aws:ec2:<region>::snapshot/*"],
      "Condition": { "Null": { "aws:RequestTag/bbbox:install": "false" } }
    },
    {
      "Sid": "SetupKeyAndSecurityGroup",
      "Effect": "Allow",
      "Action": ["ec2:ImportKeyPair", "ec2:DeleteKeyPair", "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "<region>" } }
    }
  ]
}
```

The first PR of step 2 checks this policy against a real launch, image
build and sweep with AWS's IAM policy simulator, and tightens it: the
setup statement to resources tagged for bb-box, and the image statements
to the account's own.

## Consequences

- Step 1 works today. The setup guide gains a page: a cloud VM as a Docker
  host, and the microsandbox host it can be.
- Step 2 is a new backend that owns hosts as well as boxes. It reuses the
  Docker and microsandbox backends' code for what runs on a host, and adds
  the provider's API, a host image per provider, idle deletion, and spend
  limits.
- Step 3 needs a VM image pipeline per provider, and waits until a kind
  needs it.
- Every cloud backend runs the conformance suite, and its tests end with a
  sweep that leaves the test project and account empty.

## Open risks

- Not measured: our images' start on a cloud VM, a host image's start, and
  microsandbox under AWS's nested virtualization, which AWS says is slower
  than bare metal for latency-sensitive work.
- Hetzner's prices rose three times in 2026. The doctor should read prices
  from Hetzner's API rather than from this record.
- AWS's free 100 GB of traffic a month goes quickly with desktops.
- A cloud host's boxes share one machine: a box that fills the host's disk
  or memory affects the others, as on any Docker host.
- A privileged box is root on its host, and could read the server's user
  data from the provider's metadata service, where a host gets its tailnet
  key. The host image blocks containers from the metadata address, and a
  one-off key per host makes a key read later useless.
- Hetzner's pages showed every cloud server type as "currently
  unavailable" on 22 October 2026. Whether that was the page or real stock
  is for the Console to show on the day.

## Since 7 October

Read again on 22 October 2026:

- **BB's server.** BB 0.46.0 lets machines reach its server by a direct
  URL or through its bb Connect service. The operator's install uses a
  direct URL on its tailnet, which public DNS answers with a tailnet
  address too, so a cloud host and its boxes reach BB only through the
  tailnet, or once the operator pairs bb Connect.
- **Tailscale for boxes (050)** is designed, not built: nothing joins a
  machine to the tailnet. Step 1 joins its host by hand; step 2 joins its
  hosts itself.
- **microsandbox (053)** is built, with a relay of its own for BB machines.
- **Images (049)** are built on each Docker host through the relay: about
  15 minutes and 36 GB of free disk for all three. A hand-made host needs a
  CX43's 160 GB rather than a CX33's 80 GB.
- **Spawns.** bb-box starts its commands from a helper process, so BB's
  server no longer forks for each `docker` command. A Docker host over
  `ssh://` still starts an `ssh` for each, which is why step 2 forwards one
  socket a host instead.
- **Resize (061)** changes a Docker box's cores and memory live, on any
  Docker host.
- **Prices.** Hetzner's are unchanged once IPv4 is counted (above).
- **Stock.** Hetzner's create page now has three lines: Cost-Optimized (CX,
  "limited availability"), Regular Performance (CPX) and General Purpose
  (CCX). On 22 October no CX server was available in Nuremberg, Falkenstein
  or Helsinki, so step 1's host was a CPX32, and step 2 cannot count on CX
  types: a CPX costs about twice a CX of its size.
- **Step 1, done by hand** on 22 October: Ubuntu 26.04, Docker from
  `get.docker.com`, Tailscale, and Node.js 22 or later, which BB's
  installer needs and does not say so
  ([request 35](../bb-requests.md#35-say-what-a-machine-needs-before-installing)).
  BB's daemon runs as a user of its own, in the `docker` group. bb-box's
  Docker check answered in 0.1 s through the relay. The guide page is
  [a cloud server as a Docker host](../guide/cloud-docker-host.md).
- **Namespace**, which the owner's team uses, was compared as a second
  provider: [Namespace, compared](../research/cloud-hosts.md#namespace-compared).
  Its machines are a VM per box by the minute, with a deadline its plan
  caps at 3 to 24 hours. It is 12 to 17 times Hetzner's price for Linux at
  CX prices, and about 4 times at CPX prices, and offers macOS by the
  minute. The plan's advice: Hetzner for Linux first,
  then Namespace for macOS after a trial.

## Plan of PRs

The plan of 22 October 2026 for steps 1 and 2, with what each PR proves, is
in [Cloud hosts](../research/cloud-hosts.md#pull-requests). In short:

1. The setup guide's page for a cloud VM as a Docker host through BB (step
   1), checked on a Hetzner test server.
2. A Hetzner Cloud client and a fake of its API.
3. The Docker backend's work on one host, made a part both backends use.
4. Host records and the sweep.
5. The Hetzner backend: placement, hosts made on demand and ahead, idle
   deletion and limits, with the conformance suite, on the fake.
6. Reaching hosts over the tailnet, and the first live run.
7. The host image build, and its refresh with the nightly rebuilds (049).
8. Settings and the guide page.

Then AWS, with microsandbox on instances with nested virtualization, as
053's backend is built now; and the OpenTofu module for AWS's policy and
security group, in `setup/`.
