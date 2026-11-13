// ScreenShareRemoteHelper.exe — runs inside the lab agent's session as the system account.
//
//   ScreenShareRemoteHelper.exe input     mouse/keyboard (same commands as inject-windows.ps1) + Ctrl+Alt+Del,
//                                         and reports which desktop has the input ("D Default", "D Winlogon", …)
//   ScreenShareRemoteHelper.exe capture   JPEG frames of the input desktop (for the sign-in, lock and UAC screens,
//                                         which the normal screen capture can't see)
//   ScreenShareRemoteHelper.exe as-user <program> [args…]
//                                         runs a program as the person signed in at the screen, with this helper's
//                                         stdin/stdout/stderr, and ends it when this helper ends. (Windows hides
//                                         the user's clipboard from the system account: the clipboard is read
//                                         through a program started this way.) Exit code 3: nobody is signed in.
//
// Both follow the *input desktop*: Windows shows the sign-in screen, the lock screen and UAC prompts on a separate
// secure desktop ("Winlogon"). Only the system account may open it, and a thread has to be moved onto a desktop
// (SetThreadDesktop) before its input or screen reaches it.
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public const uint DESKTOP_ACCESS = 0x01FF | 0x40000000;   // all desktop rights + GENERIC_WRITE
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desk);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desk);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);

  public static string DesktopName(IntPtr desk) {
    StringBuilder sb = new StringBuilder(256);
    int needed;
    return GetUserObjectInformation(desk, 2 /* UOI_NAME */, sb, sb.Capacity * 2, out needed) ? sb.ToString() : "?";
  }

  // Physical pixels on every monitor (also at 125 % / 150 % scaling).
  public static void DpiAware() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
}

// Keeps the calling thread on whichever desktop currently has the input.
class DesktopFollower {
  IntPtr current = IntPtr.Zero;
  public string Name = "";
  // returns true when the desktop changed
  public bool Sync() {
    IntPtr d = Native.OpenInputDesktop(0, false, Native.DESKTOP_ACCESS);
    if (d == IntPtr.Zero) {
      // can't open it: not running as the system account and the secure desktop is up
      if (Name != "Secure") { Name = "Secure"; return true; }
      return false;
    }
    string name = Native.DesktopName(d);
    if (name == Name && current != IntPtr.Zero) { Native.CloseDesktop(d); return false; }
    if (!Native.SetThreadDesktop(d)) {
      Native.CloseDesktop(d);
      Console.Error.WriteLine("SetThreadDesktop(" + name + ") failed: " + Marshal.GetLastWin32Error());
      return false;
    }
    if (current != IntPtr.Zero) Native.CloseDesktop(current);
    current = d;
    bool changed = name != Name;
    Name = name;
    return changed;
  }
}

static class Input {
  static void Send(Native.INPUT i) {
    if (Native.SendInput(1, new Native.INPUT[] { i }, Marshal.SizeOf(typeof(Native.INPUT))) == 0)
      throw new Exception("SendInput failed (" + Marshal.GetLastWin32Error() + ")");
  }
  static Native.INPUT Mouse(uint flags, uint data, int dx, int dy) {
    Native.INPUT i = new Native.INPUT(); i.type = 0;
    i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; i.u.mi.dx = dx; i.u.mi.dy = dy;
    return i;
  }
  public static void Move(int x, int y) {
    int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77), vw = Native.GetSystemMetrics(78), vh = Native.GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Send(Mouse(0x0001 | 0x8000 | 0x4000, 0, nx, ny));   // MOVE | ABSOLUTE | VIRTUALDESK
  }
  public static void Button(int b, bool down) {
    switch (b) {
      case 1: Send(Mouse(down ? 0x0002u : 0x0004u, 0, 0, 0)); break;
      case 2: Send(Mouse(down ? 0x0020u : 0x0040u, 0, 0, 0)); break;
      case 3: Send(Mouse(down ? 0x0008u : 0x0010u, 0, 0, 0)); break;
      case 8: Send(Mouse(down ? 0x0080u : 0x0100u, 1, 0, 0)); break;
      case 9: Send(Mouse(down ? 0x0080u : 0x0100u, 2, 0, 0)); break;
    }
  }
  public static void Wheel(int dx, int dy) {
    if (dy != 0) Send(Mouse(0x0800, unchecked((uint)(-dy * 120)), 0, 0));
    if (dx != 0) Send(Mouse(0x1000, unchecked((uint)(dx * 120)), 0, 0));
  }
  public static void Key(int scan, bool ext, int vk, bool down) {
    Native.INPUT i = new Native.INPUT(); i.type = 1;
    if (vk != 0) { i.u.ki.wVk = (ushort)vk; i.u.ki.dwFlags = down ? 0u : 0x0002u; }
    else { i.u.ki.wScan = (ushort)scan; i.u.ki.dwFlags = 0x0008u | (ext ? 0x0001u : 0u) | (down ? 0u : 0x0002u); }
    Send(i);
  }
  // Ctrl+Alt+Del can't be typed by a program. Ask the ScreenShare Remote service (it runs as a service, which
  // Windows allows to send it), or call SendSAS here if the service isn't around.
  public static void Sas() {
    try {
      using (EventWaitHandle ev = EventWaitHandle.OpenExisting(@"Global\ScreenShareRemote-SAS")) { ev.Set(); return; }
    } catch (Exception) { }
    Native.SendSAS(false);
  }
}

