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

/** The document with image `name` set to `image`, or removed when it is null. */
export function withImage(document: ConfigDocument, name: string, image: ImageConfig | null): ConfigDocument {
  const images = { ...(document.images ?? {}) };
  if (image) images[name] = image;
  else delete images[name];
  const { images: _, ...rest } = document;
  return Object.keys(images).length ? { ...rest, images } : rest;
}
