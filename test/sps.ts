const BASELINE = 66;
const LEVEL_5_2 = 52;

class BitWriter {
  readonly #bits: number[] = [];

  bits(value: number, count: number): void {
    for (let index = count - 1; index >= 0; index--) this.#bits.push((value >> index) & 1);
  }

  unsigned(value: number): void {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded));
    this.bits(0, length);
    this.bits(coded, length + 1);
  }

  bytes(): Uint8Array {
    const bits = [...this.#bits, 1];
    while (bits.length % 8) bits.push(0);
    const out: number[] = [];
    for (let at = 0; at < bits.length; at += 8) out.push(bits.slice(at, at + 8).reduce((byte, bit) => byte * 2 + bit, 0));
    return Uint8Array.from(out);
  }
}

function withEmulationPrevention(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of body) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export function spsOfSize(width: number, height: number): Uint8Array {
  const writer = new BitWriter();
  writer.bits(BASELINE, 8);
  writer.bits(0, 8);
  writer.bits(LEVEL_5_2, 8);
  writer.unsigned(0);
  writer.unsigned(0);
  writer.unsigned(2);
  writer.unsigned(1);
  writer.bits(0, 1);
  const across = Math.ceil(width / 16);
  const down = Math.ceil(height / 16);
  writer.unsigned(across - 1);
  writer.unsigned(down - 1);
  writer.bits(1, 1);
  writer.bits(1, 1);
  const right = (across * 16 - width) / 2;
  const bottom = (down * 16 - height) / 2;
  writer.bits(right || bottom ? 1 : 0, 1);
  if (right || bottom) {
    writer.unsigned(0);
    writer.unsigned(right);
    writer.unsigned(0);
    writer.unsigned(bottom);
  }
  writer.bits(0, 1);
  return Uint8Array.from([0x67, ...withEmulationPrevention(writer.bytes())]);
}

export function evenScaled(size: number, scale: number): number {
  return Math.max(2, Math.round((size * scale) / 2) * 2);
}
