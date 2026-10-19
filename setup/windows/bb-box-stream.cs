// bb-box-stream.exe: a Windows box's desktop as H.264 video, for the panel's
// video client (060), as setup/ssh-pool/mac-stream.swift is a Mac's. It
// speaks the subset of Selkies' WebSocket protocol that bb-box's relay and the
// panel use:
//
//   bb-box-stream.exe serve     captures and serves, in box's desktop session
//   bb-box-stream.exe connect   joins stdin and stdout to the server, starting
//                               it first through its scheduled task
//   bb-box-stream.exe test      captures for 3 s and encodes a key frame,
//                               saying each step, in the desktop session
//   bb-box-stream.exe pointer   says whether the pointer is in the captured
//                               image, in the desktop session, for check.ps1
//
// The server listens on the named pipe bb-box-stream, which only box can open.
// bb-box's relay opens each connection with `connect` over box's SSH, which
// carries an HTTP upgrade and then WebSocket frames. The task, which the
// image's first logon and its refresh register, starts the server in box's
// desktop session, where the screen and the input are; SSH's session has
// neither. The server exits a minute after its last client.
//
// Desktop Duplication captures whole frames, on the Direct3D 11 device of the
// display adapter, mapped where its image is in system memory, as on the
// Basic Display adapter; GDI does when it cannot. Desktop Duplication leaves out the pointer where the display has a
// hardware cursor, as the image's VirtIO GPU does with HWCursor on (hardware-cursor.ps1), and it is drawn in.
// Cisco's OpenH264, which the image downloads from Cisco, encodes them for
// screen content in real time; when the screen stops changing, the last frame
// is encoded twice more, which sharpens it. SendInput posts the input, and the
// clipboard goes both ways: text, and images as PNG, a pasted one put on the
// clipboard as the very bytes it came as, never encoded again.
//
// C# 5, for the compiler in .NET Framework 4.8, which every Windows 11 has:
//   csc /optimize /unsafe /platform:x64 /r:System.Drawing.dll /r:System.Windows.Forms.dll bb-box-stream.cs
// On arm64, AnyCPU with a manifest that lets it run natively (install-stream.ps1).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Program {
  public const string PIPE = "bb-box-stream";
  public const string TASK = "bb-box-stream";
  /** A client whose writes fall this far behind gets no frames until it has caught up, then a key frame. */
  public const int BEHIND_BYTES = 16 << 20;
  /** How long the screen is still before the last frame is encoded again, to sharpen it. */
  public const int STILL_MS = 300;
  /** The largest clipboard content either way, as the panel's video client takes: 64 MiB. */
  public const int CLIPBOARD_MAX_BYTES = 64 << 20;
  /** A copied image's bytes a message, in parts above it (Selkies' clipboard_start, clipboard_data, clipboard_finish). */
  public const int CLIPBOARD_CHUNK = 192 << 10;
  /** How long the server stays up with no client. */
  public const int IDLE_EXIT_MS = 60000;

  [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint _controlfp(uint value, uint mask);
  /** Masks every floating-point exception on this thread, as .NET and C code expect them. */
  public static uint MaskFloatingPoint() { return _controlfp(0x8001F, 0x8001F); }

  public static void Log(string text) {
    Console.Error.WriteLine(DateTime.Now.ToString("HH:mm:ss") + " bb-box-stream: " + text);
  }

  /** One frame captured and encoded, saying each step: for a check, in the desktop session. */
  static int SelfTest() {
    using (Capture capture = new Capture()) {
      Console.WriteLine("capture " + capture.Width + "x" + capture.Height + (capture.Duplicating ? " Desktop Duplication" : " GDI"));
      bool changed = false;
      for (int i = 0; i < 20 && !changed; i++) changed = capture.Next(100);
      Console.WriteLine("frame " + changed);
      int frames = 0;
      Stopwatch clock = Stopwatch.StartNew();
      while (clock.ElapsedMilliseconds < 3000) if (capture.Next(50)) frames++;
      Console.WriteLine("3 s: " + frames + " frames, " + capture.ReleaseFaults + " ReleaseFrame faults");
      byte[] frame = capture.WithPointer();
      Console.WriteLine("pointer drawn");
      string png = Path.Combine(Path.GetTempPath(), "bb-box-stream-test.png");
      GCHandle pin = GCHandle.Alloc(frame, GCHandleType.Pinned);
      try { using (Bitmap bitmap = new Bitmap(capture.Width, capture.Height, capture.Width * 4, PixelFormat.Format32bppRgb, pin.AddrOfPinnedObject())) bitmap.Save(png, ImageFormat.Png); } finally { pin.Free(); }
      Console.WriteLine("saved " + png);
      using (Encoder encoder = new Encoder(capture.Width, capture.Height)) {
        bool key;
        byte[] data = encoder.Encode(frame, capture.Width * 4, true, out key);
        Console.WriteLine("encoded " + (data == null ? "nothing" : data.Length + " bytes") + ", key " + key);
        return data != null && key ? 0 : 1;
      }
    }
  }

  /**
   * Whether the pointer is in the captured image, for a check, in the desktop session: the spot under the pointer, with
   * the pointer on it, away from it and on it again. Where the display draws the pointer as a hardware cursor, the spot
   * stays the same. Moves the pointer. 0 when it is out of the image, 1 when it is in, 2 when the screen kept changing.
   */
  static int PointerTest() {
    using (Capture capture = new Capture()) {
      if (!capture.Duplicating) { Console.WriteLine("GDI, not Desktop Duplication: cannot tell"); return 2; }
      int x = capture.Width / 2, y = capture.Height / 2;
      for (int attempt = 0; attempt < 3; attempt++) {
        byte[] on = Spot(capture, x, y, x, y);
        byte[] away = Spot(capture, x + capture.Width / 4, y + capture.Height / 4, x, y);
        byte[] again = Spot(capture, x, y, x, y);
        if (!Same(on, again)) continue;
        bool outside = Same(on, away);
        Console.WriteLine(outside ? "the pointer is out of the image" : "the pointer is in the image");
        return outside ? 0 : 1;
      }
      Console.WriteLine("the screen kept changing");
      return 2;
    }
  }

  /** The 32x32 pixels around x, y, once the pointer is at px, py and the screen has had time to show it. */
  static byte[] Spot(Capture capture, int px, int py, int x, int y) {
    Input.Pointer(px, py, 0);
    Stopwatch clock = Stopwatch.StartNew();
    while (clock.ElapsedMilliseconds < 700) capture.Next(50);
    byte[] spot = new byte[32 * 32 * 4];
    for (int row = 0; row < 32; row++) Buffer.BlockCopy(capture.Frame, ((y - 16 + row) * capture.Width + x - 16) * 4, spot, row * 128, 128);
    return spot;
  }

  static bool Same(byte[] a, byte[] b) {
    for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }

  static int Main(string[] args) {
    string mode = args.Length > 0 ? args[0] : "";
    if (mode == "connect") return Connect.Run();
    if (mode == "serve") return new Server().Run();
    if (mode == "test") return SelfTest();
    if (mode == "pointer") return PointerTest();
    Console.Error.WriteLine("usage: bb-box-stream.exe serve|connect|test|pointer");
    return 2;
  }
}

// MARK: connect