// as-user: CreateProcessAsUser with the signed-in user's token
static class AsUser {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
                       public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
                                                            public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint session, out IntPtr token);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Quote(string a) { return a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? a : "\"" + a.Replace("\"", "\\\"") + "\""; }

  public static int Run(string[] args) {
    if (args.Length < 2) { Console.Error.WriteLine("usage: ScreenShareRemoteHelper as-user <program> [args…]"); return 2; }
    IntPtr token;
    // the person signed in to the session this helper runs in (SC-Remote's agent's session), else at the screen
    uint session;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), out session) || session == 0) session = WTSGetActiveConsoleSessionId();
    if (!WTSQueryUserToken(session, out token)) { Console.Error.WriteLine("nobody is signed in (" + Marshal.GetLastWin32Error() + ")"); return 3; }
    IntPtr env = IntPtr.Zero, job = IntPtr.Zero;
    try {
      if (!CreateEnvironmentBlock(out env, token, false)) env = IntPtr.Zero;
      // the program gets this helper's own stdin/stdout/stderr (pipes to SC-Remote)
      IntPtr hin = GetStdHandle(-10), hout = GetStdHandle(-11), herr = GetStdHandle(-12);
      foreach (IntPtr h in new[] { hin, hout, herr }) SetHandleInformation(h, 1, 1);           // HANDLE_FLAG_INHERIT
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = @"winsta0\default";
      si.dwFlags = 0x100; si.hStdInput = hin; si.hStdOutput = hout; si.hStdError = herr;       // STARTF_USESTDHANDLES
      StringBuilder cmd = new StringBuilder();
      for (int i = 1; i < args.Length; i++) { if (i > 1) cmd.Append(' '); cmd.Append(Quote(args[i])); }
      PROCESS_INFORMATION pi;
      // suspended until it's in a job that ends it with this helper (KILL_ON_JOB_CLOSE)
      if (!CreateProcessAsUser(token, args[1], cmd, IntPtr.Zero, IntPtr.Zero, true, 0x00000400 | 0x08000000 | 0x00000004, env, null, ref si, out pi)) {
        Console.Error.WriteLine("could not start it as the signed-in user (" + Marshal.GetLastWin32Error() + ")"); return 1;
      }
      job = CreateJobObject(IntPtr.Zero, null);
      EXTENDED_LIMIT lim = new EXTENDED_LIMIT(); lim.Basic.LimitFlags = 0x2000;
      SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
      AssignProcessToJobObject(job, pi.hProcess);
      ResumeThread(pi.hThread);
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      return (int)code;
    } finally {
      if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
      CloseHandle(token);
    }
  }
}

