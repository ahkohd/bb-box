import type { FieldSpec, Schema } from "./protobuf.ts";

const EMU = "android.emulation.control";

const field = (name: string, number: number, type: FieldSpec["type"], extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, number, type, ...extra });
const message = (name: string, number: number, of: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, number, type: "message", message: of, ...extra });

export const EMULATOR_SCHEMA: Schema = {
  [`${EMU}.Touch`]: [
    field("x", 1, "int32"),
    field("y", 2, "int32"),
    field("identifier", 3, "int32"),
    field("pressure", 4, "int32"),
    field("touch_major", 5, "int32"),
    field("touch_minor", 6, "int32"),
    field("expiration", 7, "enum"),
    field("orientation", 8, "int32"),
  ],
  [`${EMU}.TouchEvent`]: [message("touches", 1, `${EMU}.Touch`, { repeated: true }), field("display", 2, "int32")],
  [`${EMU}.KeyboardEvent`]: [field("codeType", 1, "enum"), field("eventType", 2, "enum"), field("keyCode", 3, "int32"), field("key", 4, "string"), field("text", 5, "string")],
  [`${EMU}.Rotation`]: [field("rotation", 1, "enum"), field("xAxis", 2, "double"), field("yAxis", 3, "double"), field("zAxis", 4, "double")],
  [`${EMU}.ImageTransport`]: [field("channel", 1, "enum"), field("handle", 2, "string")],
  [`${EMU}.ImageFormat`]: [
    field("format", 1, "enum"),
    message("rotation", 2, `${EMU}.Rotation`),
    field("width", 3, "uint32"),
    field("height", 4, "uint32"),
    field("display", 5, "uint32"),
    message("transport", 6, `${EMU}.ImageTransport`),
  ],
  [`${EMU}.Image`]: [message("format", 1, `${EMU}.ImageFormat`), field("width", 2, "uint32"), field("height", 3, "uint32"), field("image", 4, "bytes"), field("seq", 5, "uint32"), field("timestampUs", 6, "uint64")],
  [`${EMU}.ClipData`]: [field("text", 1, "string")],
  [`${EMU}.ParameterValue`]: [field("data", 1, "float", { repeated: true })],
  [`${EMU}.PhysicalModelValue`]: [field("target", 1, "enum"), field("status", 2, "enum"), message("value", 3, `${EMU}.ParameterValue`), field("interpolation", 4, "enum")],
  [`${EMU}.Posture`]: [field("value", 3, "enum")],
  [`${EMU}.BatteryState`]: [field("hasBattery", 1, "bool"), field("isPresent", 2, "bool"), field("charger", 3, "enum"), field("chargeLevel", 4, "int32"), field("health", 5, "enum"), field("status", 6, "enum")],
  [`${EMU}.GpsState`]: [
    field("passiveUpdate", 1, "bool"),
    field("latitude", 2, "double"),
    field("longitude", 3, "double"),
    field("speed", 4, "double"),
    field("bearing", 5, "double"),
    field("altitude", 6, "double"),
    field("satellites", 7, "int32"),
  ],
};

const HID = "idb.HIDEvent";

