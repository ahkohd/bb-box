import type { APIRoute } from "astro";
import { llmsFullTxt } from "../llms.ts";
import { readPages } from "../repo.ts";

export const GET: APIRoute = ({ site }) => new Response(llmsFullTxt(readPages(), { base: import.meta.env.BASE_URL, site: site?.href }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
