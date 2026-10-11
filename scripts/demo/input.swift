// Synthetic mouse and keyboard input for recording the demo on a Mac.
// Build: swiftc -O scripts/demo/input.swift -o /tmp/demo-input
// The calling process needs Accessibility permission.
//
//   demo-input click X Y   glide to screen point X,Y and click
//   demo-input move X Y    glide to X,Y
//   demo-input type TEXT   type TEXT at a human pace
//   demo-input key CODE    press a virtual key code (36 is Return)
//   demo-input scroll DY   scroll by DY pixels (negative is down)
//   demo-input pos         print the pointer position
import Foundation
import CoreGraphics

let a = CommandLine.arguments
let src = CGEventSource(stateID: .hidSystemState)
func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap); usleep(15000) }

switch a.count > 1 ? a[1] : "" {
case "move", "click":
  let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
  let cur = CGEvent(source: nil)!.location
  for i in 1...20 {
    let t = Double(i) / 20
    post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
      mouseCursorPosition: CGPoint(x: cur.x + (p.x - cur.x) * t, y: cur.y + (p.y - cur.y) * t), mouseButton: .left))
  }
  if a[1] == "click" {
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
  }
case "type":
  for ch in a[2].utf16 {
    var c = ch
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)!
      e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
      post(e)
    }
    usleep(60000)
  }
case "key":
  let k = CGKeyCode(a[2])!
  post(CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true))
  post(CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false))
case "scroll":
  post(CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: Int32(a[2])!, wheel2: 0, wheel3: 0))
case "pos":
  let l = CGEvent(source: nil)!.location
  print(Int(l.x), Int(l.y))
default:
  FileHandle.standardError.write("usage: demo-input click|move X Y | type TEXT | key CODE | scroll DY | pos\n".data(using: .utf8)!)
  exit(2)
}
