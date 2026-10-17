// bb-box-stream: a Mac box's desktop as H.264 video, for the panel's video
// client (060). It speaks the subset of Selkies' WebSocket protocol that
// bb-box's relay and the panel use, so a Mac's desktop shows as a Linux
// one's does:
//
//   bb-box-stream serve [socket]     captures and serves, in the desktop session
//   bb-box-stream connect [socket]   joins stdin and stdout to the server,
//                                    starting it first if it is not running
//
// The socket is ~/.bb-box/stream.sock by default, in a folder only the box
// user can open, so only the box user's own commands reach it. bb-box's
// relay opens each connection with `connect` over the box user's SSH, in the
// desktop session, which carries an HTTP upgrade and then WebSocket frames.
//
// ScreenCaptureKit captures whole frames of the main display at its pixels,
// so a frame never tears; VideoToolbox encodes them in hardware, in real
// time, with no frames reordered; CGEvent posts the input; and the
// pasteboard goes both ways. When the screen stops changing, the last frame
// is encoded twice more, so a still screen sharpens. Its permissions are its
// responsible process's: Screen Recording and Accessibility (058).
//
// setup-mac.sh builds it into /usr/local/bin with swiftc.

import AppKit
import CoreGraphics
import CoreMedia
import CryptoKit
import Foundation
import ScreenCaptureKit
import VideoToolbox

// MARK: Protocol constants

/** Selkies' binary message types and codec: a video frame, H.264. */
let VIDEO: UInt8 = 4
let H264: UInt8 = 1
/** A client whose writes fall this far behind gets no more frames until it has caught up, then a key frame. */
let BEHIND_BYTES = 16 << 20
/** How long the screen is still before the last frame is encoded again, to sharpen it. */
let STILL_SECONDS = 0.3
/** How long the server stays up with no client. */
let IDLE_EXIT_SECONDS = 60.0
/** BB_STREAM_TRACE=1 logs each pointer event's wait before it is posted. */
let TRACE = ProcessInfo.processInfo.environment["BB_STREAM_TRACE"] == "1"

func log(_ text: String) {
  FileHandle.standardError.write("bb-box-stream: \(text)\n".data(using: .utf8)!)
}

func defaultSocket() -> String {
  return NSHomeDirectory() + "/.bb-box/stream.sock"
}

// MARK: Unix sockets

func unixAddress(_ path: String) -> sockaddr_un? {
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
  withUnsafeMutableBytes(of: &address.sun_path) { raw in
    for (index, byte) in bytes.enumerated() { raw[index] = byte }
  }
  return address
}

func connectUnix(_ path: String) -> Int32? {
  guard var address = unixAddress(path) else { return nil }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return nil }
  let ok = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  if ok != 0 {
    close(fd)
    return nil
  }
  return fd
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  return data.withUnsafeBytes { raw -> Bool in
    var offset = 0
    while offset < raw.count {
      let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
      if n < 0 {
        if errno == EINTR { continue }
        return false
      }
      offset += n
    }
    return true
  }
}

/** Copies one descriptor to another until the first ends. */
func pump(_ from: Int32, _ to: Int32) {
  var buffer = [UInt8](repeating: 0, count: 1 << 16)
  while true {
    let n = read(from, &buffer, buffer.count)
    if n < 0 && errno == EINTR { continue }
    if n <= 0 { return }
    if !writeAll(to, Data(buffer[0..<n])) { return }
  }
}

// MARK: connect

