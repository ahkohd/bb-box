import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { icons, shareImage } from "../src/head.ts";

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

const iconImages = [
  { file: join(site, "public", icons.appleTouch.path), size: icons.appleTouch.size, padding: 36, radius: 0, strokeWidth: 1.5 },
  { file: join(site, "public", icons.png.path), size: icons.png.size, padding: 4, radius: 7, strokeWidth: 1.75 },
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

function iconSvg({ size, padding, radius, strokeWidth }: (typeof iconImages)[number]): string {
  const mark = size - padding * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${radius}" fill="#0a0a0a"/>
<svg x="${padding}" y="${padding}" width="${mark}" height="${mark}" viewBox="0 0 24 24" fill="none" stroke="#fafafa" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5"/></svg>
</svg>`;
}

async function renderIcons(): Promise<void> {
  for (const icon of iconImages) await sharp(Buffer.from(iconSvg(icon))).png().toFile(icon.file);
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
  for (const icon of iconImages) console.log(`${icon.file}: ${icon.size} by ${icon.size}`);
}

await main();
