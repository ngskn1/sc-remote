# Input injector for Windows 10/11, using the system's SendInput (no drivers, nothing installed).
# Keys are sent as physical scan codes, so the controlled PC's own keyboard layout applies.
# Reads one command per line on stdin:
#   M x y            move pointer to absolute physical pixel x,y on the virtual desktop
#   B btn 1|0        press/release button (1 left, 2 middle, 3 right, 8 back, 9 forward)
#   W dx dy          scroll dx/dy notches (dy > 0 = down, dx > 0 = right)
#   K scan ext vk 1|0  press/release a key by scan code (ext = E0 flag); vk is used instead when not 0
#   S ms             pause (used to script a drag-and-drop while the app is busy running it)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ScreenShareInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  public static void Init() {
    // Physical pixels everywhere, also on scaled (125%/150%) and mixed-DPI monitors.
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
  static void Send(INPUT i) {
    if (SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))) == 0)
      throw new Exception("SendInput failed (" + Marshal.GetLastWin32Error() + ")");
  }
  static INPUT Mouse(uint flags, uint data, int dx, int dy) {
    INPUT i = new INPUT(); i.type = 0;
    i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; i.u.mi.dx = dx; i.u.mi.dy = dy;
    return i;
  }
  public static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Send(Mouse(0x0001 | 0x8000 | 0x4000, 0, nx, ny));   // MOVE | ABSOLUTE | VIRTUALDESK
  }
  public static void Button(int b, bool down) {
    switch (b) {
      case 1: Send(Mouse(down ? 0x0002u : 0x0004u, 0, 0, 0)); break;
      case 2: Send(Mouse(down ? 0x0020u : 0x0040u, 0, 0, 0)); break;
      case 3: Send(Mouse(down ? 0x0008u : 0x0010u, 0, 0, 0)); break;
      case 8: Send(Mouse(down ? 0x0080u : 0x0100u, 1, 0, 0)); break;   // XBUTTON1 (back)
      case 9: Send(Mouse(down ? 0x0080u : 0x0100u, 2, 0, 0)); break;   // XBUTTON2 (forward)
    }
  }
  public static void Wheel(int dx, int dy) {
    if (dy != 0) Send(Mouse(0x0800, unchecked((uint)(-dy * 120)), 0, 0));   // positive = away from user (up)
    if (dx != 0) Send(Mouse(0x1000, unchecked((uint)(dx * 120)), 0, 0));
  }
  public static void Key(int scan, bool ext, int vk, bool down) {
    INPUT i = new INPUT(); i.type = 1;
    if (vk != 0) { i.u.ki.wVk = (ushort)vk; i.u.ki.dwFlags = down ? 0u : 0x0002u; }
    else { i.u.ki.wScan = (ushort)scan; i.u.ki.dwFlags = 0x0008u | (ext ? 0x0001u : 0u) | (down ? 0u : 0x0002u); }
    Send(i);
  }
}
"@
[ScreenShareInput]::Init()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'M' { [ScreenShareInput]::Move([int]$p[1], [int]$p[2]) }
      'B' { $down = ($p[2] -eq '1'); [ScreenShareInput]::Button([int]$p[1], $down) }
      'W' { [ScreenShareInput]::Wheel([int]$p[1], [int]$p[2]) }
      'S' { Start-Sleep -Milliseconds ([Math]::Min([int]$p[1], 5000)) }
      'K' { $ext = ($p[2] -eq '1'); $down = ($p[4] -eq '1'); [ScreenShareInput]::Key([int]$p[1], $ext, [int]$p[3], $down) }
    }
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
    [Console]::Out.Flush()
  }
}