func runConnect(_ path: String) -> Never {
  var fd = connectUnix(path)
  if fd == nil {
    // Start the server, detached, and wait for its socket.
    let folder = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // In a session of its own, so it outlives the connection that started it.
    let executable = CommandLine.arguments[0].contains("/") ? CommandLine.arguments[0] : "/usr/local/bin/bb-box-stream"
    let logPath = folder + "/stream.log"
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, logPath, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO)
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
    var pid: pid_t = 0
    let argv: [UnsafeMutablePointer<CChar>?] = [strdup(executable), strdup("serve"), strdup(path), nil]
    let spawned = posix_spawn(&pid, executable, &actions, &attributes, argv, environ)
    if spawned != 0 {
      log("could not start the server: \(String(cString: strerror(spawned)))")
      exit(1)
    }
    for _ in 0..<100 {
      usleep(100_000)
      fd = connectUnix(path)
      if fd != nil { break }
    }
  }
  guard let socketFd = fd else {
    log("the server did not start; see \((path as NSString).deletingLastPathComponent)/stream.log")
    exit(1)
  }
  let output = Thread { pump(socketFd, STDOUT_FILENO); exit(0) }
  output.start()
  pump(STDIN_FILENO, socketFd)
  shutdown(socketFd, SHUT_WR)
  while true { sleep(60) }
}

// MARK: WebSocket

/** One WebSocket client of the server, on its own reading thread; writes go through a serial queue, counted. */
final class Client: @unchecked Sendable {
  let fd: Int32
  let id: Int
  private let writes: DispatchQueue
  private let lock = NSLock()
  private var pending = 0
  private var closed = false
  /** Whether the client asked for video (START_VIDEO) and not since for none. */
  var wantsVideo = false
  /** Its frames were dropped: it gets none until a key frame. */
  var needsKey = true

  init(fd: Int32, id: Int) {
    self.fd = fd
    self.id = id
    self.writes = DispatchQueue(label: "bb-box-stream.client.\(id)")
  }

  var behind: Bool {
    lock.lock()
    defer { lock.unlock() }
    return pending > BEHIND_BYTES
  }

  func send(opcode: UInt8, _ payload: Data) {
    var frame = Data([0x80 | opcode])
    let count = payload.count
    if count < 126 {
      frame.append(UInt8(count))
    } else if count < 65536 {
      frame.append(126)
      frame.append(contentsOf: [UInt8(count >> 8), UInt8(count & 255)])
    } else {
      frame.append(127)
      for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((UInt64(count) >> UInt64(shift)) & 255)) }
    }
    frame.append(payload)
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    pending += frame.count
    lock.unlock()
    writes.async { [self] in
      let ok = writeAll(fd, frame)
      lock.lock()
      pending -= frame.count
      if !ok { closed = true }
      lock.unlock()
    }
  }

  func text(_ string: String) { send(opcode: 1, Data(string.utf8)) }
  func binary(_ data: Data) { send(opcode: 2, data) }

  func close() {
    lock.lock()
    let was = closed
    closed = true
    lock.unlock()
    if !was { shutdown(fd, SHUT_RDWR) }
  }
}

/** Reads exactly `count` bytes, or nil at the end. */
func readExactly(_ fd: Int32, _ count: Int) -> Data? {
  var data = Data(count: count)
  var offset = 0
  while offset < count {
    let n = data.withUnsafeMutableBytes { raw in read(fd, raw.baseAddress! + offset, count - offset) }
    if n < 0 && errno == EINTR { continue }
    if n <= 0 { return nil }
    offset += n
  }
  return data
}

/** Answers the HTTP upgrade; false when it is not one. */
func handshake(_ fd: Int32) -> Bool {
  var request = Data()
  while !(request.count >= 4 && request.suffix(4) == Data([13, 10, 13, 10])) {
    guard request.count < 16384, let byte = readExactly(fd, 1) else { return false }
    request.append(byte)
  }
  guard let text = String(data: request, encoding: .utf8) else { return false }
  var key: String?
  for line in text.split(separator: "\r\n") {
    let parts = line.split(separator: ":", maxSplits: 1)
    if parts.count == 2 && parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sec-websocket-key" {
      key = parts[1].trimmingCharacters(in: .whitespaces)
    }
  }
  guard let key else { return false }
  let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
  let accept = Data(digest).base64EncodedString()
  let reply = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
  return writeAll(fd, Data(reply.utf8))
}

