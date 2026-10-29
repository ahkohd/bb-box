import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { repositoryDocs } from "./loader.ts";

export const collections = {
  docs: defineCollection({ loader: repositoryDocs(), schema: docsSchema() }),
};
