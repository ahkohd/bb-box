export interface StartingPoint {
  title: string;
  words: string;
  id: string;
}

export const startingPoints: StartingPoint[] = [
  { title: "Quick start", words: "Install the plugin, set up Docker and make a box.", id: "start/quick-start" },
  { title: "User guide", words: "The Box panel, desktops and devices, the terminal, images, files and settings.", id: "guide" },
  { title: "Backends", words: "Docker, Proxmox, microsandbox, Tart, SSH host pools and cloud machines.", id: "setup" },
  { title: "Reference", words: "Every agent tool, bb box command, setting, kind and check.", id: "reference" },
];

export const trustNote = "bb-box assumes one trusted user. It is not a sandbox for code you do not trust.";