/** The next message: text, or nil at the end. Binary messages and control frames are handled or skipped. */
func nextText(_ client: Client) -> String?? {
  var message = Data()
  var opcode: UInt8 = 0
  while true {
    guard let head = readExactly(client.fd, 2) else { return nil }
    let fin = head[0] & 0x80 != 0
    let op = head[0] & 0x0f
    let masked = head[1] & 0x80 != 0
    var length = UInt64(head[1] & 0x7f)
    if length == 126 {
      guard let more = readExactly(client.fd, 2) else { return nil }
      length = UInt64(more[0]) << 8 | UInt64(more[1])
    } else if length == 127 {
      guard let more = readExactly(client.fd, 8) else { return nil }
      length = more.reduce(0) { $0 << 8 | UInt64($1) }
    }
    guard length < 64 << 20 else { return nil }
    let mask = masked ? readExactly(client.fd, 4) : Data()
    guard mask != nil, var payload = length > 0 ? readExactly(client.fd, Int(length)) : Data() else { return nil }
    if masked, let mask {
      payload.withUnsafeMutableBytes { raw in
        for index in 0..<raw.count { raw[index] ^= mask[mask.startIndex + index % 4] }
      }
    }
    switch op {
    case 8:
      client.send(opcode: 8, Data())
      return nil
    case 9:
      client.send(opcode: 10, payload)
      continue
    case 10:
      continue
    case 0:
      message.append(payload)
    default:
      opcode = op
      message = payload
    }
    if fin {
      if opcode == 1 { return .some(String(data: message, encoding: .utf8)) }
      return .some(nil)
    }
  }
}

// MARK: Input

/** macOS virtual key codes of keys that type no character, by X keysym; as bb-box's mac-input.ts maps them. */
let SPECIAL: [Int: CGKeyCode] = [
  0xff08: 51, 0xff09: 48, 0xff0d: 36, 0xff1b: 53, 0xffff: 117, 0xff50: 115, 0xff51: 123, 0xff52: 126, 0xff53: 124,
  0xff54: 125, 0xff55: 116, 0xff56: 121, 0xff57: 119, 0xff8d: 76, 0xffe1: 56, 0xffe2: 60, 0xffe3: 59, 0xffe4: 62,
  0xffe5: 57, 0xffe7: 55, 0xffe8: 54, 0xffe9: 58, 0xffea: 61, 0xffeb: 55, 0xffec: 54,
]
let FUNCTION_KEYS: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
let US_KEYS: [(CGKeyCode, String)] = [
  (0, "aA"), (1, "sS"), (2, "dD"), (3, "fF"), (4, "hH"), (5, "gG"), (6, "zZ"), (7, "xX"), (8, "cC"), (9, "vV"),
  (11, "bB"), (12, "qQ"), (13, "wW"), (14, "eE"), (15, "rR"), (16, "yY"), (17, "tT"), (18, "1!"), (19, "2@"),
  (20, "3#"), (21, "4$"), (22, "6^"), (23, "5%"), (24, "=+"), (25, "9("), (26, "7&"), (27, "-_"), (28, "8*"),
  (29, "0)"), (30, "]}"), (31, "oO"), (32, "uU"), (33, "[{"), (34, "iI"), (35, "pP"), (37, "lL"), (38, "jJ"),
  (39, "'\""), (40, "kK"), (41, ";:"), (42, "\\|"), (43, ",<"), (44, "/?"), (45, "nN"), (46, "mM"), (47, ".>"),
  (49, "  "), (50, "`~"),
]
let PRINTABLE: [UInt32: CGKeyCode] = {
  var map: [UInt32: CGKeyCode] = [:]
  for (code, chars) in US_KEYS { for scalar in chars.unicodeScalars { map[scalar.value] = code } }
  return map
}()
let MODIFIERS: [CGKeyCode: CGEventFlags] = [
  56: .maskShift, 60: .maskShift, 59: .maskControl, 62: .maskControl, 58: .maskAlternate, 61: .maskAlternate, 55: .maskCommand, 54: .maskCommand,
]

