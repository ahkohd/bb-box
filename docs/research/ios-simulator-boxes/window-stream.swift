import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

let arguments = CommandLine.arguments
let titleMatch = arguments.count > 1 ? arguments[1] : ""
let cropPoints = arguments.count > 2 ? arguments[2].split(separator: ",").compactMap { Double($0) } : []
let started = Date()
let out = FileHandle.standardOutput

func note(_ text: String) {
  FileHandle.standardError.write("\(String(format: "%.3f", Date().timeIntervalSince(started))) \(text)\n".data(using: .utf8)!)
}

func writeAnnexB(_ sample: CMSampleBuffer) {
  var data = Data()
  let startCode: [UInt8] = [0, 0, 0, 1]
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
  let isKey = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  if isKey, let format = CMSampleBufferGetFormatDescription(sample) {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
      if let pointer { data.append(contentsOf: startCode); data.append(pointer, count: size) }
    }
  }
  guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
  var length = 0
  var pointer: UnsafeMutablePointer<CChar>?
  CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
  guard let pointer else { return }
  var offset = 0
  while offset + 4 <= length {
    let raw = UnsafeRawPointer(pointer + offset)
    let nalLength = Int(UInt32(bigEndian: raw.loadUnaligned(as: UInt32.self)))
    data.append(contentsOf: startCode)
    data.append(Data(bytes: raw + 4, count: nalLength))
    offset += 4 + nalLength
  }
  out.write(data)
}

final class Encoder {
  var session: VTCompressionSession?
  var frames: Int64 = 0

  func encode(_ buffer: CVImageBuffer) {
    if session == nil {
      let width = Int32(CVPixelBufferGetWidth(buffer))
      let height = Int32(CVPixelBufferGetHeight(buffer))
      VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
      guard let session else { return }
      let properties: [CFString: Any] = [
        kVTCompressionPropertyKey_RealTime: true,
        kVTCompressionPropertyKey_AllowFrameReordering: false,
        kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
        kVTCompressionPropertyKey_ExpectedFrameRate: 60,
        kVTCompressionPropertyKey_MaxKeyFrameInterval: 100_000,
        kVTCompressionPropertyKey_AverageBitRate: Int(width) * Int(height) * 3,
      ]
      VTSessionSetProperties(session, propertyDictionary: properties as CFDictionary)
      note("encoder \(width)x\(height)")
    }
    guard let session else { return }
    let time = CMTime(value: frames, timescale: 60)
    frames += 1
    VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { status, _, sample in
      if status == noErr, let sample { writeAnnexB(sample) }
    }
  }
}

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  let encoder = Encoder()
  var first = true

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let statusRaw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: statusRaw) == .complete,
      let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return }
    if first { note("first frame"); first = false }
    encoder.encode(buffer)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    note("stopped \(error)")
    exit(2)
  }
}

_ = NSApplication.shared
let output = Output()
var keep: SCStream?

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let candidates = content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.apple.dt.Devices" && $0.frame.height > 200 }
    guard let window = candidates.first(where: { ($0.title ?? "").contains(titleMatch) }) ?? candidates.first else {
      note("no Simulator window"); exit(3)
    }
    note("window \(window.title ?? "") \(window.frame) onScreen=\(window.isOnScreen)")
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = Double(filter.pointPixelScale)
    let config = SCStreamConfiguration()
    let source = cropPoints.count == 4 ? CGRect(x: cropPoints[0], y: cropPoints[1], width: cropPoints[2], height: cropPoints[3]) : CGRect(origin: .zero, size: window.frame.size)
    config.sourceRect = source
    config.width = Int(source.width * scale) & ~1
    config.height = Int(source.height * scale) & ~1
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    config.showsCursor = false
    config.queueDepth = 4
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
    keep = stream
    note("capturing \(config.width)x\(config.height) scale \(scale)")
  } catch {
    note("failed \(error)"); exit(4)
  }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
dispatchMain()
