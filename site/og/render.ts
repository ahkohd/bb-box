import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { shareImage } from "../src/head.ts";

interface Card {
  file: string;
  width: number;
  height: number;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const site = join(here, "..");
const chromium = process.env.CHROMIUM || "chromium";
const roomForBrowserChrome = 200;

const cards: Card[] = [
  { file: join(site, "public", shareImage.path), width: shareImage.width, height: shareImage.height },
  { file: join(here, "github-social.png"), width: 1280, height: 640 },
];

function cardAddress({ width, height }: Card): string {
  const address = pathToFileURL(join(here, "card.html"));
  address.search = new URLSearchParams({ width: String(width), height: String(height) }).toString();
  return address.href;
}

function screenshot(card: Card, profile: string): string {
  const shot = join(profile, "card.png");
  try {
    execFileSync(
      chromium,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1",
        "--default-background-color=0a0a0aff",
        "--virtual-time-budget=5000",
        `--user-data-dir=${profile}`,
        `--window-size=${card.width},${card.height + roomForBrowserChrome}`,
        `--screenshot=${shot}`,
        cardAddress(card),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } catch (error) {
    throw new Error(`Could not run Chromium as "${chromium}". Install Chromium, or set CHROMIUM to its path, then run npm run og again. ${error}`);
  }
  return shot;
}

async function renderIcons(): Promise<void> {
}

async function main(): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "bb-box-og-"));
  try {
    for (const card of cards) {
      const shot = screenshot(card, profile);
      await sharp(shot).extract({ left: 0, top: 0, width: card.width, height: card.height }).png({ compressionLevel: 9 }).toFile(card.file);
      console.log(`${card.file}: ${card.width} by ${card.height}`);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  await renderIcons();
}

await main();
