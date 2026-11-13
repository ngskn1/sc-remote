# Run as the system account in the signed-in session (as SC-Remote's agent runs): report what the clipboard looks
# like from there while the signed-in user copies files. Usage: system-clipboard.ps1 <output file> <seconds>
param([string]$Out, [int]$Seconds = 12)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class Diag {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint f);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] public static extern int CountClipboardFormats();
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder b, int n, out int need);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern uint DragQueryFile(IntPtr h, uint i, StringBuilder s, uint n);
  public static string Name(IntPtr h) { var b = new StringBuilder(256); int n; GetUserObjectInformation(h, 2, b, 512, out n); return b.ToString(); }
  public static string Snapshot() {
    var sb = new StringBuilder();
    sb.Append("seq=" + GetClipboardSequenceNumber() + " count=" + CountClipboardFormats() + " hdrop=" + IsClipboardFormatAvailable(15) + " owner=" + GetClipboardOwner());
    if (OpenClipboard(IntPtr.Zero)) {
      try {
        var f = new List<string>(); uint x = 0; while ((x = EnumClipboardFormats(x)) != 0) f.Add(x.ToString());
        sb.Append(" formats=[" + string.Join(",", f.ToArray()) + "]");
        IntPtr h = GetClipboardData(15);
        if (h != IntPtr.Zero) { uint n = DragQueryFile(h, 0xFFFFFFFF, null, 0); var s = new StringBuilder(1024); if (n > 0) DragQueryFile(h, 0, s, 1024); sb.Append(" files=" + n + " first=" + s); }
        else sb.Append(" GetClipboardData(CF_HDROP)=null err=" + Marshal.GetLastWin32Error());
      } finally { CloseClipboard(); }
    } else sb.Append(" OpenClipboard failed err=" + Marshal.GetLastWin32Error());
    return sb.ToString();
  }
}
'@
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$p = Get-Process -Id $PID
"running as $me in session $($p.SessionId), window station $([Diag]::Name([Diag]::GetProcessWindowStation())), desktop $([Diag]::Name([Diag]::GetThreadDesktop([Diag]::GetCurrentThreadId())))" | Out-File -Encoding utf8 $Out
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) { "$((Get-Date).ToString('HH:mm:ss.fff')) $([Diag]::Snapshot())" | Out-File -Append -Encoding utf8 $Out; Start-Sleep -Milliseconds 700 }
"done" | Out-File -Append -Encoding utf8 $Out
