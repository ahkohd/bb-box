# Working in bb-box

bb-box is a BB plugin that gives each BB thread computers of its own, called boxes: Linux, Windows, macOS, iOS and Android, virtual or real.
One core makes them on many backends (Docker, Proxmox, microsandbox, Tart, SSH host pools and cloud machines) through one interface.

Read this before you change anything. How bb-box works is in [docs/architecture.md](docs/architecture.md), and how to build a backend in [docs/development.md](docs/development.md).

## Layout

| Folder | Holds |
| --- | --- |
| `src/core/` | Box records, lifecycle, the sweep, configuration, computer use, images and in-box scripts. It never names a provider or transport |
| `src/backends/` | One driver per provider in `<type>/`, the kinds in `kinds.ts`, and the interface in `types.ts` |
| `src/transports/` | Commands, file copies and routes into a box. They never know which provider made it |
| `src/plugin/` | What BB calls: agent tools, the `bb box` CLI, RPC, HTTP routes, setup and enrolment |
| `src/app/` | The Box panel, the Boxes page, desktop and terminal tabs, and the settings page, in React |
| `src/host/`, `src/relay/`, `src/device/`, `src/monitor/` | What runs on BB machines, the relays, device boxes and the Monitor |
| `components/ui/` | BB's own components, vendored. Use them; do not restyle them |
| `setup/` | Each backend's guide and setup scripts |
| `docs/` | The user guide, the reference (made from the code), the decision records, research and design notes |
| `site/` | The documentation site, built with Starlight from the Markdown above |
| `skills/` | The agent skills: `bb-box` for using boxes, `bb-box-setup` for setting them up |
| `test/` | Node tests with fakes of every provider, and the panel's tests (`*.test.tsx`) |
| `scripts/` | The reference generator, smoke and conformance runners, previews and demos |

## Build and test

You need Node 22.18 or later, which runs TypeScript directly, and `jq`, `sqlite3`, `xxd` and `faketime` for some tests.

```sh
npm ci
npm run typecheck
npm test            # every test: node --test, then vitest
npm run test:app    # the panel's tests alone, in vitest
npm run reference   # writes docs/reference from the code
```

The documentation site has its own packages:

```sh
cd site
npm ci
npm run build        # writes site/dist, with llms.txt and a Markdown copy of each page
npm run check-links  # fails on a link, asset or Markdown copy that leads nowhere
```

GitHub runs the typecheck, `npm test`, the site's build and its link check on each pull request.

Run the tests only in a BB Box box or on GitHub Actions. They refuse to start on a machine where the user can run `sudo` without a password, where they run as root, or where Tailscale is installed, as a test that goes wrong could change it. Every test file starts with `import "./check-test-machine.mjs";`, which makes that check. [docs/development.md](docs/development.md) says how they check.

- Run `npm run reference` after you change a tool, command, setting, kind or check. `npm test` fails while `docs/reference` is out of date. Never edit `docs/reference` by hand.
- `npm test` needs no real host: it runs against fakes of Proxmox, Docker, SSH, Tart and the cloud APIs. The conformance suite and `scripts/smoke.ts` need a real backend: see [docs/development.md](docs/development.md).
- The code is TypeScript that Node runs as it is, so use only syntax that can be erased: no enums, namespaces or parameter properties. Import files with their `.ts` extension.

## Rules

### No code comments

Do not add comments to code, scripts or tests. They drift from what the code does. Say what code is for with names instead: extract a function, constant or type whose name says what or why.

```ts
const TEST_MACHINE_WIDE_FLUSH = "sync";
const FAKE_DISK_FLUSHED = "true";

function withoutTestMachineFlush(script: string): string {
  return script === TEST_MACHINE_WIDE_FLUSH ? FAKE_DISK_FLUSHED : script;
}
```

The one exception is the doc comments on the configuration's interfaces in `src/core/document.ts`. `scripts/reference.ts` reads them into `docs/reference/configuration.md`. Add no doc comments anywhere else. Some older files still have comments: add none to them.

### No deployment names

The repository is publishable at all times ([decision 010](docs/decisions/010-publishable-by-default.md)). Nothing in it, or in a commit message, names a real deployment: no machine, host, user, install, tailnet, pool, bridge or storage names, no addresses, guest IDs or personal names.

- Every such value is a setting with a generic default.
- Examples use generic values: addresses from `192.0.2.0/24`, names such as `pve1` or `build-1`, `example.com`, and the in-box user `box`.
- Measurements name hardware and software versions, never a host.
- Screenshots show generic names. Change them on the page before you take one.

### A test that fails on revert

Each change to what bb-box does comes with a test that fails without it. Revert the change, run the test, see it fail, then put the change back. This holds for each rule a change adds, such as a limit, a refusal or an order of steps.

- Test against the fakes in `test/`. Add to a fake when it cannot show the case yet.
- Do not depend on the wall clock, the test machine's load or another test's state. Fix a flaky test at its cause.
- Unit tests guard contracts. Prove a change to a real backend, stream or control on the real thing too, and say how you measured it.

### Plain, short English

Docs, CLI help, tool descriptions, errors and every word in the panel are plain English in short sentences.

- Active voice, sentence case and British spelling. ASCII only. No `+` or `&` as a conjunction.
- Say what people see, not internal names: "Linux desktop", not `linux-desktop`; "Release", not `box_release`.
- An error or refusal says what to do next, and never holds a credential.
- A number carries its unit and what limits it: "usually 5 to 12 minutes", "about 10 GB of disk free".
- Docs describe the design as it is now, for a reader outside the project. History goes in the decision records.

### The UI style

- Inter at one weight, 400. Show hierarchy by size and colour, not weight.
- No shadows. Borders only where they separate two things.
- Dark first, then light. Check every change in both themes.
- Colours come from BB's theme tokens in the panel and from the site's variables in `site/src/styles/theme.css`. No colour literals and no new colours.
- Build from BB's components in `components/ui`, which keep their own weights. The panel is often 360 px wide: wrap, do not clip.

[docs/design](docs/design) has the panel's and the settings page's rules.

### Decisions in docs/decisions

A choice that shapes the design gets a decision record in `docs/decisions`, numbered next: `NNN-the-decision-as-a-sentence.md`, with its status and date, then Context, Decision and Consequences. Add it to the table in [docs/decisions/README.md](docs/decisions/README.md), with what stands now.

- A decision that changes gets a new record. The old one says which parts the new one supersedes, and its row in the table says so too.
- Measurements and results for a decision go in `NNN-results.md` beside it.
- Read the records that touch your change before you start. Do not reverse one without a new record.

## Writing a change

- Keep the core free of provider names ([decision 001](docs/decisions/001-provider-agnostic-core.md)). A provider's behaviour belongs in its backend, and a kind's capabilities say what it can do.
- Update the guide, the setup guide and the skills when what a person or an agent does changes. `npm test` checks that the skills name every tool and setup command.
- A new docs page in `docs/guide`, `docs/reference` or `setup` reaches the site, its sidebar and llms.txt with no change to `site/`. Link it from its section's index to place it.
- Commit messages are plain English, and say what changed and why.
