import type { APIRoute, GetStaticPaths } from "astro";
import { markdownCopies } from "../llms.ts";
import { readPages } from "../repo.ts";

export const getStaticPaths = (() =>
  markdownCopies(readPages(), { base: import.meta.env.BASE_URL, site: import.meta.env.SITE }).map((copy) => ({ params: { slug: copy.page.id }, props: { text: copy.text } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => new Response(props.text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
