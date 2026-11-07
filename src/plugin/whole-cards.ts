import { wholeCardsAnywhere } from "../core/document.ts";
import type { BbBox } from "./setup.ts";

export function wholeCardsOn(app: Pick<BbBox, "configuration">): boolean {
  return wholeCardsAnywhere(app.configuration.document);
}