static class Connect {
  public static int Run() {
    NamedPipeClientStream pipe = Open(500);
    if (pipe == null) {
      // The server runs in box's desktop session, through its task.
      Process.Start(new ProcessStartInfo("schtasks.exe", "/run /tn \"" + Program.TASK + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true }).WaitForExit();
      Stopwatch waited = Stopwatch.StartNew();
      while (pipe == null && waited.ElapsedMilliseconds < 15000) pipe = Open(500);
    }
    if (pipe == null) {
      Program.Log("the server did not start: see %LOCALAPPDATA%\\bb-box\\stream.log");
      return 1;
    }
    Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
    string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "bb-box");
    if (File.Exists(Path.Combine(folder, "trace"))) trace = new StreamWriter(Path.Combine(folder, "connect-" + Process.GetCurrentProcess().Id + ".log")) { AutoFlush = true };
    Thread down = new Thread(() => { Pump(pipe, output, "out"); Environment.Exit(0); });
    down.IsBackground = true;
    down.Start();
    Pump(input, pipe, "in");
    try { pipe.WaitForPipeDrain(); } catch (Exception) { }
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }

  static NamedPipeClientStream Open(int timeoutMs) {
    // Overlapped: a synchronous pipe handle lets one read or write through at a time, so a waiting read would block every write.
    NamedPipeClientStream pipe = new NamedPipeClientStream(".", Program.PIPE, PipeDirection.InOut, PipeOptions.Asynchronous);
    try {
      pipe.Connect(timeoutMs);
      return pipe;
    } catch (Exception) {
      pipe.Dispose();
      return null;
    }
  }

  static StreamWriter trace;

  static void Pump(Stream from, Stream to, string name) {
    byte[] buffer = new byte[1 << 16];
    try {
      for (int n; (n = from.Read(buffer, 0, buffer.Length)) > 0; ) {
        if (trace != null) lock (trace) trace.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + name + " " + n);
        to.Write(buffer, 0, n);
        to.Flush();
      }
      if (trace != null) lock (trace) trace.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + name + " ended");
    } catch (Exception error) {
      if (trace != null) lock (trace) trace.WriteLine(name + " failed: " + error.Message);
    }
  }
}

// MARK: WebSocket

/** One WebSocket client, on its own reading thread; writes go through a queue of their own, counted. */
class Client {
  public readonly int Id;
  readonly Stream stream;
  readonly object gate = new object();
  readonly Queue<byte[]> queue = new Queue<byte[]>();
  int pending;
  bool closed, writing;
  /** Whether it asked for video and not since for none. */
  public volatile bool WantsVideo;
  /** Its frames were dropped: it gets none until a key frame. */
  public volatile bool NeedsKey = true;

  public Client(int id, Stream stream) { Id = id; this.stream = stream; }

  public bool Behind { get { lock (gate) return pending > Program.BEHIND_BYTES; } }

  public void Send(byte opcode, byte[] payload) {
    int length = payload.Length;
    int head = length < 126 ? 2 : length < 65536 ? 4 : 10;
    byte[] frame = new byte[head + length];
    frame[0] = (byte)(0x80 | opcode);
    if (length < 126) frame[1] = (byte)length;
    else if (length < 65536) { frame[1] = 126; frame[2] = (byte)(length >> 8); frame[3] = (byte)length; }
    else { frame[1] = 127; for (int i = 0; i < 8; i++) frame[2 + i] = (byte)((long)length >> (56 - 8 * i)); }
    Buffer.BlockCopy(payload, 0, frame, head, length);
    lock (gate) {
      if (closed) return;
      queue.Enqueue(frame);
      pending += frame.Length;
      if (writing) return;
      writing = true;
    }
    ThreadPool.QueueUserWorkItem(_ => Drain());
  }

  void Drain() {
    while (true) {
      byte[] frame;
      lock (gate) {
        if (queue.Count == 0 || closed) { writing = false; return; }
        frame = queue.Dequeue();
      }
      try {
        stream.Write(frame, 0, frame.Length);
        stream.Flush();
      } catch (Exception) {
        lock (gate) closed = true;
      }
      lock (gate) pending -= frame.Length;
    }
  }

  public void Text(string text) { Send(1, Encoding.UTF8.GetBytes(text)); }
  public void Binary(byte[] data) { Send(2, data); }

  public void Close() {
    lock (gate) closed = true;
    try { stream.Dispose(); } catch (Exception) { }
  }

  byte[] ReadExactly(int count) {
    byte[] data = new byte[count];
    for (int offset = 0; offset < count; ) {
      int n = stream.Read(data, offset, count - offset);
      if (n <= 0) return null;
      offset += n;
    }
    return data;
  }

  /** Answers the HTTP upgrade; false when it is not one. */
  public bool Handshake() {
    List<byte> request = new List<byte>();
    while (!(request.Count >= 4 && request[request.Count - 4] == 13 && request[request.Count - 3] == 10 && request[request.Count - 2] == 13 && request[request.Count - 1] == 10)) {
      if (request.Count > 16384) return false;
      byte[] one = ReadExactly(1);
      if (one == null) return false;
      request.Add(one[0]);
    }
    string key = null;
    foreach (string line in Encoding.UTF8.GetString(request.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None)) {
      int colon = line.IndexOf(':');
      if (colon > 0 && line.Substring(0, colon).Trim().ToLowerInvariant() == "sec-websocket-key") key = line.Substring(colon + 1).Trim();
    }
    if (key == null) return false;
    string accept;
    using (SHA1 sha = SHA1.Create()) accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
    byte[] reply = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    stream.Write(reply, 0, reply.Length);
    stream.Flush();
    return true;
  }

  /** The next text message; "" for a binary one, which nothing here takes; null at the end. */
  public string NextText() {
    List<byte> message = new List<byte>();
    int opcode = 0;
    while (true) {
      byte[] head = ReadExactly(2);
      if (head == null) return null;
      bool fin = (head[0] & 0x80) != 0;
      int op = head[0] & 0x0f;
      bool masked = (head[1] & 0x80) != 0;
      long length = head[1] & 0x7f;
      if (length == 126) { byte[] more = ReadExactly(2); if (more == null) return null; length = (more[0] << 8) | more[1]; }
      else if (length == 127) { byte[] more = ReadExactly(8); if (more == null) return null; length = 0; foreach (byte b in more) length = (length << 8) | b; }
      if (length > (64 << 20)) return null;
      byte[] mask = masked ? ReadExactly(4) : null;
      if (masked && mask == null) return null;
      byte[] payload = length > 0 ? ReadExactly((int)length) : new byte[0];
      if (payload == null) return null;
      if (masked) for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
      if (op == 8) { Send(8, new byte[0]); return null; }
      if (op == 9) { Send(10, payload); continue; }
      if (op == 10) continue;
      if (op != 0) { opcode = op; message.Clear(); }
      message.AddRange(payload);
      if (fin) return opcode == 1 ? Encoding.UTF8.GetString(message.ToArray()) : "";
    }
  }
}

// MARK: Input