func macKeyCode(_ keysym: Int) -> CGKeyCode? {
  if keysym >= 0xffbe && keysym <= 0xffc9 { return FUNCTION_KEYS[keysym - 0xffbe] }
  if let code = SPECIAL[keysym] { return code }
  let codePoint: Int? = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym <= 0xff ? keysym : nil
  guard let codePoint else { return nil }
  return PRINTABLE[UInt32(codePoint)]
}

/** Posts the controlling viewer's keys and pointer, as a keyboard and mouse would. Positions come in the frame's pixels. */
final class Input: @unchecked Sendable {
  private var held: [CGKeyCode: Int] = [:]
  private var mask = 0
  private var x = 0.0, y = 0.0
  private var clicks = (at: 0.0, x: 0.0, y: 0.0, button: -1, count: 0)
  /** Frame pixels per screen point. */
  var scale = 1.0

  private var flags: CGEventFlags {
    var flags = CGEventFlags()
    for code in held.keys { if let flag = MODIFIERS[code] { flags.insert(flag) } }
    return flags
  }

  private func post(_ event: CGEvent?) {
    guard let event else { return }
    event.flags = flags
    event.post(tap: .cghidEventTap)
  }

  func key(_ keysym: Int, down: Bool) {
    guard let code = macKeyCode(keysym) else { return }
    if down { held[code, default: 0] += 1 } else { held[code] = nil }
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down))
  }

  func releaseKeys() {
    for code in held.keys { post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)) }
    held = [:]
  }

  // Selkies' mask: 1 primary, 2 middle, 4 secondary. Each: the mask bit, the CoreGraphics button, and its down, up and dragged events.
  private let buttons: [(Int, CGMouseButton, CGEventType, CGEventType, CGEventType)] = [
    (1, .left, .leftMouseDown, .leftMouseUp, .leftMouseDragged),
    (4, .right, .rightMouseDown, .rightMouseUp, .rightMouseDragged),
    (2, .center, .otherMouseDown, .otherMouseUp, .otherMouseDragged),
  ]

  func pointer(px: Double, py: Double, next: Int) {
    let at = CGPoint(x: px / scale, y: py / scale)
    if px != x || py != y {
      let dragging = buttons.first { mask & $0.0 != 0 }
      post(CGEvent(mouseEventSource: nil, mouseType: dragging?.4 ?? .mouseMoved, mouseCursorPosition: at, mouseButton: dragging?.1 ?? .left))
      x = px
      y = py
    }
    for button in buttons where (next & button.0) != (mask & button.0) {
      let down = next & button.0 != 0
      if down {
        let now = Date().timeIntervalSince1970
        let again = clicks.button == Int(button.1.rawValue) && now - clicks.at < 0.5 && abs(px - clicks.x) < 8 && abs(py - clicks.y) < 8
        clicks = (now, px, py, Int(button.1.rawValue), again ? clicks.count + 1 : 1)
      }
      let event = CGEvent(mouseEventSource: nil, mouseType: down ? button.2 : button.3, mouseCursorPosition: at, mouseButton: button.1)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks.button == Int(button.1.rawValue) ? clicks.count : 1))
      post(event)
    }
    mask = next & 7
  }

  /** Wheel notches, as the panel sends them: a press of bit 8 scrolls down, of bit 16 up. */
  func wheel(next: Int, count: Int) {
    let notches = max(1, min(count, 64))
    if next & 8 != 0 { post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-3 * notches), wheel2: 0, wheel3: 0)) }
    if next & 16 != 0 { post(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(3 * notches), wheel2: 0, wheel3: 0)) }
  }
}

// MARK: Encoder

/** H.264 in hardware, in real time, as Annex B with the parameter sets on each key frame. */
final class Encoder: @unchecked Sendable {
  let width: Int
  let height: Int
  private var session: VTCompressionSession?
  private let output: (Data, Bool) -> Void

