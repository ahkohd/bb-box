const arrow = [
  "B",
  "BB",
  "BWB",
  "BWWB",
  "BWWWB",
  "BWWWWB",
  "BWWWWWB",
  "BWWWWWWB",
  "BWWWWWWWB",
  "BWWWWWWWWB",
  "BWWWWWWWWWB",
  "BWWWWWWBBBBB",
  "BWWWBWWB",
  "BWWBBWWB",
  "BWB  BWWB",
  "BB   BWWB",
  "B     BWWB",
  "      BWWB",
  "       BB",
];

interface Palette {
  outline: string;
  light: string;
  shade: string;
}

const resting: Palette = { outline: "#0a0a0a", light: "#f4f4f4", shade: "#a3a3a3" };
const pointing: Palette = { outline: "#0a0a0a", light: "#ffc95c", shade: "#c98a14" };
const cellPx = 1.5;
const pointingAt = 'a[href], button:not(:disabled), label, summary, select, [role="button"], .scroll-rail';

function svgOf(palette: Palette, scale: number): string {
  const cell = cellPx * scale;
  const columns = Math.max(...arrow.map((row) => row.length));
  const rects = arrow.flatMap((row, y) =>
    [...row].flatMap((mark, x) => {
      if (mark === " ") return [];
      const fill = mark === "B" ? palette.outline : (x + y) % 2 === 0 ? palette.light : palette.shade;
      return [`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`];
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${arrow.length * cell}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

const dataUri = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

function cursorDeclarations(palette: Palette, fallback: string): string {
  const one = dataUri(svgOf(palette, 1));
  const two = dataUri(svgOf(palette, 2));
  const set = `${one} 1x, ${two} 2x`;
  return [`cursor: ${one} 0 0, ${fallback};`, `cursor: -webkit-image-set(${set}) 0 0, ${fallback};`, `cursor: image-set(${set}) 0 0, ${fallback};`].join(" ");
}

export const asciiCursorCss = `html { ${cursorDeclarations(resting, "auto")} } :is(${pointingAt}) { ${cursorDeclarations(pointing, "pointer")} } :is(input:not([type="radio"], [type="checkbox"]), textarea) { cursor: text; }`;