/** Posts the controlling viewer's keys and pointer with SendInput. Positions come in the frame's pixels. */
static class Input {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public int dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public int type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char c);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  const int MOUSE_MOVE = 1, LEFT_DOWN = 2, LEFT_UP = 4, RIGHT_DOWN = 8, RIGHT_UP = 0x10, MIDDLE_DOWN = 0x20, MIDDLE_UP = 0x40, WHEEL = 0x800, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const int KEY_UP = 2, EXTENDED = 1, UNICODE = 4;

  /** Virtual keys of keys that type no character, by X keysym. */
  static readonly Dictionary<int, ushort> SPECIAL = new Dictionary<int, ushort> {
    { 0xff08, 0x08 }, { 0xff09, 0x09 }, { 0xff0d, 0x0D }, { 0xff1b, 0x1B }, { 0xffff, 0x2E }, { 0xff63, 0x2D }, { 0xff50, 0x24 }, { 0xff51, 0x25 },
    { 0xff52, 0x26 }, { 0xff53, 0x27 }, { 0xff54, 0x28 }, { 0xff55, 0x21 }, { 0xff56, 0x22 }, { 0xff57, 0x23 }, { 0xff8d, 0x0D }, { 0xffe1, 0xA0 },
    { 0xffe2, 0xA1 }, { 0xffe3, 0xA2 }, { 0xffe4, 0xA3 }, { 0xffe5, 0x14 }, { 0xffe7, 0x5B }, { 0xffe8, 0x5C }, { 0xffe9, 0xA4 }, { 0xffea, 0xA5 },
    { 0xffeb, 0x5B }, { 0xffec, 0x5C }, { 0xff61, 0x2C }, { 0xff13, 0x13 }, { 0xff14, 0x91 }, { 0xff7f, 0x90 }, { 0xff67, 0x5D },
  };
  /** Keys whose scan code is an extended one. */
  static readonly HashSet<ushort> EXTENDED_KEYS = new HashSet<ushort> { 0x2E, 0x2D, 0x24, 0x25, 0x26, 0x27, 0x28, 0x21, 0x22, 0x23, 0xA3, 0xA5, 0x5B, 0x5C, 0x5D, 0x2C, 0x90 };

  static readonly HashSet<ushort> held = new HashSet<ushort>();
  /** Keysyms whose key went down as the character itself, so it goes up so too. */
  static readonly HashSet<int> typed = new HashSet<int>();
  static int mask;
  /** Frame pixels per virtual-screen pixel, should the frame differ from the screen. */
  public static double ScaleX = 1, ScaleY = 1;

  /** The character a keysym types, or -1 for a key that types none. */
  static int Character(int keysym) {
    return keysym >= 0x1000000 ? keysym - 0x1000000 : keysym >= 0x20 && keysym <= 0xff ? keysym : -1;
  }

  static ushort? VirtualKey(int keysym) {
    if (keysym >= 0xffbe && keysym <= 0xffc9) return (ushort)(0x70 + keysym - 0xffbe);
    ushort special;
    if (SPECIAL.TryGetValue(keysym, out special)) return special;
    int code = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym <= 0xff ? keysym : -1;
    if (code < 0 || code > 0xffff) return null;
    short scan = VkKeyScanW((char)code);
    if (scan == -1) return null;
    return (ushort)(scan & 0xff);
  }

  static bool Holds(ushort left, ushort right) {
    return held.Contains(left) || held.Contains(right);
  }

  /**
   * Whether a character goes in as itself rather than as its key: one the box's
   * layout has no key for, such as é on a US one, or one whose key needs a
   * Shift, Ctrl or Alt the page does not hold, as for ! from a French
   * keyboard, which the key alone would type as 1. Never while Ctrl, Alt or
   * Windows is held, so a shortcut stays keys, nor for Space, so Shift+Space
   * does too.
   */
  static bool AsCharacter(int keysym) {
    int code = Character(keysym);
    if (code <= 0x20) return false;
    if (Holds(0xA2, 0xA3) || Holds(0xA4, 0xA5) || Holds(0x5B, 0x5C)) return false;
    if (code > 0xffff) return true;
    short scan = VkKeyScanW((char)code);
    if (scan == -1) return true;
    int state = (scan >> 8) & 0xff;
    return (state & 6) != 0 || ((state & 1) != 0) != Holds(0xA0, 0xA1);
  }

  /** A character as a key event of its own, VK_PACKET, in UTF-16 code units as Windows takes it. */
  static void CharacterEvent(int code, bool down) {
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return;
    string text = char.ConvertFromUtf32(code);
    foreach (char unit in text) {
      INPUT input = new INPUT { type = 1 };
      input.ki.wScan = unit;
      input.ki.dwFlags = UNICODE | (down ? 0 : KEY_UP);
      Send(input);
    }
  }

  static void Send(INPUT input) {
    SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }

  static void KeyEvent(ushort vk, bool down) {
    INPUT input = new INPUT { type = 1 };
    input.ki.wVk = vk;
    // With its scan code, as a keyboard sends it: without one, WinUI apps such as Notepad drop keys and Shift.
    input.ki.wScan = (ushort)MapVirtualKeyW(vk, 0);
    input.ki.dwFlags = (down ? 0 : KEY_UP) | (EXTENDED_KEYS.Contains(vk) ? EXTENDED : 0);
    Send(input);
  }

  public static void Key(int keysym, bool down) {
    if (down ? AsCharacter(keysym) : typed.Contains(keysym)) {
      if (down) typed.Add(keysym); else typed.Remove(keysym);
      CharacterEvent(Character(keysym), down);
      return;
    }
    ushort? vk = VirtualKey(keysym);
    if (vk == null) return;
    if (down) held.Add(vk.Value); else held.Remove(vk.Value);
    KeyEvent(vk.Value, down);
  }

  /** A character as itself, whatever key would type it, as bb-box sends one QEMU's VNC server would type otherwise (cd, cu). */
  public static void Character(int codePoint, bool down) {
    int keysym = 0x1000000 | codePoint;
    if (down) typed.Add(keysym); else typed.Remove(keysym);
    CharacterEvent(codePoint, down);
  }

  public static void ReleaseKeys() {
    foreach (ushort vk in held) KeyEvent(vk, false);
    held.Clear();
    foreach (int keysym in typed) CharacterEvent(Character(keysym), false);
    typed.Clear();
  }

  // Selkies' mask: 1 primary, 2 middle, 4 secondary.
  public static void Pointer(int x, int y, int next) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = Math.Max(1, GetSystemMetrics(78)), height = Math.Max(1, GetSystemMetrics(79));
    double px = x / ScaleX, py = y / ScaleY;
    INPUT move = new INPUT { type = 0 };
    move.mi.dx = (int)Math.Round((px - left) * 65535.0 / Math.Max(1, width - 1));
    move.mi.dy = (int)Math.Round((py - top) * 65535.0 / Math.Max(1, height - 1));
    int flags = MOUSE_MOVE | ABSOLUTE | VIRTUALDESK;
    if (((next ^ mask) & 1) != 0) flags |= (next & 1) != 0 ? LEFT_DOWN : LEFT_UP;
    if (((next ^ mask) & 4) != 0) flags |= (next & 4) != 0 ? RIGHT_DOWN : RIGHT_UP;
    if (((next ^ mask) & 2) != 0) flags |= (next & 2) != 0 ? MIDDLE_DOWN : MIDDLE_UP;
    move.mi.dwFlags = flags;
    Send(move);
    mask = next & 7;
  }

  /** Wheel notches, as the panel sends them: a press of bit 8 scrolls down, of bit 16 up. */
  public static void Wheel(int next, int count) {
    int notches = Math.Max(1, Math.Min(count, 64));
    int delta = (next & 8) != 0 ? -120 * notches : (next & 16) != 0 ? 120 * notches : 0;
    if (delta == 0) return;
    INPUT input = new INPUT { type = 0 };
    input.mi.mouseData = delta;
    input.mi.dwFlags = WHEEL;
    Send(input);
  }
}

// MARK: Capture

