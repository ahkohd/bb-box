import type { DeviceControl, DeviceElement, DeviceState, OfferedDevice, TouchContact } from "../core/device.ts";

export interface EncodedFrame {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly generation: number;
  readonly monotonicMs: number;
  readonly width: number;
  readonly height: number;
}

export interface VideoSource {
  frames(signal: AbortSignal): AsyncIterable<EncodedFrame>;
  keyframe(): void;
}

export interface DeviceDriver {
  attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted">;
  shutdown(signal: AbortSignal): Promise<void>;
  video(): VideoSource;
  touch(contacts: readonly TouchContact[]): Promise<void>;
  key(key: string, down: boolean): Promise<void>;
  setClipboard(text: string): Promise<void>;
  clipboard(): Promise<string>;
  control(control: DeviceControl, signal: AbortSignal): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  tree(): Promise<readonly DeviceElement[]>;
  readBack(): Promise<DeviceState>;
  onChange(listener: () => void): void;
  close(): void;
}

export class DriverError extends Error {
  readonly code: "unsupported" | "failed" | "not-booted";
  constructor(code: "unsupported" | "failed" | "not-booted", words: string) {
    super(words);
    this.name = "DriverError";
    this.code = code;
  }
}