static class Program {
  static readonly object outLock = new object();
  static void Say(string line) { lock (outLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

  static int Main(string[] args) {
    string mode = args.Length > 0 ? args[0] : "";
    try {
      if (mode == "input") return RunInput();
      if (mode == "capture") return RunCapture();
      if (mode == "as-user") return AsUser.Run(args);
    } catch (Exception e) { Console.Error.WriteLine(e.ToString()); return 1; }
    Console.Error.WriteLine("usage: ScreenShareRemoteHelper input|capture|as-user");
    return 2;
  }

  /* ---------------- input ---------------- */
  // Commands on stdin, one per line:
  //   M x y | B btn 1|0 | W dx dy | K scan ext vk 1|0 | S ms | SAS
  // Output: READY, then "D <desktop>" whenever the input desktop changes, "ERR <message>" on failures.
  static int RunInput() {
    BlockingCollection<string> queue = new BlockingCollection<string>();
    // A dedicated thread does the work: SetThreadDesktop only works on a thread without windows.
    Thread worker = new Thread(() => {
      Native.DpiAware();
      DesktopFollower desk = new DesktopFollower();
      if (desk.Sync() || desk.Name != "") Say("D " + desk.Name);
      DateTime lastSync = DateTime.UtcNow;
      Say("READY");
      while (true) {
        string line;
        bool got = queue.TryTake(out line, 250);
        if (got && line == null) break;
        // follow the input desktop: poll a few times per second, and before input after a pause
        if (!got || (DateTime.UtcNow - lastSync).TotalMilliseconds > 150) {
          if (desk.Sync()) Say("D " + desk.Name);
          lastSync = DateTime.UtcNow;
        }
        if (!got) continue;
        string[] p = line.Split(' ');
        try {
          switch (p[0]) {
            case "M": Input.Move(int.Parse(p[1]), int.Parse(p[2])); break;
            case "B": Input.Button(int.Parse(p[1]), p[2] == "1"); break;
            case "W": Input.Wheel(int.Parse(p[1]), int.Parse(p[2])); break;
            case "S": Thread.Sleep(Math.Min(int.Parse(p[1]), 5000)); break;
            case "K": Input.Key(int.Parse(p[1]), p[2] == "1", int.Parse(p[3]), p[4] == "1"); break;
            case "SAS": Input.Sas(); break;
          }
        } catch (Exception e) {
          // a desktop switch makes the first input fail: move over and try once more
          if (desk.Sync()) {
            Say("D " + desk.Name);
            try { if (p[0] == "M") Input.Move(int.Parse(p[1]), int.Parse(p[2])); } catch { }
          } else Say("ERR " + e.Message);
        }
      }
    });
    worker.IsBackground = true;
    worker.Start();
    string l;
    while ((l = Console.In.ReadLine()) != null) queue.Add(l.Trim());
    queue.Add(null);
    worker.Join(3000);
    return 0;
  }

  /* ---------------- capture ---------------- */
  // stdin: "C x y w h fps quality maxWidth" (re)starts capturing that rectangle of the virtual screen (physical pixels).
  // stdout: frames as a 4-byte little-endian length followed by a JPEG. Unchanged frames are skipped (one every 2 s).
  static volatile int[] want;     // x, y, w, h, fps, quality, maxWidth
  static int RunCapture() {
    Stream stdout = Console.OpenStandardOutput();
    Thread worker = new Thread(() => {
      Native.DpiAware();
      DesktopFollower desk = new DesktopFollower();
      ImageCodecInfo jpeg = null;
      foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
      byte[] last = null; DateTime lastSent = DateTime.MinValue;
      while (true) {
        int[] w = want;
        if (w == null) { Thread.Sleep(100); continue; }
        DateTime t0 = DateTime.UtcNow;
        desk.Sync();
        try {
          byte[] frame = Grab(w, jpeg);
          bool same = last != null && frame.Length == last.Length && Equal(frame, last);
          if (!same || (DateTime.UtcNow - lastSent).TotalSeconds > 2) {
            byte[] len = BitConverter.GetBytes(frame.Length);
            stdout.Write(len, 0, 4); stdout.Write(frame, 0, frame.Length); stdout.Flush();
            last = frame; lastSent = DateTime.UtcNow;
          }
        } catch (IOException) { return; }                  // the app went away
        catch (Exception e) { Console.Error.WriteLine("capture: " + e.Message); Thread.Sleep(300); }
        int wait = 1000 / Math.Max(1, Math.Min(w[4], 30)) - (int)(DateTime.UtcNow - t0).TotalMilliseconds;
        if (wait > 0) Thread.Sleep(wait);
      }
    });
    worker.IsBackground = true;
    worker.Start();
    string l;
    while ((l = Console.In.ReadLine()) != null) {
      string[] p = l.Trim().Split(' ');
      if (p[0] == "C" && p.Length >= 8) {
        int[] v = new int[7];
        for (int i = 0; i < 7; i++) v[i] = int.Parse(p[i + 1]);
        if (v[2] > 0 && v[3] > 0) want = v;
      } else if (p[0] == "P") want = null;
    }
    return 0;
  }

  static bool Equal(byte[] a, byte[] b) {
    for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
    return true;
  }

  static byte[] Grab(int[] w, ImageCodecInfo jpeg) {
    int x = w[0], y = w[1], width = w[2], height = w[3], quality = w[5], maxW = w[6];
    using (Bitmap full = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
      Bitmap outBmp = full;
      try {
        if (maxW > 0 && width > maxW) {
          int h2 = Math.Max(1, (int)Math.Round(height * (double)maxW / width));
          outBmp = new Bitmap(maxW, h2, PixelFormat.Format24bppRgb);
          using (Graphics g2 = Graphics.FromImage(outBmp)) {
            g2.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g2.DrawImage(full, 0, 0, maxW, h2);
          }
        }
        using (MemoryStream ms = new MemoryStream()) {
          EncoderParameters ps = new EncoderParameters(1);
          ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(95, quality)));
          outBmp.Save(ms, jpeg, ps);
          return ms.ToArray();
        }
      } finally { if (outBmp != full) outBmp.Dispose(); }
    }
  }
}