/** Whole frames of the primary output as BGRA: Desktop Duplication, or GDI when it cannot. */
class Capture : IDisposable {
  [DllImport("d3d11.dll")]
  static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out int level, out IntPtr context);
  delegate int QI(IntPtr self, ref Guid iid, out IntPtr result);
  delegate uint Rel(IntPtr self);
  delegate int GetPtr(IntPtr self, out IntPtr result);
  delegate int EnumOutputs(IntPtr self, uint index, out IntPtr output);
  delegate int Duplicate(IntPtr self, IntPtr device, out IntPtr dup);
  delegate void GetDesc(IntPtr self, IntPtr desc);
  delegate int Acquire(IntPtr self, uint timeout, IntPtr info, out IntPtr resource);
  delegate int Simple(IntPtr self);
  delegate int CreateTex(IntPtr self, IntPtr desc, IntPtr init, out IntPtr tex);
  delegate void Copy(IntPtr self, IntPtr dst, IntPtr src);
  delegate int Map(IntPtr self, IntPtr res, uint sub, int type, uint flags, IntPtr mapped);
  delegate void Unmap(IntPtr self, IntPtr res, uint sub);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int size, flags; public IntPtr cursor; public POINT at; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool icon; public int hotX, hotY; public IntPtr mask, color; }
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  static T Slot<T>(IntPtr obj, int slot) where T : class {
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T));
  }
  static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }
  static IntPtr Query(IntPtr obj, string iid) { Guid g = new Guid(iid); IntPtr r; Check(Slot<QI>(obj, 0)(obj, ref g, out r), "QueryInterface"); return r; }
  static void Release(ref IntPtr obj) { if (obj != IntPtr.Zero) { Slot<Rel>(obj, 2)(obj); obj = IntPtr.Zero; } }

  const int WAIT_TIMEOUT = unchecked((int)0x887A0027);
  IntPtr device, context, duplication, staging;
  readonly IntPtr info = Marshal.AllocHGlobal(64), mapped = Marshal.AllocHGlobal(32);
  public int Width, Height;
  public bool Duplicating { get { return duplication != IntPtr.Zero; } }
  /** The last frame, BGRA, top row first. */
  public byte[] Frame;
  DateTime gdiNext = DateTime.MinValue;
  bool reported;
  /** How often ReleaseFrame failed within, for the log. */
  public int ReleaseFaults;

  /** BB_STREAM_CAPTURE: gdi, or texture to read Desktop Duplication's image through a staging texture. For tests. */
  static readonly string Mode = Environment.GetEnvironmentVariable("BB_STREAM_CAPTURE") ?? "";
  bool systemMemory;
  delegate int MapSurface(IntPtr self, IntPtr rect);

  public Capture() {
    if (Mode == "gdi") { Width = GetSystemMetrics(0); Height = GetSystemMetrics(1); Frame = new byte[Width * Height * 4]; return; }
    try { StartDuplication(); } catch (Exception error) { Program.Log("Desktop Duplication: " + error.Message + "; capturing with GDI"); StopDuplication(); }
    if (!Duplicating) { Width = GetSystemMetrics(0); Height = GetSystemMetrics(1); }
    Frame = new byte[Width * Height * 4];
  }

  void StartDuplication() {
    int level;
    // The display adapter's device: WARP's own adapter has no output to duplicate.
    Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context), "D3D11CreateDevice");
    IntPtr dxgiDevice = Query(device, "54ec77fa-1377-44e6-8c32-88fd5f44c84c"), adapter = IntPtr.Zero, output = IntPtr.Zero, output1 = IntPtr.Zero;
    try {
      Check(Slot<GetPtr>(dxgiDevice, 7)(dxgiDevice, out adapter), "GetAdapter");
      Check(Slot<EnumOutputs>(adapter, 7)(adapter, 0, out output), "EnumOutputs");
      output1 = Query(output, "00cddea8-939b-4b83-a340-a685226666cc");
      Check(Slot<Duplicate>(output1, 22)(output1, device, out duplication), "DuplicateOutput");
    } finally { Release(ref output1); Release(ref output); Release(ref adapter); Release(ref dxgiDevice); }
    IntPtr desc = Marshal.AllocHGlobal(64);
    Slot<GetDesc>(duplication, 7)(duplication, desc);
    Width = Marshal.ReadInt32(desc, 0);
    Height = Marshal.ReadInt32(desc, 4);
    systemMemory = Marshal.ReadInt32(desc, 32) != 0;
    Marshal.FreeHGlobal(desc);
    IntPtr texDesc = Marshal.AllocHGlobal(44);
    Marshal.Copy(new[] { Width, Height, 1, 1, 87, 1, 0, 3, 0, 0x20000, 0 }, 0, texDesc, 11);
    Check(Slot<CreateTex>(device, 5)(device, texDesc, IntPtr.Zero, out staging), "CreateTexture2D");
    Marshal.FreeHGlobal(texDesc);
  }

  void StopDuplication() {
    Release(ref staging); Release(ref duplication); Release(ref context); Release(ref device);
  }

  /**
   * The next frame into Frame: true when the screen changed, false when it did not within the timeout. Throws when the
   * size changed or duplication was lost, as when the screen's mode changes: make another Capture.
   */
  public bool Next(int timeoutMs) {
    if (!Duplicating) return NextGdi(timeoutMs);
    string step = "AcquireNextFrame";
    try { return NextDuplicated(timeoutMs, ref step); }
    catch (DivideByZeroException) { throw new Exception("a division by zero in " + step); }
  }

  bool NextDuplicated(int timeoutMs, ref string step) {
    uint before = Program.MaskFloatingPoint();
    if ((before & 0x1F) != 0x1F && !reported) { reported = true; Program.Log("floating-point exceptions were unmasked: 0x" + before.ToString("X")); }
    IntPtr resource;
    int hr = Slot<Acquire>(duplication, 8)(duplication, (uint)timeoutMs, info, out resource);
    if (hr == WAIT_TIMEOUT) return false;
    Check(hr, "AcquireNextFrame");
    bool changed = false, fromScreen = false;
    try {
      // A frame with only the pointer moved has no new image, but the pointer is drawn in, so it counts.
      changed = Marshal.ReadInt64(info, 0) != 0 || Marshal.ReadInt64(info, 8) != 0;
      // On the Basic Display adapter the image is in system memory, which a staging texture's copy reads as black.
      // Its duplicated image is also now and then torn while a page scrolls, part of one frame and part of the next,
      // where GDI's copy of the screen is whole (060), so the frame only says the screen changed, and GDI copies it,
      // once the frame is released. BB_STREAM_CAPTURE=map copies the duplicated image instead.
      if (Marshal.ReadInt64(info, 0) != 0 && systemMemory && Mode != "texture" && Mode != "map") {
        fromScreen = true;
      } else if (Marshal.ReadInt64(info, 0) != 0 && systemMemory && Mode != "texture") {
        step = "MapDesktopSurface";
        Check(Slot<MapSurface>(duplication, 12)(duplication, mapped), "MapDesktopSurface");
        int pitch = Marshal.ReadInt32(mapped, 0);
        IntPtr bits = Marshal.ReadIntPtr(mapped, 8);
        for (int y = 0; y < Height; y++) Marshal.Copy(bits + y * pitch, Frame, y * Width * 4, Width * 4);
        Slot<Simple>(duplication, 13)(duplication);
      } else if (Marshal.ReadInt64(info, 0) != 0) {
        step = "QueryInterface";
        IntPtr texture = Query(resource, "6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        step = "CopyResource";
        Slot<Copy>(context, 46)(context, staging, texture);
        Release(ref texture);
        step = "Map";
        Check(Slot<Map>(context, 14)(context, staging, 0, 1, 0, mapped), "Map");
        step = "copy out";
        IntPtr bits = Marshal.ReadIntPtr(mapped, 0);
        int pitch = Marshal.ReadInt32(mapped, IntPtr.Size);
        for (int y = 0; y < Height; y++) Marshal.Copy(bits + y * pitch, Frame, y * Width * 4, Width * 4);
        step = "Unmap";
        Slot<Unmap>(context, 15)(context, staging, 0);
      }
    } finally {
      step = "ReleaseFrame";
      Release(ref resource);
      // DXGI's ReleaseFrame on the Basic Display adapter now and then divides by zero within; the frame is copied by
      // then, and the next AcquireNextFrame works, so it counts as released.
      try { Slot<Simple>(duplication, 14)(duplication); } catch (DivideByZeroException) { ReleaseFaults++; }
    }
    if (fromScreen) {
      step = "copy the screen";
      CopyScreen();
    }
    return changed;
  }

  /** GDI, at most 30 times a second; it cannot tell a change, so it says each frame changed. */
  bool NextGdi(int timeoutMs) {
    TimeSpan wait = gdiNext - DateTime.UtcNow;
    if (wait > TimeSpan.Zero) Thread.Sleep(wait);
    gdiNext = DateTime.UtcNow.AddMilliseconds(33);
    CopyScreen();
    return true;
  }

  /** The screen into Frame, through GDI. */
  void CopyScreen() {
    if (GetSystemMetrics(0) != Width || GetSystemMetrics(1) != Height) throw new Exception("the screen's size changed");
    // BitBlt into a DIB section made once, about 10% quicker than GDI+'s CopyFromScreen, which makes and copies back a
    // DIB of its own each time (060). Reading the screen takes about 16 ms however little of it is read.
    if (copyDib == IntPtr.Zero) {
      byte[] header = new byte[40];
      BitConverter.GetBytes(40).CopyTo(header, 0);
      BitConverter.GetBytes(Width).CopyTo(header, 4);
      BitConverter.GetBytes(-Height).CopyTo(header, 8);
      BitConverter.GetBytes((short)1).CopyTo(header, 12);
      BitConverter.GetBytes((short)32).CopyTo(header, 14);
      screenDc = GetDC(IntPtr.Zero);
      copyDc = CreateCompatibleDC(screenDc);
      copyDib = CreateDIBSection(screenDc, header, 0, out copyBits, IntPtr.Zero, 0);
      if (copyDib == IntPtr.Zero) throw new Exception("GDI could not make a DIB section to copy the screen into");
      SelectObject(copyDc, copyDib);
    }
    if (!BitBlt(copyDc, 0, 0, Width, Height, screenDc, 0, 0, SRCCOPY)) throw new Exception("GDI could not copy the screen");
    GdiFlush();
    Marshal.Copy(copyBits, Frame, 0, Frame.Length);
  }

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, byte[] info, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern bool GdiFlush();
  const uint SRCCOPY = 0x00CC0020;
  IntPtr screenDc, copyDc, copyDib, copyBits;

  void StopCopy() {
    if (copyDc != IntPtr.Zero) { DeleteDC(copyDc); copyDc = IntPtr.Zero; }
    if (copyDib != IntPtr.Zero) { DeleteObject(copyDib); copyDib = IntPtr.Zero; }
    if (screenDc != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, screenDc); screenDc = IntPtr.Zero; }
  }

  /** The pointer's cursor now, or zero while it is hidden. */
  public static IntPtr CurrentCursor() {
    CURSORINFO cursor = new CURSORINFO { size = Marshal.SizeOf(typeof(CURSORINFO)) };
    return GetCursorInfo(ref cursor) && (cursor.flags & 1) != 0 ? cursor.cursor : IntPtr.Zero;
  }

  /** A cursor's shape as Selkies' cursor message, its image as PNG and its hot spot, for the panel to show on the browser's pointer; null when it cannot be read. */
  public static string CursorShape(IntPtr cursor) {
    ICONINFO icon;
    if (cursor == IntPtr.Zero || !GetIconInfo(cursor, out icon)) return null;
    if (icon.mask != IntPtr.Zero) DeleteObject(icon.mask);
    if (icon.color != IntPtr.Zero) DeleteObject(icon.color);
    try {
      // ToBitmap keeps a colour cursor's alpha, and makes a monochrome one's mask transparent.
      using (Icon shape = Icon.FromHandle(cursor))
      using (Bitmap bitmap = shape.ToBitmap())
      using (MemoryStream png = new MemoryStream()) {
        bitmap.Save(png, ImageFormat.Png);
        return "cursor,{\"curdata\":\"" + Convert.ToBase64String(png.ToArray()) + "\",\"hotx\":" + icon.hotX + ",\"hoty\":" + icon.hotY + "}";
      }
    } catch (Exception) { return null; }
  }

  /** Draws the pointer into a copy of Frame, as it shows on the screen. */
  public byte[] WithPointer() {
    byte[] copy = (byte[])Frame.Clone();
    CURSORINFO cursor = new CURSORINFO { size = Marshal.SizeOf(typeof(CURSORINFO)) };
    if (!GetCursorInfo(ref cursor) || (cursor.flags & 1) == 0 || cursor.cursor == IntPtr.Zero) return copy;
    ICONINFO icon;
    if (!GetIconInfo(cursor.cursor, out icon)) return copy;
    int left = cursor.at.x - icon.hotX - GetSystemMetrics(76), top = cursor.at.y - icon.hotY - GetSystemMetrics(77);
    bool monochrome = icon.color == IntPtr.Zero && icon.mask != IntPtr.Zero;
    if (monochrome) {
      try { DrawMonochrome(copy, cursor.cursor, icon.mask, left, top); } catch (Exception) { }
    }
    if (icon.mask != IntPtr.Zero) DeleteObject(icon.mask);
    if (icon.color != IntPtr.Zero) DeleteObject(icon.color);
    if (monochrome) return copy;
    GCHandle pin = GCHandle.Alloc(copy, GCHandleType.Pinned);
    try {
      using (Bitmap bitmap = new Bitmap(Width, Height, Width * 4, PixelFormat.Format32bppRgb, pin.AddrOfPinnedObject()))
      using (Graphics g = Graphics.FromImage(bitmap)) {
        IntPtr hdc = g.GetHdc();
        DrawIconEx(hdc, left, top, cursor.cursor, 0, 0, 0, IntPtr.Zero, 3);
        g.ReleaseHdc(hdc);
      }
    } finally { pin.Free(); }
    return copy;
  }

  /** The last monochrome cursor drawn, and its AND and XOR masks, read once for each cursor. */
  IntPtr maskedCursor;
  bool[] andMask, xorMask;
  int maskWidth, maskHeight;

  /**
   * Draws a monochrome cursor as Windows does: each pixel ANDed with its AND mask, then XORed with its XOR mask, so
   * the I-beam inverts what it is over. DrawIconEx through GDI+ left it nearly invisible on Windows on a Mac (the
   * desktop sweep): the darkest of its pixels over white was 244.
   */
  void DrawMonochrome(byte[] frame, IntPtr cursor, IntPtr mask, int left, int top) {
    if (cursor != maskedCursor) {
      using (Bitmap bits = Image.FromHbitmap(mask)) {
        maskWidth = bits.Width;
        maskHeight = bits.Height / 2;
        andMask = new bool[maskWidth * maskHeight];
        xorMask = new bool[maskWidth * maskHeight];
        for (int y = 0; y < maskHeight; y++) {
          for (int x = 0; x < maskWidth; x++) {
            andMask[y * maskWidth + x] = bits.GetPixel(x, y).GetBrightness() > 0.5f;
            xorMask[y * maskWidth + x] = bits.GetPixel(x, y + maskHeight).GetBrightness() > 0.5f;
          }
        }
      }
      maskedCursor = cursor;
    }
    for (int y = 0; y < maskHeight; y++) {
      int row = top + y;
      if (row < 0 || row >= Height) continue;
      for (int x = 0; x < maskWidth; x++) {
        int column = left + x;
        if (column < 0 || column >= Width) continue;
        int at = (row * Width + column) * 4;
        bool and = andMask[y * maskWidth + x], xor = xorMask[y * maskWidth + x];
        for (int c = 0; c < 3; c++) {
          int value = and ? frame[at + c] : 0;
          frame[at + c] = (byte)(xor ? 255 - value : value);
        }
      }
    }
  }

  public void Dispose() { StopDuplication(); StopCopy(); }
}

