import { WHOLE_CARDS_BY_DEFAULT } from "../core/document.ts";
import type { BbBox } from "./setup.ts";

export function wholeCardsOn(app: Pick<BbBox, "configuration">): boolean {
  return app.configuration.document.general.wholeCards ?? WHOLE_CARDS_BY_DEFAULT;
}