export const IDB_SCHEMA: Schema = {
  "idb.Point": [field("x", 1, "double"), field("y", 2, "double")],
  [`${HID}.HIDTouch`]: [message("point", 1, "idb.Point")],
  [`${HID}.HIDButton`]: [field("button", 1, "enum")],
  [`${HID}.HIDKey`]: [field("keycode", 1, "uint64")],
  [`${HID}.HIDPressAction`]: [
    message("touch", 1, `${HID}.HIDTouch`, { oneof: "action" }),
    message("button", 2, `${HID}.HIDButton`, { oneof: "action" }),
    message("key", 3, `${HID}.HIDKey`, { oneof: "action" }),
  ],
  [`${HID}.HIDPress`]: [message("action", 1, `${HID}.HIDPressAction`), field("direction", 2, "enum")],
  [`${HID}.HIDSwipe`]: [message("start", 1, "idb.Point"), message("end", 2, "idb.Point"), field("delta", 5, "double"), field("duration", 6, "double")],
  [`${HID}.HIDDelay`]: [field("duration", 1, "double")],
  [`${HID}.HIDPinch`]: [message("center", 1, "idb.Point"), field("scale", 2, "double"), field("duration", 3, "double"), field("radius", 4, "double")],
  [`${HID}.HIDOrientation`]: [field("orientation", 1, "enum")],
  [HID]: [
    message("press", 1, `${HID}.HIDPress`, { oneof: "event" }),
    message("swipe", 2, `${HID}.HIDSwipe`, { oneof: "event" }),
    message("delay", 3, `${HID}.HIDDelay`, { oneof: "event" }),
    message("pinch", 4, `${HID}.HIDPinch`, { oneof: "event" }),
    message("orientation", 5, `${HID}.HIDOrientation`, { oneof: "event" }),
  ],
  "idb.ScreenshotRequest": [field("format", 1, "enum"), field("compression_quality", 2, "double"), field("scale_factor", 4, "double", { oneof: "scale" }), field("unit", 6, "enum")],
  "idb.ScreenshotResponse.Size": [field("width", 1, "uint32"), field("height", 2, "uint32")],
  "idb.ScreenshotResponse": [
    field("image_data", 1, "bytes"),
    field("image_format", 2, "string"),
    message("destination", 3, "idb.ScreenshotResponse.Size"),
    message("source", 4, "idb.ScreenshotResponse.Size"),
    field("screen_scale", 5, "double"),
  ],
  "idb.VideoStreamRequest.Start": [
    field("file_path", 1, "string"),
    field("fps", 2, "uint64"),
    field("format", 3, "enum"),
    field("compression_quality", 4, "double"),
    field("scale_factor", 5, "double"),
    field("avg_bitrate", 6, "double"),
    field("key_frame_rate", 7, "double"),
  ],
  "idb.VideoStreamRequest.Stop": [],
  "idb.VideoStreamRequest": [message("start", 1, "idb.VideoStreamRequest.Start", { oneof: "control" }), message("stop", 2, "idb.VideoStreamRequest.Stop", { oneof: "control" })],
  "idb.Payload": [field("file_path", 1, "string", { oneof: "source" }), field("data", 2, "bytes", { oneof: "source" }), field("url", 3, "string", { oneof: "source" })],
  "idb.VideoStreamResponse": [field("log_output", 1, "bytes", { oneof: "output" }), message("payload", 2, "idb.Payload", { oneof: "output" })],
  "idb.AccessibilityInfoRequest": [message("point", 2, "idb.Point"), field("format", 3, "enum")],
  "idb.AccessibilityInfoResponse": [field("json", 1, "string")],
  "idb.GetOrientationRequest": [],
  "idb.GetOrientationResponse": [field("orientation", 1, "enum")],
  "idb.SetOrientationRequest": [field("orientation", 1, "enum")],
  "idb.SetOrientationResponse": [],
};

export const GRPC_METHODS = {
  emulator: {
    streamScreenshot: "/android.emulation.control.EmulatorController/streamScreenshot",
    getScreenshot: "/android.emulation.control.EmulatorController/getScreenshot",
    sendTouch: "/android.emulation.control.EmulatorController/sendTouch",
    sendKey: "/android.emulation.control.EmulatorController/sendKey",
    setClipboard: "/android.emulation.control.EmulatorController/setClipboard",
    getClipboard: "/android.emulation.control.EmulatorController/getClipboard",
    setPhysicalModel: "/android.emulation.control.EmulatorController/setPhysicalModel",
    setPosture: "/android.emulation.control.EmulatorController/setPosture",
    setBattery: "/android.emulation.control.EmulatorController/setBattery",
    getBattery: "/android.emulation.control.EmulatorController/getBattery",
    setGps: "/android.emulation.control.EmulatorController/setGps",
    getGps: "/android.emulation.control.EmulatorController/getGps",
  },
  idb: {
    hid: "/idb.CompanionService/hid",
    screenshot: "/idb.CompanionService/screenshot",
    accessibilityInfo: "/idb.CompanionService/accessibility_info",
    videoStream: "/idb.CompanionService/video_stream",
    getOrientation: "/idb.CompanionService/get_orientation",
    setOrientation: "/idb.CompanionService/set_orientation",
  },
} as const;