// MARK: Encoder

/** Cisco's OpenH264, for screen content in real time, as Annex B with the parameter sets on each key frame. */
class Encoder : IDisposable {
  [DllImport("openh264.dll")] static extern int WelsCreateSVCEncoder(out IntPtr encoder);
  [DllImport("openh264.dll")] static extern void WelsDestroySVCEncoder(IntPtr encoder);

  delegate int InitExt(IntPtr self, IntPtr param);
  delegate int GetDefaults(IntPtr self, IntPtr param);
  /** SEncParamExt's size in OpenH264 2.6, with room to spare. */
  const int PARAM_EXT_SIZE = 1024;
  /** The coarsest quantiser a frame may have: text stays sharp, at more bits for busy motion. */
  const int MAX_QP = 26;
  delegate int Uninit(IntPtr self);
  delegate int EncodeFrame(IntPtr self, IntPtr source, IntPtr info);
  delegate int ForceIntra(IntPtr self, bool idr);

  // OpenH264 2.6's codec_app_def.h: SFrameBSInfo is iLayerNum, then 128 SLayerBSInfo of 56 bytes from offset 8, then
  // eFrameType. SSourcePicture is 80 bytes, its last three PSNR switches off.
  const int LAYERS = 8, LAYER_SIZE = 56, FRAME_TYPE = 8 + 128 * LAYER_SIZE, INFO_SIZE = FRAME_TYPE + 16, SOURCE_SIZE = 80;
  const int IDR = 1, SKIP = 4;
  IntPtr encoder;
  readonly IntPtr source = Marshal.AllocHGlobal(SOURCE_SIZE), info = Marshal.AllocHGlobal(INFO_SIZE);
  readonly byte[] y, u, v;
  readonly GCHandle hy, hu, hv;
  public readonly int Width, Height;
  long time;