  init?(width: Int, height: Int, output: @escaping (Data, Bool) -> Void) {
    self.width = width
    self.height = height
    self.output = output
    let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true, kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
    var made: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
      encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &made)
    guard status == noErr, let made else {
      log("VideoToolbox could not make an H.264 encoder: \(status)")
      return nil
    }
    session = made
    let pixels = Double(width * height)
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
      kVTCompressionPropertyKey_ExpectedFrameRate: 60,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: 100_000,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 3600,
      // About 3 bits a pixel a second: 25 Mbit/s at 4K, 6 at 1080p.
      kVTCompressionPropertyKey_AverageBitRate: Int(pixels * 3),
      kVTCompressionPropertyKey_ColorPrimaries: kCVImageBufferColorPrimaries_ITU_R_709_2,
      kVTCompressionPropertyKey_TransferFunction: kCVImageBufferTransferFunction_ITU_R_709_2,
      kVTCompressionPropertyKey_YCbCrMatrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    ]
    for (key, value) in properties {
      let set = VTSessionSetProperty(made, key: key, value: value as CFTypeRef)
      if set != noErr { log("VideoToolbox did not take \(key): \(set)") }
    }
    VTCompressionSessionPrepareToEncodeFrames(made)
  }

  func encode(_ buffer: CVImageBuffer, at time: CMTime, key: Bool) {
    guard let session else { return }
    let options: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid, frameProperties: options, infoFlagsOut: nil) { [self] status, _, sample in
      guard status == noErr, let sample else { return }
      deliver(sample)
    }
  }

  private func deliver(_ sample: CMSampleBuffer) {
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    var annexB = Data()
    let start = Data([0, 0, 0, 1])
    if key, let format = CMSampleBufferGetFormatDescription(sample) {
      var count = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
      for index in 0..<count {
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
          annexB.append(start)
          annexB.append(pointer, count: size)
        }
      }
    }
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr, let pointer else { return }
    let bytes = UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self)
    var offset = 0
    while offset + 4 <= length {
      let size = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
      offset += 4
      guard size > 0, offset + size <= length else { break }
      annexB.append(start)
      annexB.append(bytes + offset, count: size)
      offset += size
    }
    output(annexB, key)
  }

  func stop() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    session = nil
  }
}

// MARK: Server

