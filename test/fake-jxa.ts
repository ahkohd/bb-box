import { basename } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export interface DrawnWords {
  readonly text: string;
  readonly font: string;
  readonly x: number;
}

export interface DrawnPill {
  readonly width: number;
  readonly height: number;
  readonly words: readonly DrawnWords[];
  readonly icon: boolean;
}

const GLYPH_WIDTH = 7;

class Wrapped {
  isNil(): boolean {
    return false;
  }

  toString(): string {
    return `[id ${this.constructor.name}]`;
  }
}

class Nil extends Wrapped {
  override isNil(): boolean {
    return true;
  }
}

interface Canvas {
  width: number;
  height: number;
  words: DrawnWords[];
  icon: boolean;
}

interface Graphics {
  current: Canvas | null;
}

function drawing(graphics: Graphics): Canvas {
  if (!graphics.current) throw new Error("No graphics context.");
  return graphics.current;
}

class FakeString extends Wrapped {
  readonly js: string;
  readonly #graphics: Graphics;

  constructor(value: string, graphics: Graphics) {
    super();
    this.js = value;
    this.#graphics = graphics;
  }

  override toString(): string {
    return "[id __NSCFString]";
  }

  sizeWithAttributes(attrs: FakeDictionary): { width: number } {
    attrs.check();
    return { width: [...this.js].length * GLYPH_WIDTH };
  }

  drawAtPointWithAttributes(point: { x: number }, attrs: FakeDictionary): void {
    drawing(this.#graphics).words.push({ text: this.js, font: attrs.font().name, x: point.x });
  }
}

class FakeFont extends Wrapped {
  readonly name: string;
  readonly capHeight = 10;
  readonly descender = -3;

  constructor(name: string) {
    super();
    this.name = name;
  }
}

class FakeDictionary extends Wrapped {
  readonly #objects: readonly unknown[];

  constructor(objects: readonly unknown[]) {
    super();
    this.#objects = objects;
  }

  check(): void {
    if (this.#objects.some((object) => object instanceof Nil || object === undefined)) throw new Error("*** -[__NSArrayM setObject:atIndexedSubscript:]: object cannot be nil");
  }

  font(): FakeFont {
    return this.#objects.find((object): object is FakeFont => object instanceof FakeFont)!;
  }
}

function wrappedList(values: readonly unknown[]): readonly unknown[] {
  if (values.some((value) => value instanceof Nil || value === undefined)) throw new Error("*** -[__NSArrayM setObject:atIndexedSubscript:]: object cannot be nil");
  return values;
}

function bridge(registered: Set<string>) {
  const graphics: Graphics = { current: null };
  const named = (value: string) => new FakeString(value, graphics);
  const $ = (value?: unknown) => (Array.isArray(value) ? wrappedList(value) : typeof value === "string" ? named(value) : new FakeDictionary([]));
  return Object.assign($, {
    NSUTF8StringEncoding: 4,
    NSFontWeightMedium: 0.23,
    NSFontAttributeName: named("NSFont"),
    NSForegroundColorAttributeName: named("NSColor"),
    NSDeviceRGBColorSpace: named("NSDeviceRGBColorSpace"),
    NSBitmapImageFileTypePNG: 4,
    NSCompositingOperationSourceOver: 2,
    NSZeroRect: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
    NSMakeRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    NSMakePoint: (x: number, y: number) => ({ x, y }),
    NSString: { stringWithContentsOfFileEncodingError: (path: string) => (existsSync(String(path)) ? named(readFileSync(String(path), "utf8")) : new Nil()) },
    NSURL: { fileURLWithPath: (path: string) => ({ path: String(path) }) },
    CTFontManagerRegisterFontsForURL: (url: { path: string }) => {
      if (existsSync(url.path)) registered.add(basename(url.path).replace(/\.ttf$/, ""));
      return existsSync(url.path);
    },
    NSFont: {
      systemFontOfSizeWeight: () => new FakeFont("system"),
      fontWithNameSize: (name: string) => (registered.has(name) ? new FakeFont(name) : new Nil()),
    },
    NSColor: { colorWithSRGBRedGreenBlueAlpha: () => Object.defineProperty(new Wrapped(), "setFill", { get: () => undefined }) },
    NSDictionary: { dictionaryWithObjectsForKeys: (objects: readonly unknown[]) => new FakeDictionary(objects) },
    NSImage: {
      alloc: {
        initWithContentsOfFile: (path: string) =>
          existsSync(String(path))
            ? Object.assign(new Wrapped(), {
                drawInRectFromRectOperationFraction: () => {
                  drawing(graphics).icon = true;
                },
              })
            : new Nil(),
      },
    },
    NSBitmapImageRep: {
      alloc: {
        initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel: (_planes: unknown, width: number, height: number) => {
          const rep: Canvas = { width, height, words: [], icon: false };
          return Object.assign(new Wrapped(), {
            rep,
            representationUsingTypeProperties: () => ({ writeToFileAtomically: (path: string) => writeFileSync(String(path), JSON.stringify(rep)) }),
          });
        },
      },
    },
    NSGraphicsContext: Object.defineProperties(
      {
        graphicsContextWithBitmapImageRep: (rep: { rep: Canvas }) => rep.rep,
        setCurrentContext: (context: Canvas) => {
          graphics.current = context;
        },
      },
      {
        saveGraphicsState: { get: () => undefined },
        restoreGraphicsState: { get: () => (graphics.current = null) },
      },
    ),
    NSBezierPath: { bezierPathWithRoundedRectXRadiusYRadius: () => Object.defineProperty(new Wrapped(), "fill", { get: () => undefined }) },
  });
}

export function runJxa(source: string, argv: readonly string[]): string {
  const registered = new Set<string>();
  const ObjC = { import: () => undefined };
  return String(runInNewContext(`${source}\nrun(argv);`, { ObjC, $: bridge(registered), argv: [...argv] }));
}

export function readPill(path: string): DrawnPill {
  return JSON.parse(readFileSync(path, "utf8")) as DrawnPill;
}