  static T Slot<T>(IntPtr obj, int slot) where T : class {
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T));
  }

  public Encoder(int width, int height) {
    // H.264 wants even sizes: an odd column or row is left out.
    Width = width & ~1;
    Height = height & ~1;
    if (WelsCreateSVCEncoder(out encoder) != 0 || encoder == IntPtr.Zero) throw new Exception("OpenH264 could not make an encoder");
    // SEncParamExt from OpenH264's defaults, at 2.6's offsets (codec_app_def.h): screen content in real time, at most
    // QP 26 so text keeps its edges, bitrate control at 8 bits a pixel a second, no frames skipped, four threads.
    IntPtr param = Marshal.AllocHGlobal(PARAM_EXT_SIZE);
    for (int i = 0; i < PARAM_EXT_SIZE; i++) Marshal.WriteByte(param, i, 0);
    Slot<GetDefaults>(encoder, 2)(encoder, param);
    int bitrate = Math.Max(4000000, Width * Height * 8);
    Marshal.WriteInt32(param, 0, 1);
    Marshal.WriteInt32(param, 4, Width);
    Marshal.WriteInt32(param, 8, Height);
    Marshal.WriteInt32(param, 12, bitrate);
    Marshal.WriteInt32(param, 16, 1);
    Marshal.Copy(new[] { 60f }, 0, param + 20, 1);
    Marshal.WriteInt32(param, 28, 1);
    Marshal.WriteInt32(param, 32, Width);
    Marshal.WriteInt32(param, 36, Height);
    Marshal.Copy(new[] { 60f }, 0, param + 40, 1);
    Marshal.WriteInt32(param, 44, bitrate);
    Marshal.WriteInt32(param, 48, bitrate * 2);
    Marshal.WriteByte(param, 860, 0);
    Marshal.WriteInt32(param, 864, bitrate * 2);
    Marshal.WriteInt32(param, 868, MAX_QP);
    Marshal.WriteInt32(param, 872, 10);
    Marshal.WriteInt16(param, 892, 4);
    int ok = Slot<InitExt>(encoder, 1)(encoder, param);
    Program.MaskFloatingPoint();
    Marshal.FreeHGlobal(param);
    if (ok != 0) throw new Exception("OpenH264 did not initialise: " + ok);
    y = new byte[Width * Height]; u = new byte[Width * Height / 4]; v = new byte[Width * Height / 4];
    hy = GCHandle.Alloc(y, GCHandleType.Pinned); hu = GCHandle.Alloc(u, GCHandleType.Pinned); hv = GCHandle.Alloc(v, GCHandleType.Pinned);
    for (int i = 0; i < SOURCE_SIZE; i++) Marshal.WriteByte(source, i, 0);
    Marshal.WriteInt32(source, 0, 23);
    Marshal.WriteInt32(source, 4, Width);
    Marshal.WriteInt32(source, 8, Width / 2);
    Marshal.WriteInt32(source, 12, Width / 2);
    Marshal.WriteIntPtr(source, 24, hy.AddrOfPinnedObject());
    Marshal.WriteIntPtr(source, 32, hu.AddrOfPinnedObject());
    Marshal.WriteIntPtr(source, 40, hv.AddrOfPinnedObject());
    Marshal.WriteInt32(source, 56, Width);
    Marshal.WriteInt32(source, 60, Height);
  }

  /** BGRA to I420, BT.601 limited range, which is what a decoder takes H.264 to be when it says nothing else. */
  unsafe void ToI420(byte[] bgra, int stride) {
    fixed (byte* s = bgra, py = y, pu = u, pv = v) {
      for (int j = 0; j < Height; j++) {
        byte* row = s + j * stride;
        byte* yr = py + j * Width;
        for (int i = 0; i < Width; i++) {
          int b = row[i * 4], g = row[i * 4 + 1], r = row[i * 4 + 2];
          yr[i] = (byte)(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
        }
      }
      int half = Width / 2;
      for (int j = 0; j < Height / 2; j++) {
        byte* top = s + j * 2 * stride, bottom = top + stride;
        for (int i = 0; i < half; i++) {
          int k = i * 8;
          int b = (top[k] + top[k + 4] + bottom[k] + bottom[k + 4] + 2) >> 2;
          int g = (top[k + 1] + top[k + 5] + bottom[k + 1] + bottom[k + 5] + 2) >> 2;
          int r = (top[k + 2] + top[k + 6] + bottom[k + 2] + bottom[k + 6] + 2) >> 2;
          pu[j * half + i] = (byte)(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
          pv[j * half + i] = (byte)(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
        }
      }
    }
  }

  /** Encodes a frame of the capture's width; null when the encoder skipped it. */
  public byte[] Encode(byte[] bgra, int stride, bool key, out bool isKey) {
    isKey = false;
    if (key) Slot<ForceIntra>(encoder, 6)(encoder, true);
    ToI420(bgra, stride);
    time += 16;
    Marshal.WriteInt64(source, 64, time);
    for (int i = 0; i < INFO_SIZE; i += 8) Marshal.WriteInt64(info, i, 0);
    int encoded = Slot<EncodeFrame>(encoder, 4)(encoder, source, info);
    Program.MaskFloatingPoint();
    if (encoded != 0) return null;
    int type = Marshal.ReadInt32(info, FRAME_TYPE);
    if (type == SKIP) return null;
    isKey = type == IDR;
    int layers = Marshal.ReadInt32(info, 0);
    MemoryStream output = new MemoryStream();
    for (int l = 0; l < layers && l < 128; l++) {
      IntPtr layer = info + LAYERS + l * LAYER_SIZE;
      int nals = Marshal.ReadInt32(layer, 16);
      IntPtr lengths = Marshal.ReadIntPtr(layer, 24), bits = Marshal.ReadIntPtr(layer, 32);
      int size = 0;
      for (int n = 0; n < nals; n++) size += Marshal.ReadInt32(lengths, n * 4);
      byte[] chunk = new byte[size];
      Marshal.Copy(bits, chunk, 0, size);
      output.Write(chunk, 0, size);
    }
    return output.Length > 0 ? output.ToArray() : null;
  }

  public void Dispose() {
    if (encoder != IntPtr.Zero) { Slot<Uninit>(encoder, 3)(encoder); WelsDestroySVCEncoder(encoder); encoder = IntPtr.Zero; }
    hy.Free(); hu.Free(); hv.Free();
  }
}

// MARK: Server

class Server {
  readonly object gate = new object();
  readonly Dictionary<int, Client> clients = new Dictionary<int, Client>();
  int nextClient;
  DateTime lastClientAt = DateTime.UtcNow;
  volatile bool keyAsked = true;
  /** Whether the video draws the pointer in, as bb-box's BB_CURSOR last said: not while a person holds control, whose browser shows its shape. */
  volatile bool showsCursor = true;
  /** The pointer's shape as Selkies' cursor message, as last sent, for each new client. */
  volatile string cursorMessage;
  ushort frameId;
  Thread capturing;
  readonly Dictionary<string, MemoryStream> clipboardParts = new Dictionary<string, MemoryStream>();
  /** Each binary paste's MIME type, by its transfer ID, as cbs gives it. */
  readonly Dictionary<string, string> binaryTypes = new Dictionary<string, string>();
  ClipboardThread clipboard;

  static Mutex one;

  public int Run() {
    // One server a box: another started first, as two connections may start one each.
    bool first;
    one = new Mutex(true, "Global\\" + Program.PIPE, out first);
    if (!first) { Program.Log("another server is running"); return 0; }
    clipboard = new ClipboardThread(text => Broadcast("clipboard," + Convert.ToBase64String(Encoding.UTF8.GetBytes(text))), BroadcastImage);
    Program.Log("serving on \\\\.\\pipe\\" + Program.PIPE);
    // The pointer's shape, to the clients, when it changes: the panel shows it on the browser's own pointer while its person holds control.
    new Thread(() => {
      IntPtr last = IntPtr.Zero;
      while (true) {
        Thread.Sleep(100);
        IntPtr cursor = Capture.CurrentCursor();
        if (cursor == IntPtr.Zero || cursor == last) continue;
        last = cursor;
        string message = Capture.CursorShape(cursor);
        if (message == null) continue;
        cursorMessage = message;
        Broadcast(message);
      }
    }) { IsBackground = true }.Start();
    // The idle exit.
    new Thread(() => {
      while (true) {
        Thread.Sleep(5000);
        lock (gate) if (clients.Count == 0 && (DateTime.UtcNow - lastClientAt).TotalMilliseconds > Program.IDLE_EXIT_MS) { Program.Log("no client for a minute; exiting"); Environment.Exit(0); }
      }
    }) { IsBackground = true }.Start();
    PipeSecurity security = new PipeSecurity();
    security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
    while (true) {
      NamedPipeServerStream pipe = new NamedPipeServerStream(Program.PIPE, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1 << 16, 1 << 16, security);
      pipe.WaitForConnection();
      NamedPipeServerStream accepted = pipe;
      new Thread(() => Serve(accepted)) { IsBackground = true }.Start();
    }
  }

  void Serve(Stream stream) {
    Client client;
    lock (gate) {
      client = new Client(++nextClient, stream);
      clients[client.Id] = client;
      lastClientAt = DateTime.UtcNow;
    }
    try {
      if (client.Handshake()) {
        // Selkies speaks first; the relay waits for a first message.
        client.Text("MODE websockets");
        string shape = cursorMessage;
        if (shape != null) client.Text(shape);
        bool trace = File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "bb-box", "trace"));
        for (string text; (text = client.NextText()) != null; ) {
          if (trace) Program.Log("client " + client.Id + ": " + (text.Length > 60 ? text.Substring(0, 60) : text));
          if (text.Length > 0) Handle(text, client);
        }
        if (trace) Program.Log("client " + client.Id + " ended");
      }
    } catch (Exception) { }
    client.Close();
    lock (gate) {
      clients.Remove(client.Id);
      lastClientAt = DateTime.UtcNow;
    }
  }

  void Broadcast(string text) {
    List<Client> all;
    lock (gate) all = new List<Client>(clients.Values);
    foreach (Client client in all) client.Text(text);
  }

  /** An image copied in the box, to the clients: in one message, or in parts as Selkies sends a large one. */
  void BroadcastImage(string mime, byte[] data) {
    if (data.Length <= Program.CLIPBOARD_CHUNK) {
      Broadcast("clipboard_binary," + mime + "," + Convert.ToBase64String(data));
      return;
    }
    Broadcast("clipboard_start," + mime + "," + data.Length);
    for (int at = 0; at < data.Length; at += Program.CLIPBOARD_CHUNK) {
      Broadcast("clipboard_data," + Convert.ToBase64String(data, at, Math.Min(Program.CLIPBOARD_CHUNK, data.Length - at)));
    }
    Broadcast("clipboard_finish");
  }

  static int Field(string[] fields, int index) {
    int value;
    return index < fields.Length && int.TryParse(fields[index], out value) ? value : 0;
  }

  void Handle(string text, Client client) {
    string[] fields = text.Split(',');
    string verb = fields[0].Split(' ')[0];
    switch (verb) {
      case "START_VIDEO":
        client.WantsVideo = true;
        client.NeedsKey = true;
        keyAsked = true;
        EnsureCapturing();
        break;
      case "STOP_VIDEO":
        client.WantsVideo = false;
        break;
      case "REQUEST_KEYFRAME":
        keyAsked = true;
        break;
      case "kd": case "ku":
        // A paste's chord follows its content at once: the keys wait until it is on the clipboard, up to 5 s.
        clipboard.WaitPasted(5000);
        Input.Key(Field(fields, 1), verb == "kd");
        break;
      case "kr":
        Input.ReleaseKeys();
        break;
      // bb-box: a character as itself, for a key QEMU's VNC server would type otherwise.
      case "cd": case "cu":
        clipboard.WaitPasted(5000);
        Input.Character(Field(fields, 1), verb == "cd");
        break;
      // bb-box: says when the messages before it are handled, so a key QEMU takes after a character cannot overtake it.
      case "BB_PING":
        if (fields.Length > 1) client.Text("BB_PONG," + fields[1]);
        break;
      case "m":
        Input.Pointer(Field(fields, 1), Field(fields, 2), Field(fields, 3));
        break;
      case "m2":
        Input.Wheel(Field(fields, 3), Field(fields, 4));
        break;
      case "BB_CURSOR":
        // bb-box: the pointer out of the video while a person holds control, whose browser shows its shape.
        bool on = Field(fields, 1) != 0;
        if (on != showsCursor) { showsCursor = on; keyAsked = true; Program.Log("the pointer is " + (on ? "in" : "out of") + " the video"); }
        break;
      case "cw":
        if (fields.Length > 1) Paste(Convert.FromBase64String(fields[1]));
        break;
      case "cws":
        if (fields.Length > 1) lock (clipboardParts) clipboardParts[fields[1]] = new MemoryStream();
        break;
      case "cwd":
        if (fields.Length > 2) lock (clipboardParts) { MemoryStream part; if (clipboardParts.TryGetValue(fields[1], out part)) { byte[] data = Convert.FromBase64String(fields[2]); part.Write(data, 0, data.Length); } }
        break;
      case "cwe":
        if (fields.Length > 1) { MemoryStream part = null; lock (clipboardParts) if (clipboardParts.TryGetValue(fields[1], out part)) clipboardParts.Remove(fields[1]); if (part != null) Paste(part.ToArray()); }
        break;
      // An image, or other binary content, from the viewer: cb,<mime>,<base64>, or cbs,<id>,<mime>,<size>, cbd,<id>,<base64>
      // and cbe,<id> in parts, as the panel's video client sends a paste.
      case "cb":
        if (fields.Length > 2) PasteBinary(fields[1], Convert.FromBase64String(fields[2]));
        break;
      case "cbs":
        if (fields.Length > 3 && Field(fields, 3) >= 0 && Field(fields, 3) <= Program.CLIPBOARD_MAX_BYTES) lock (clipboardParts) { clipboardParts[fields[1]] = new MemoryStream(); binaryTypes[fields[1]] = fields[2]; }
        break;
      case "cbd":
        if (fields.Length > 2) lock (clipboardParts) {
          MemoryStream part;
          if (clipboardParts.TryGetValue(fields[1], out part)) {
            byte[] data = Convert.FromBase64String(fields[2]);
            if (part.Length + data.Length > Program.CLIPBOARD_MAX_BYTES) { clipboardParts.Remove(fields[1]); binaryTypes.Remove(fields[1]); }
            else part.Write(data, 0, data.Length);
          }
        }
        break;
      case "cbe":
        if (fields.Length > 1) {
          MemoryStream part = null; string mime = null;
          lock (clipboardParts) if (clipboardParts.TryGetValue(fields[1], out part)) { clipboardParts.Remove(fields[1]); binaryTypes.TryGetValue(fields[1], out mime); binaryTypes.Remove(fields[1]); }
          if (part != null && mime != null) PasteBinary(mime, part.ToArray());
        }
        break;
      default:
        // SETTINGS, CLIENT_FRAME_ACK, a resize and the rest: the desktop keeps its own size and colour.
        break;
    }
  }

  void Paste(byte[] data) { clipboard.Set(Encoding.UTF8.GetString(data)); }

  void PasteBinary(string mime, byte[] data) {
    if (mime.StartsWith("image/") && data.Length <= Program.CLIPBOARD_MAX_BYTES) clipboard.SetImage(mime, data);
  }

  bool AnyWantsVideo() { lock (gate) foreach (Client c in clients.Values) if (c.WantsVideo) return true; return false; }

  void EnsureCapturing() {
    lock (gate) {
      if (capturing != null && capturing.IsAlive) return;
      capturing = new Thread(CaptureLoop) { IsBackground = true };
      capturing.Start();
    }
  }

  /** Captures and encodes while a client wants video; a new capture and encoder when the screen's size changes. */
  void CaptureLoop() {
    while (AnyWantsVideo()) {
      Capture capture = null;
      Encoder encoder = null;
      try {
        capture = new Capture();
        encoder = new Encoder(capture.Width, capture.Height);
        Input.ScaleX = 1; Input.ScaleY = 1;
        Program.Log("capturing " + capture.Width + "x" + capture.Height + (capture.Duplicating ? " with Desktop Duplication" : " with GDI"));
        keyAsked = true;
        // A thread of its own copies the screen while this one encodes the frame before (060): GDI's copy on the
        // Basic Display adapter takes about 20 ms. It keeps only the newest frame for this one to take.
        Capture source = capture;
        object gate = new object();
        byte[] newest = null;
        Exception failed = null;
        bool running = true;
        AutoResetEvent ready = new AutoResetEvent(false);
        Thread copier = new Thread(() => {
          try {
            while (running) {
              if (!source.Next(50)) continue;
              byte[] frame = showsCursor ? source.WithPointer() : (byte[])source.Frame.Clone();
              lock (gate) newest = frame;
              ready.Set();
            }
          } catch (Exception error) {
            failed = error;
            ready.Set();
          }
        }) { IsBackground = true, Name = "copier" };
        copier.Start();
        try {
          byte[] last = null;
          int again = 0;
          Stopwatch still = Stopwatch.StartNew();
          while (AnyWantsVideo()) {
            bool woken = ready.WaitOne(50);
            if (failed != null) throw new Exception("the copy of the screen failed: " + failed.Message, failed);
            byte[] frame = null;
            if (woken) lock (gate) { frame = newest; newest = null; }
            bool changed = frame != null;
            if (changed) { last = frame; again = 2; still.Restart(); }
            bool sharpen = !changed && last != null && again > 0 && still.ElapsedMilliseconds >= Program.STILL_MS * (3 - again);
            if (!changed && !sharpen && !(keyAsked && last != null)) continue;
            if (sharpen) again--;
            bool key = keyAsked;
            keyAsked = false;
            bool isKey;
            byte[] data = encoder.Encode(last, capture.Width * 4, key, out isKey);
            if (data != null) Send(data, isKey, encoder.Width, encoder.Height);
          }
        } finally {
          running = false;
          copier.Join(2000);
        }
      } catch (Exception error) {
        Program.Log("capture: " + error);
        Thread.Sleep(500);
      } finally {
        if (encoder != null) encoder.Dispose();
        if (capture != null) capture.Dispose();
      }
    }
    Program.Log("no client wants video; the capture stops");
  }

  /** Sends a frame to each client that wants video and is keeping up. */
  void Send(byte[] data, bool key, int width, int height) {
    frameId++;
    byte[] message = new byte[12 + data.Length];
    message[0] = 4;
    message[1] = (byte)(1 << 4 | (key ? 1 : 0));
    message[2] = (byte)(frameId >> 8); message[3] = (byte)frameId;
    message[6] = (byte)(width >> 8); message[7] = (byte)width;
    message[8] = (byte)(height >> 8); message[9] = (byte)height;
    Buffer.BlockCopy(data, 0, message, 12, data.Length);
    List<Client> all;
    lock (gate) all = new List<Client>(clients.Values);
    foreach (Client client in all) {
      if (!client.WantsVideo) continue;
      if (client.Behind) { client.NeedsKey = true; continue; }
      if (client.NeedsKey && !key) { keyAsked = true; continue; }
      client.NeedsKey = false;
      client.Binary(message);
    }
  }
}

