export interface HeadTag {
  tag: "meta" | "link";
  attrs: Record<string, string>;
}

export const shareImage = {
  path: "og.png",
  width: 1200,
  height: 630,
  alt: "BB Box: computers for BB threads. Beside the words, a thread's Box panel lists two Linux boxes, each ready in under 2 seconds.",
};

export const icons = {
  appleTouch: { path: "apple-touch-icon.png", size: 192 },
  png: { path: "favicon.png", size: 64 },
};

const withBase = (base: string, path: string) => `${base.replace(/\/?$/, "/")}${path}`;

function shareImageTags(site: string, base: string): HeadTag[] {
  const address = new URL(withBase(base, shareImage.path), site).href;
  return [
    { tag: "meta", attrs: { property: "og:image", content: address } },
    { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
    { tag: "meta", attrs: { property: "og:image:width", content: String(shareImage.width) } },
    { tag: "meta", attrs: { property: "og:image:height", content: String(shareImage.height) } },
    { tag: "meta", attrs: { property: "og:image:alt", content: shareImage.alt } },
    { tag: "meta", attrs: { name: "twitter:image", content: address } },
    { tag: "meta", attrs: { name: "twitter:image:alt", content: shareImage.alt } },
  ];
}

function iconTags(base: string): HeadTag[] {
  return [
    { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: `${icons.png.size}x${icons.png.size}`, href: withBase(base, icons.png.path) } },
    { tag: "link", attrs: { rel: "apple-touch-icon", sizes: `${icons.appleTouch.size}x${icons.appleTouch.size}`, href: withBase(base, icons.appleTouch.path) } },
  ];
}

export function siteHead({ site, base }: { site?: string; base: string }): HeadTag[] {
  return [...(site ? shareImageTags(site, base) : []), ...iconTags(base)];
}

export const homePageHead: HeadTag[] = [{ tag: "meta", attrs: { property: "og:type", content: "website" } }];
