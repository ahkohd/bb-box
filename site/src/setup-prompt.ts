import { repository, type Page } from "./repo.ts";

const installLine = /^[ \t]*```sh\n[ \t]*(bb plugin install [^\s`]+)[ \t]*\n/m;

export function installCommand(pages: Page[]): string {
  const quickStart = pages.find((page) => page.id === "start/quick-start");
  const command = quickStart && installLine.exec(quickStart.markdown)?.[1];
  if (!command) throw new Error("The home page and llms.txt take the install command from the quick start's sh block with bb plugin install, and the quick start has none");
  return command;
}

export const installedBranch = (command: string) => /@([^@\s]+)$/.exec(command)?.[1] ?? "main";

export const quickStartOnGitHub = (command: string) => `${repository}/blob/${installedBranch(command)}/README.md#quick-start`;

export function setupPrompt(command: string, quickStart: string): string {
  return [
    "Set up bb-box for me: the BB plugin that gives threads computers of their own, called boxes.",
    "",
    `1. Install it: ${command} --yes`,
    "2. Follow its bb-box-setup skill. If your skills do not list it yet, find it with bb skill list and read it with bb skill show <id>.",
    "3. Ask me first whether Docker boxes may be privileged containers, which can take over the machine they run on, and before anything that needs root or changes BB's settings.",
    "4. Set up Docker on the machine that runs BB: run bb box doctor, then bb box setup docker. It needs Linux with Docker, about 10 GB of free disk and 8 GiB of memory, and its Linux image takes 5 to 12 minutes to build.",
    '5. Prove it: bb box acquire linux, then bb box run <box> "uname -a", then bb box release <box>.',
    "6. Tell me what you set up, what bb box doctor says, and what is left for me to do.",
    "",
    `The quick start: ${quickStart}`,
  ].join("\n");
}