/**
 * The clipboard, on a thread of its own in a single-threaded apartment, as it needs: changes out, pastes in. Text both
 * ways; images both ways as PNG. A pasted PNG goes on the clipboard as the very bytes it came as, under Windows' PNG
 * format, which browsers and Office read, and as a bitmap (CF_DIB) for apps that read only that, its pixels as they
 * were: never encoded again, as a paste must be exact. A copied image goes out as the PNG an app put on the clipboard,
 * or, where it put only a bitmap, as that bitmap encoded to PNG, which loses nothing.
 */
class ClipboardThread {
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  readonly Action<string> changed;
  readonly Action<string, byte[]> changedImage;
  readonly Queue<Action> pastes = new Queue<Action>();
  readonly AutoResetEvent wake = new AutoResetEvent(false);
  /** Set while no paste waits to go on the clipboard. */
  readonly ManualResetEvent pasted = new ManualResetEvent(true);
  uint seen;

  public ClipboardThread(Action<string> changed, Action<string, byte[]> changedImage) {
    this.changed = changed;
    this.changedImage = changedImage;
    Thread thread = new Thread(Loop) { IsBackground = true };
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
  }

  public void Set(string text) { Queue(() => System.Windows.Forms.Clipboard.SetText(text.Length > 0 ? text : " ")); }

