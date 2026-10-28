import type { DeviceControl, DeviceElement, DeviceState, LaunchedApp, OfferedDevice, TouchContact, VideoEncoding, VideoStep } from "../core/device.ts";

export interface EncodedFrame {
  readonly data: Uint8Array;
  readonly key: boolean;
  readonly generation: number;
  readonly monotonicMs: number;
  readonly width: number;
  readonly height: number;
  readonly unchanged?: boolean;
}

export interface VideoSource {
  frames(signal: AbortSignal): AsyncIterable<EncodedFrame>;
  keyframe(): void;
  want?(step: VideoStep | null): void;
  encoding?(): VideoEncoding | null;
}

export interface PinchGesture {
  readonly centre: { readonly x: number; readonly y: number };
  readonly from: number;
  readonly to: number;
  readonly ms: number;
}

export interface ControlContext {
  readonly personHasControl: boolean;
}

export interface DeviceDriver {
  attach(target: OfferedDevice, signal: AbortSignal): Promise<"reattached" | "booted">;
  shutdown(signal: AbortSignal): Promise<void>;
  video(): VideoSource;
  touch(contacts: readonly TouchContact[]): Promise<void>;
  pinch?(gesture: PinchGesture, signal: AbortSignal): Promise<void>;
  key(key: string, down: boolean): Promise<void>;
  typesAsKeys?(character: string): boolean;
  paste(): Promise<void>;
  readonly pasteLandsMs?: number;
  prepareInput(): Promise<void>;
  setClipboard(text: string): Promise<void>;
  clipboard(): Promise<string>;
  control(control: DeviceControl, signal: AbortSignal, context: ControlContext): Promise<void>;
  readSettings?(signal: AbortSignal): Promise<void>;
  openUrl?(url: string, signal: AbortSignal): Promise<void>;
  launchApp?(app: string, signal: AbortSignal): Promise<LaunchedApp>;
  screenshot(): Promise<Uint8Array>;
  tree(): Promise<readonly DeviceElement[]>;
  elementAt?(point: { readonly x: number; readonly y: number }): Promise<DeviceElement | null>;
  readBack(): Promise<DeviceState>;
  onChange(listener: () => void): void;
  close(): void;
}

export type DriverErrorCode = "unsupported" | "failed" | "not-booted" | "bad-value" | "person-has-control" | "held-elsewhere";

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  constructor(code: DriverErrorCode, words: string) {
    super(words);
    this.name = "DriverError";
    this.code = code;
  }
}
