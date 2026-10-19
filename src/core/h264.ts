// How large a frame a viewer's browser decodes as video (#864): shared by the
// plugin and the panel, so it has no dependencies. Sizes are in 16x16
// macroblocks a frame, at the video's 60 frames a second, as H.264's levels
// bound them by both the largest frame and the macroblocks a second.

/** A viewer's message of the largest frame its browser decodes: `BB_DECODES,<macroblocks>`. */
export const DECODES_VERB = "BB_DECODES";

/** H.264 level 5.2 at 60 frames a second: 2,073,600 macroblocks a second, so 34,560 a frame, as 3840x2304. Safari decodes no more. */
export const LEVEL_52_MACROBLOCKS = 34_560;

/**
 * The levels past 5.2, highest first, with the codec string a viewer asks its browser about (Selkies' constrained baseline) and
 * the frame they take at 60 frames a second. 6.2 takes no larger a frame than 6.1, whose largest frame bounds both.
 */
export const LEVELS_PAST_52: readonly { readonly level: number; readonly codec: string; readonly macroblocks: number }[] = [
  { level: 6.1, codec: "avc1.42C03D", macroblocks: 139_264 },
  { level: 6.0, codec: "avc1.42C03C", macroblocks: 69_632 },
];

/** The 16x16 macroblocks a frame of `width` and `height` has. */
export function macroblocks(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}