  public void SetImage(string mime, byte[] data) {
    Queue(() => {
      System.Windows.Forms.DataObject content = new System.Windows.Forms.DataObject();
      // The bytes as they came, under the format Windows apps know them by.
      string format = mime == "image/png" ? "PNG" : mime == "image/jpeg" ? "JFIF" : mime == "image/gif" ? "GIF" : mime;
      content.SetData(format, false, new MemoryStream(data));
      // And the picture as a bitmap, where .NET can read it, for apps that take only that.
      try {
        using (MemoryStream read = new MemoryStream(data))
        using (Image image = Image.FromStream(read)) content.SetData(System.Windows.Forms.DataFormats.Dib, false, Dib(image));
      } catch (Exception error) { Program.Log("a pasted " + mime + " went on the clipboard as it came only: " + error.Message); }
      System.Windows.Forms.Clipboard.SetDataObject(content, true);
    });
  }

  /** Waits until any paste the viewer sent is on the clipboard, up to `ms`, so its chord pastes it. */
  public void WaitPasted(int ms) { pasted.WaitOne(ms); }

  void Queue(Action paste) {
    lock (pastes) { pastes.Enqueue(paste); pasted.Reset(); }
    wake.Set();
  }

  /** A packed device-independent bitmap of `image`, 32 bits a pixel, as CF_DIB has it: its header, then its rows, bottom up. */
  static MemoryStream Dib(Image image) {
    using (Bitmap bitmap = new Bitmap(image.Width, image.Height, PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) graphics.DrawImage(image, 0, 0, image.Width, image.Height);
      BitmapData bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        MemoryStream dib = new MemoryStream();
        BinaryWriter writer = new BinaryWriter(dib);
        writer.Write(40); writer.Write(bitmap.Width); writer.Write(bitmap.Height); writer.Write((short)1); writer.Write((short)32);
        writer.Write(0); writer.Write(bitmap.Width * 4 * bitmap.Height); writer.Write(0); writer.Write(0); writer.Write(0); writer.Write(0);
        byte[] row = new byte[bitmap.Width * 4];
        for (int y = bitmap.Height - 1; y >= 0; y--) {
          Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, row.Length);
          writer.Write(row);
        }
        writer.Flush();
        dib.Position = 0;
        return dib;
      } finally { bitmap.UnlockBits(bits); }
    }
  }

  /** The image on the clipboard as PNG: the bytes an app put there as PNG, or its bitmap encoded to PNG; null for none. */
  static byte[] CopiedPng() {
    System.Windows.Forms.IDataObject content = System.Windows.Forms.Clipboard.GetDataObject();
    if (content == null) return null;
    MemoryStream png = content.GetDataPresent("PNG") ? content.GetData("PNG") as MemoryStream : null;
    if (png != null) return png.ToArray();
    if (!System.Windows.Forms.Clipboard.ContainsImage()) return null;
    using (Image image = System.Windows.Forms.Clipboard.GetImage()) {
      if (image == null) return null;
      using (MemoryStream encoded = new MemoryStream()) { image.Save(encoded, ImageFormat.Png); return encoded.ToArray(); }
    }
  }

  void Loop() {
    seen = GetClipboardSequenceNumber();
    while (true) {
      wake.WaitOne(250);
      try {
        Action paste = null;
        lock (pastes) if (pastes.Count > 0) paste = pastes.Dequeue();
        if (paste != null) {
          try { paste(); } catch (Exception error) { Program.Log("could not paste: " + error.Message); }
          seen = GetClipboardSequenceNumber();
          lock (pastes) if (pastes.Count == 0) pasted.Set(); else wake.Set();
          continue;
        }
        uint now = GetClipboardSequenceNumber();
        if (now == seen) continue;
        seen = now;
        // Text where there is text, as an app that copies a table puts its picture there too; else an image.
        if (System.Windows.Forms.Clipboard.ContainsText()) { changed(System.Windows.Forms.Clipboard.GetText()); continue; }
        byte[] image = CopiedPng();
        if (image == null) continue;
        if (image.Length > Program.CLIPBOARD_MAX_BYTES) { Program.Log("a copied image of " + image.Length + " bytes is more than the viewer takes"); continue; }
        changedImage("image/png", image);
      } catch (Exception error) { Program.Log("clipboard: " + error.Message); }
    }
  }
}
