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

const agentBlock = /<summary><strong>With an agent<\/strong><\/summary>[\s\S]*?^```text\n([\s\S]*?)\n```$/m;

export function agentPrompt(pages: Page[]): string {
  const quickStart = pages.find((page) => page.id === "start/quick-start");
  const prompt = quickStart && agentBlock.exec(quickStart.markdown)?.[1];
  if (!prompt) throw new Error("The home page takes its setup prompt from the quick start's With an agent text block, and the quick start has none");
  return prompt;
}

export function setupPrompt(pages: Page[], quickStart: string): string {
  return `${agentPrompt(pages)}\n\nThe quick start: ${quickStart}`;
}