final class Server: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let queue = DispatchQueue(label: "bb-box-stream.server")
  private var clients: [Int: Client] = [:]
  private var nextClient = 0
  private var stream: SCStream?
  /** The size the capture runs at, to restart it when the display's mode changes. */
  private var capturing: (width: Int, height: Int)?
  private var starting = false
  private var encoder: Encoder?
  private var frameId: UInt16 = 0
  private var keyAsked = true
  private var last: (buffer: CVImageBuffer, time: CMTime)?
  private var still: DispatchWorkItem?
  private var lastClientAt = Date()
  private let input = Input()
  private var pasteboardCount = NSPasteboard.general.changeCount
  private var clipboardParts: [String: Data] = [:]

  func start(path: String) {
    // Another connection started a server first: it serves.
    if let running = connectUnix(path) {
      Darwin.close(running)
      log("a server is already running at \(path)")
      exit(0)
    }
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0, var address = unixAddress(path) else {
      log("could not make the socket at \(path)")
      exit(1)
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 16) == 0 else {
      log("could not listen at \(path): \(String(cString: strerror(errno)))")
      exit(1)
    }
    log("serving at \(path)")
    Thread { [self] in
      while true {
        let client = Darwin.accept(fd, nil, nil)
        if client < 0 { continue }
        Thread { self.serve(client) }.start()
      }
    }.start()
    // The box's pasteboard, to the clients, when it changes.
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [self] _ in
      let board = NSPasteboard.general
      guard board.changeCount != pasteboardCount else { return }
      pasteboardCount = board.changeCount
      guard let text = board.string(forType: .string) else { return }
      let message = "clipboard," + Data(text.utf8).base64EncodedString()
      queue.async { for client in self.clients.values { client.text(message) } }
    }
    // A new display mode, such as bb-box-display's 2x: the capture starts again at its size.
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [self] _ in
      guard let mode = CGDisplayCopyDisplayMode(CGMainDisplayID()) else { return }
      queue.async {
        guard let size = self.capturing, size != (mode.pixelWidth, mode.pixelHeight), let stream = self.stream else { return }
        log("the display is now \(mode.pixelWidth)x\(mode.pixelHeight)")
        self.stream = nil
        self.capturing = nil
        stream.stopCapture { _ in }
        self.updateCapture()
      }
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [self] _ in
      queue.async {
        if self.clients.isEmpty && Date().timeIntervalSince(self.lastClientAt) > IDLE_EXIT_SECONDS {
          log("no client for \(Int(IDLE_EXIT_SECONDS)) s; exiting")
          unlink(path)
          exit(0)
        }
      }
    }
  }

  private func serve(_ fd: Int32) {
    guard handshake(fd) else {
      Darwin.close(fd)
      return
    }
    let client: Client = queue.sync {
      nextClient += 1
      let client = Client(fd: fd, id: nextClient)
      clients[client.id] = client
      lastClientAt = Date()
      return client
    }
    // Selkies speaks first; the relay waits for a first message.
    client.text("MODE websockets")
    while let message = nextText(client) {
      guard let text = message else { continue }
      handle(text, from: client)
    }
    client.close()
    Darwin.close(fd)
    queue.async { [self] in
      clients[client.id] = nil
      lastClientAt = Date()
      updateCapture()
    }
  }

  private func handle(_ text: String, from client: Client) {
    let fields = text.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    let verb = fields[0].split(separator: " ").first.map(String.init) ?? ""
    let number = { (index: Int) -> Int in index < fields.count ? Int(fields[index]) ?? 0 : 0 }
    switch verb {
    case "START_VIDEO":
      queue.async { [self] in
        client.wantsVideo = true
        client.needsKey = true
        keyAsked = true
        updateCapture()
      }
    case "STOP_VIDEO":
      queue.async { [self] in
        client.wantsVideo = false
        updateCapture()
      }
    case "REQUEST_KEYFRAME":
      queue.async { [self] in
        keyAsked = true
        if let last { encodeLast(last) }
      }
    case "kd", "ku":
      DispatchQueue.main.async { self.input.key(number(1), down: verb == "kd") }
    case "kr":
      DispatchQueue.main.async { self.input.releaseKeys() }
    case "m":
      let at = Date()
      DispatchQueue.main.async {
        self.input.pointer(px: Double(number(1)), py: Double(number(2)), next: number(3))
        if TRACE { log("m \(number(1)) at +\(Int(Date().timeIntervalSince(at) * 1000)) ms, \(Int(Date().timeIntervalSince1970 * 1000) % 100000)") }
      }
    case "m2":
      DispatchQueue.main.async { self.input.wheel(next: number(3), count: number(4)) }
    case "cw":
      if fields.count > 1, let data = Data(base64Encoded: fields[1]) { paste(data) }
    case "cws":
      if fields.count > 1 { clipboardParts[fields[1]] = Data() }
    case "cwd":
      if fields.count > 2, let data = Data(base64Encoded: fields[2]) { clipboardParts[fields[1]]?.append(data) }
    case "cwe":
      if fields.count > 1, let data = clipboardParts.removeValue(forKey: fields[1]) { paste(data) }
    default:
      // SETTINGS, CLIENT_FRAME_ACK, a resize and the rest: the Mac keeps its own size and colour.
      break
    }
  }

  private func paste(_ data: Data) {
    guard let text = String(data: data, encoding: .utf8) else { return }
    DispatchQueue.main.async { [self] in
      let board = NSPasteboard.general
      board.clearContents()
      board.setString(text, forType: .string)
      pasteboardCount = board.changeCount
    }
  }

  /** Captures while a client wants video, and not otherwise. On the server's queue. */
  private func updateCapture() {
    let wanted = clients.values.contains { $0.wantsVideo }
    if wanted && stream == nil && !starting {
      starting = true
      Task { await self.startCapture() }
    } else if !wanted, let stream {
      self.stream = nil
      capturing = nil
      stream.stopCapture { _ in }
      encoder?.stop()
      encoder = nil
      last = nil
    }
  }

  private func startCapture() async {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      let mainId = CGMainDisplayID()
      guard let display = content.displays.first(where: { $0.displayID == mainId }) ?? content.displays.first else {
        throw NSError(domain: "bb-box-stream", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
      }
      let mode = CGDisplayCopyDisplayMode(display.displayID)
      let width = mode?.pixelWidth ?? display.width
      let height = mode?.pixelHeight ?? display.height
      let configuration = SCStreamConfiguration()
      configuration.width = width
      configuration.height = height
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
      configuration.queueDepth = 5
      configuration.showsCursor = true
      configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let made = SCStream(filter: filter, configuration: configuration, delegate: self)
      try made.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
      try await made.startCapture()
      let points = Double(display.width)
      DispatchQueue.main.async { self.input.scale = points > 0 ? Double(width) / points : 1 }
      queue.async { [self] in
        starting = false
        stream = made
        capturing = (width, height)
        log("capturing \(width)x\(height)")
        if !clients.values.contains(where: { $0.wantsVideo }) { updateCapture() }
      }
    } catch {
      log("could not capture the screen: \(error.localizedDescription)")
      queue.async { [self] in
        starting = false
        for client in clients.values { client.close() }
      }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    log("the capture stopped: \(error.localizedDescription)")
    queue.async { [self] in
      if self.stream === stream { self.stream = nil }
      updateCapture()
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
      let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return }
    let frame = (buffer: buffer, time: CMSampleBufferGetPresentationTimeStamp(sample))
    last = frame
    encodeLast(frame)
    // A still screen: the same frame twice more, which sharpens it.
    still?.cancel()
    var again = 2
    let item = DispatchWorkItem { [weak self] in
      guard let self, let last = self.last, again > 0 else { return }
      again -= 1
      self.encodeLast((last.buffer, CMTimeAdd(last.time, CMTime(value: Int64(3 - again), timescale: 600))))
    }
    still = item
    queue.asyncAfter(deadline: .now() + STILL_SECONDS, execute: item)
    queue.asyncAfter(deadline: .now() + STILL_SECONDS * 2, execute: item)
  }

  /** Encodes a frame for the clients that want video. On the server's queue. */
  private func encodeLast(_ frame: (buffer: CVImageBuffer, time: CMTime)) {
    let width = CVPixelBufferGetWidth(frame.buffer)
    let height = CVPixelBufferGetHeight(frame.buffer)
    if encoder?.width != width || encoder?.height != height {
      encoder?.stop()
      encoder = Encoder(width: width, height: height) { [weak self] data, key in
        self?.queue.async { self?.broadcast(data, key: key, width: width, height: height) }
      }
      keyAsked = true
    }
    let key = keyAsked
    keyAsked = false
    encoder?.encode(frame.buffer, at: frame.time, key: key)
  }

  /** Sends a frame to each client that wants video and is keeping up. On the server's queue. */
  private func broadcast(_ data: Data, key: Bool, width: Int, height: Int) {
    frameId = frameId &+ 1
    var message = Data([VIDEO, H264 << 4 | (key ? 1 : 0), UInt8(frameId >> 8), UInt8(frameId & 255), 0, 0,
      UInt8(width >> 8), UInt8(width & 255), UInt8(height >> 8), UInt8(height & 255), 0, 0])
    message.append(data)
    for client in clients.values where client.wantsVideo {
      if client.behind {
        client.needsKey = true
        continue
      }
      if client.needsKey && !key {
        keyAsked = true
        continue
      }
      client.needsKey = false
      client.binary(message)
    }
  }
}

// MARK: Main

let arguments = CommandLine.arguments
let mode = arguments.count > 1 ? arguments[1] : ""
let path = arguments.count > 2 ? arguments[2] : defaultSocket()
signal(SIGPIPE, SIG_IGN)
switch mode {
case "connect":
  runConnect(path)
case "serve":
  try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  _ = NSApplication.shared
  let server = Server()
  server.start(path: path)
  RunLoop.main.run()
default:
  FileHandle.standardError.write("usage: bb-box-stream serve|connect [socket]\n".data(using: .utf8)!)
  exit(2)
}
