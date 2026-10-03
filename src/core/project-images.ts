/**
 * Projects' images in the configuration (049): which one a project's boxes
 * of a kind get, and the document with one set or removed.
 */
import type { ConfigDocument, ImageConfig } from "./document.ts";

/** The image a project's boxes of a kind get, or null when it has none for the kind. */
export function projectImage(document: ConfigDocument, project: string | null, kind: string): { readonly name: string; readonly image: ImageConfig } | null {
  if (!project) return null;
  for (const [name, image] of Object.entries(document.images ?? {})) {
    if (image.projects.includes(project) && image.kinds.includes(kind)) return { name, image };
  }
  return null;
}

/** Image `name`, when it covers `kind`, whichever project it is of (049): a box can choose another project's image. */
export function namedImage(document: ConfigDocument, name: string, kind: string): { readonly name: string; readonly image: ImageConfig } | null {
  const image = document.images?.[name];
  return image && image.kinds.includes(kind) ? { name, image } : null;
}

/** An image a box of a kind can have, for a choice (049). */
export interface ImageChoice {
  /** An image's name, or "standard". */
  readonly name: string;
  /** The project's own image, which its boxes get unless they choose another. */
  readonly mine: boolean;
}

/**
 * What a project's box of a kind can start from (049): the project's own
 * image first, as the default, then the standard image, then other
 * projects' images. Empty when no image covers the kind, as there is no
 * choice then.
 */
export function imageChoices(document: ConfigDocument, project: string | null, kind: string): ImageChoice[] {
  const covering = Object.entries(document.images ?? {}).filter(([, image]) => image.kinds.includes(kind));
  if (!covering.length) return [];
  const mine = covering.filter(([, image]) => !!project && image.projects.includes(project)).map(([name]) => ({ name, mine: true }));
  const others = covering.filter(([, image]) => !project || !image.projects.includes(project)).map(([name]) => ({ name, mine: false })).sort((a, b) => a.name.localeCompare(b.name));
  return [...mine, { name: "standard", mine: false }, ...others];
}

/** The document with image `name` set to `image`, or removed when it is null. */
export function withImage(document: ConfigDocument, name: string, image: ImageConfig | null): ConfigDocument {
  const images = { ...(document.images ?? {}) };
  if (image) images[name] = image;
  else delete images[name];
  const { images: _, ...rest } = document;
  return Object.keys(images).length ? { ...rest, images } : rest;
}
