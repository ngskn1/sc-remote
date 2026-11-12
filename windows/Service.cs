// ScreenShareRemoteService.exe — the Windows service of SC-Remote (the remote-desktop edition of ScreenShare).
//
// Runs as LocalSystem from boot, before anyone signs in. It doesn't touch the network itself: while remote access
// is on, it starts the app's agent ("SC-Remote.exe --agent") inside the session shown on the PC's screen,
// as the system account, so the agent can see and control the sign-in screen too. When that session changes
// (sign-out, user switch) it starts the agent again in the new one, and restarts it if it crashes.
//
//   ScreenShareRemoteService.exe install [lab-setup.json]   register + start the service (administrator)
//   ScreenShareRemoteService.exe configure                  this PC's ID, password and options (administrator)
//   ScreenShareRemoteService.exe configure-if-needed        the same, only if remote access was never set up
//   ScreenShareRemoteService.exe uninstall [--keep-data]    stop + remove the service, firewall rule and data
//   ScreenShareRemoteService.exe stop                       stop the service (installer, before replacing files)
//   ScreenShareRemoteService.exe update-request             ask the running service to install the newest release
//                                                           (any signed-in user: the app's "Restart and update")
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Drawing;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Paths {
  // (fields are set in this order)
  public static readonly string Here = AppDomain.CurrentDomain.BaseDirectory;
  // resources\service\ScreenShareRemoteService.exe -> the install folder, two levels up
  public static readonly string AppDir = Path.GetFullPath(Path.Combine(Here, "..", ".."));
  // The app this service belongs to, named after its program in the install folder (e.g. "SC-Remote.exe"):
  // the service, its data folder and its window titles all follow that name.
  public static readonly string Product = FindProduct();
  public static readonly string AppExe = Path.Combine(AppDir, Product + ".exe");
  public static readonly string ServiceName = Regex.Replace(Product, "[^A-Za-z0-9]", "");   // "SCRemote"
  public static readonly string DisplayName = Product;
  public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), Product);
  public static readonly string Agent = Path.Combine(Root, "agent");
  public static readonly string SessionFile = Path.Combine(Root, "session.json");
  public static readonly string StatusFile = Path.Combine(Root, "status.json");
  public static readonly string AccessFile = Path.Combine(Agent, "access.json");
  public static readonly string Log = Path.Combine(Agent, "service.log");
  // updates: where to look for them and the release key (next to this program, written when it was built),
  // what's going on (readable by the app), the downloaded installers, and "reopen the app once the new version runs"
  public static readonly string UpdateConfig = Path.Combine(Here, "update.json");
  public static readonly string UpdateState = Path.Combine(Root, "update-state.json");
  public static readonly string Updates = Path.Combine(Agent, "updates");
  public static readonly string Relaunch = Path.Combine(Agent, "relaunch.json");
  public static readonly string UpdateEvent = @"Global\" + ServiceName + "-Update";

  static string FindProduct() {
    try {
      foreach (string f in Directory.GetFiles(AppDir, "*.exe")) {
        string n = Path.GetFileNameWithoutExtension(f);
        if (!n.StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase) && !n.Equals("elevate", StringComparison.OrdinalIgnoreCase)) return n;
      }
    } catch { }
    return "SC-Remote";
  }

  public static void Write(string msg) {
    try {
      Directory.CreateDirectory(Agent);
      if (File.Exists(Log) && new FileInfo(Log).Length > 1024 * 1024) File.Copy(Log, Log + ".old", true);
      if (File.Exists(Log) && new FileInfo(Log).Length > 1024 * 1024) File.Delete(Log);
      File.AppendAllText(Log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine);
    } catch { }
  }
}

static class Native {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr tok, uint access, IntPtr attrs, int level, int type, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr tok, int cls, ref uint info, uint len);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
                                                IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformation(IntPtr server, uint sid, int cls, out IntPtr buf, out uint bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint sid, out IntPtr token);
  [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetUserProfileDirectory(IntPtr tok, StringBuilder dir, ref uint size);
  [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr tok, out IntPtr path);
  [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);
  [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool DestroyEnvironmentBlock(IntPtr env);

  public static string SessionString(uint sid, int cls) {
    IntPtr buf; uint n;
    if (!WTSQuerySessionInformation(IntPtr.Zero, sid, cls, out buf, out n)) return "";
    try { return Marshal.PtrToStringUni(buf) ?? ""; } finally { WTSFreeMemory(buf); }
  }
}

// Starts and watches the agent in the active console session.
class Supervisor {
  readonly ManualResetEvent stopping = new ManualResetEvent(false);
  readonly AutoResetEvent poke = new AutoResetEvent(false);
  EventWaitHandle sas, update;
  Thread thread;
  IntPtr job = IntPtr.Zero;
  IntPtr agentProc = IntPtr.Zero;
  uint agentSession = 0xFFFFFFFF;
  string lastUser = null;
  readonly Queue<DateTime> starts = new Queue<DateTime>();

  public void Start() {
    // the agent signals this when a lab member presses Ctrl+Alt+Del: only a service may send it
    try { sas = new EventWaitHandle(false, EventResetMode.AutoReset, @"Global\ScreenShareRemote-SAS"); }
    catch (Exception e) { Paths.Write("SAS event: " + e.Message); }
    // the app (as whoever is signed in) sets this for "Restart and update": signed-in users may only set it
    try {
      EventWaitHandleSecurity sec = new EventWaitHandleSecurity();
      sec.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), EventWaitHandleRights.FullControl, AccessControlType.Allow));
      sec.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), EventWaitHandleRights.FullControl, AccessControlType.Allow));
      sec.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), EventWaitHandleRights.Modify | EventWaitHandleRights.Synchronize, AccessControlType.Allow));
      bool created;
      update = new EventWaitHandle(false, EventResetMode.AutoReset, Paths.UpdateEvent, out created, sec);
    } catch (Exception e) { Paths.Write("update event: " + e.Message); }
    thread = new Thread(Loop) { IsBackground = true, Name = "supervisor" };
    thread.Start();
  }
  public void Stop() {
    stopping.Set();
    if (thread != null) thread.Join(5000);
    KillAgent("service stopping");
  }
  public void Poke() { poke.Set(); }

  void Loop() {
    Paths.Write("service started (app: " + Paths.AppExe + ", version " + Updater.CurrentVersion() + ")");
    try { Updater.AfterUpdate(true); } catch (Exception e) { Paths.Write("after update: " + e.Message); }
    List<WaitHandle> list = new List<WaitHandle> { stopping, poke };
    if (sas != null) list.Add(sas);
    if (update != null) list.Add(update);
    WaitHandle[] handles = list.ToArray();
    while (true) {
      try { Check(); } catch (Exception e) { Paths.Write("check failed: " + e.Message); }
      int r = WaitHandle.WaitAny(handles, 2000);
      if (r == 0) return;
      if (r != WaitHandle.WaitTimeout && handles[r] == sas) {
        try { Native.SendSAS(false); Paths.Write("sent Ctrl+Alt+Del"); } catch (Exception e) { Paths.Write("SendSAS failed: " + e.Message); }
      }
      if (r != WaitHandle.WaitTimeout && handles[r] == update) Updater.Request();
    }
  }

  bool AgentRunning() { return agentProc != IntPtr.Zero && Native.WaitForSingleObject(agentProc, 0) == 0x102 /* WAIT_TIMEOUT */; }

  // remote access on? (remote edition: the settings dialog's switch; lab edition: the PC has joined a lab)
  static bool Enabled() {
    try {
      if (File.Exists(Paths.AccessFile)) return Regex.IsMatch(File.ReadAllText(Paths.AccessFile), "\"enabled\"\\s*:\\s*true");
      return File.Exists(Path.Combine(Paths.Agent, "lab-host.json")) || File.Exists(Path.Combine(Paths.Agent, "lab-setup.json"));
    } catch { return false; }
  }

  void Check() {
    uint sid = Native.WTSGetActiveConsoleSessionId();
    if (sid == 0xFFFFFFFF) return;                      // the console is switching between sessions: wait
    WriteSessionInfo(sid);
    if (!Enabled()) { if (AgentRunning()) KillAgent("remote access was turned off"); else if (agentProc != IntPtr.Zero) CloseAgentHandles(); return; }
    if (AgentRunning() && agentSession == sid) return;
    if (AgentRunning()) KillAgent("the session on the screen changed");
    else if (agentProc != IntPtr.Zero) { Paths.Write("agent stopped; starting it again"); CloseAgentHandles(); }
    // crash-loop guard: at most 5 starts in 2 minutes
    while (starts.Count > 0 && (DateTime.UtcNow - starts.Peek()).TotalMinutes > 2) starts.Dequeue();
    if (starts.Count >= 5) return;
    starts.Enqueue(DateTime.UtcNow);
    Launch(sid);
  }

  // who is signed in at the screen (if anyone): the agent puts received files in their folders
  void WriteSessionInfo(uint sid) {
    string user = Native.SessionString(sid, 5 /* WTSUserName */);
    string key = sid + "|" + user;
    if (key == lastUser) return;
    lastUser = key;
    string home = "", downloads = "";
    IntPtr tok;
    if (user != "" && Native.WTSQueryUserToken(sid, out tok)) {
      try {
        StringBuilder sb = new StringBuilder(520); uint size = 520;
        if (Native.GetUserProfileDirectory(tok, sb, ref size)) home = sb.ToString();
        IntPtr p;
        if (Native.SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, tok, out p) == 0) {
          downloads = Marshal.PtrToStringUni(p); Native.CoTaskMemFree(p);
        }
      } finally { Native.CloseHandle(tok); }
    }
    string temp = home != "" ? Path.Combine(home, @"AppData\Local\Temp") : "";
    string json = "{\"session\":" + sid + ",\"user\":" + Json(user) + ",\"home\":" + Json(home) + ",\"temp\":" + Json(temp) +
                  ",\"downloads\":" + Json(downloads) + ",\"updated\":" + Json(DateTime.UtcNow.ToString("o")) + "}";
    try { File.WriteAllText(Paths.SessionFile, json); } catch (Exception e) { Paths.Write("session file: " + e.Message); }
    Paths.Write("console session " + sid + (user != "" ? ", signed in: " + user : ", nobody signed in"));
  }

  public static string Json(string s) {
    StringBuilder sb = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  void Launch(uint sid) {
    if (!File.Exists(Paths.AppExe)) { Paths.Write("app not found: " + Paths.AppExe); return; }
    IntPtr own = IntPtr.Zero, tok = IntPtr.Zero, env = IntPtr.Zero;
    try {
      // our own (system) token, moved to the session on the screen
      const uint TOKEN_ALL = 0xF01FF;
      if (!Native.OpenProcessToken(Native.GetCurrentProcess(), TOKEN_ALL, out own)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
      if (!Native.DuplicateTokenEx(own, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, 2 /* impersonation */, 1 /* primary */, out tok))
        throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
      uint s = sid;
      if (!Native.SetTokenInformation(tok, 12 /* TokenSessionId */, ref s, 4)) throw new Exception("SetTokenInformation " + Marshal.GetLastWin32Error());

      // environment: the service's, plus where the shared lab files are
      SortedDictionary<string, string> vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) vars[(string)e.Key] = (string)e.Value;
      vars["SCREENSHARE_LAB_ROOT"] = Paths.Root;
      vars["ELECTRON_NO_ATTACH_CONSOLE"] = "1";
      StringBuilder block = new StringBuilder();
      foreach (KeyValuePair<string, string> kv in vars) block.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
      block.Append('\0');
      env = Marshal.StringToHGlobalUni(block.ToString());

      Native.STARTUPINFO si = new Native.STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
      si.lpDesktop = @"winsta0\default";
      Native.PROCESS_INFORMATION pi;
      StringBuilder cmd = new StringBuilder("\"" + Paths.AppExe + "\" --agent --no-sandbox");
      const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
      if (!Native.CreateProcessAsUser(tok, Paths.AppExe, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                                      env, Paths.AppDir, ref si, out pi))
        throw new Exception("CreateProcessAsUser " + Marshal.GetLastWin32Error());

      // a job holds the agent and everything it starts, so all of it ends together (also if this service dies)
      job = Native.CreateJobObject(IntPtr.Zero, null);
      Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
      Native.SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
      if (!Native.AssignProcessToJobObject(job, pi.hProcess)) Paths.Write("job: " + Marshal.GetLastWin32Error());
      Native.ResumeThread(pi.hThread);
      Native.CloseHandle(pi.hThread);
      agentProc = pi.hProcess;
      agentSession = sid;
      Paths.Write("agent started in session " + sid + " (pid " + pi.dwProcessId + ")");
    } catch (Exception e) {
      Paths.Write("could not start the agent: " + e.Message);
    } finally {
      if (own != IntPtr.Zero) Native.CloseHandle(own);
      if (tok != IntPtr.Zero) Native.CloseHandle(tok);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }

  void KillAgent(string why) {
    if (job != IntPtr.Zero) { Native.TerminateJobObject(job, 0); Paths.Write("agent stopped: " + why); }
    CloseAgentHandles();
  }
  void CloseAgentHandles() {
    if (agentProc != IntPtr.Zero) { Native.CloseHandle(agentProc); agentProc = IntPtr.Zero; }
    if (job != IntPtr.Zero) { Native.CloseHandle(job); job = IntPtr.Zero; }
    agentSession = 0xFFFFFFFF;
  }
}

class RemoteService : ServiceBase {
  readonly Supervisor sup = new Supervisor();
  public RemoteService() { ServiceName = Paths.ServiceName; CanHandleSessionChangeEvent = true; CanShutdown = true; }
  protected override void OnStart(string[] args) { sup.Start(); }
  protected override void OnStop() { sup.Stop(); }
  protected override void OnShutdown() { sup.Stop(); }
  protected override void OnSessionChange(SessionChangeDescription d) { sup.Poke(); }
}

static class Setup {
  const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
  static readonly string OurKey = @"SOFTWARE\" + Paths.Product;

  static int Run(string exe, string args) {
    try {
      ProcessStartInfo psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
      using (Process p = Process.Start(psi)) {
        string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) Console.WriteLine(Path.GetFileName(exe) + " " + args + " -> " + p.ExitCode + " " + o.Trim());
        return p.ExitCode;
      }
    } catch (Exception e) { Console.WriteLine(exe + ": " + e.Message); return -1; }
  }
  static string Sys(string name) { return Path.Combine(Environment.SystemDirectory, name); }

  static bool Installed() {
    foreach (ServiceController s in ServiceController.GetServices()) if (s.ServiceName == Paths.ServiceName) return true;
    return false;
  }

  // Only the system account and administrators may change the lab files; everyone may read the status.
  static void Protect(string dir, bool usersRead) {
    DirectorySecurity ds = new DirectorySecurity();
    ds.SetAccessRuleProtection(true, false);
    InheritanceFlags inh = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
    ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inh, PropagationFlags.None, AccessControlType.Allow));
    ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inh, PropagationFlags.None, AccessControlType.Allow));
    if (usersRead) ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, inh, PropagationFlags.None, AccessControlType.Allow));
    Directory.SetAccessControl(dir, ds);
  }

  static bool OwnedByAdmins(string dir) {
    try {
      SecurityIdentifier o = new DirectoryInfo(dir).GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
      return o != null && (o.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) || o.IsWellKnown(WellKnownSidType.LocalSystemSid));
    } catch { return false; }
  }

  public static void EnsureFolders() {
    // Anyone may create folders in ProgramData. If someone without administrator rights made ours before the
    // first installation, they own it and could have put their own settings (and password) in it: set it aside.
    // (Never on an update: the folder is then the one a previous installation made.)
    if (Directory.Exists(Paths.Root) && !Installed() && !OwnedByAdmins(Paths.Root)) {
      Console.WriteLine("The data folder existed and was not made by an administrator: starting with a clean one.");
      try { Directory.Move(Paths.Root, Paths.Root + ".old-" + DateTime.Now.ToString("yyyyMMddHHmmss")); }
      catch { Directory.Delete(Paths.Root, true); }
    }
    Directory.CreateDirectory(Paths.Root);
    Directory.CreateDirectory(Paths.Agent);
    Protect(Paths.Root, true);
    Protect(Paths.Agent, false);
  }

  public static int Install(string setupFile, bool onlyIfNeeded) {
    bool haveSetup = !string.IsNullOrEmpty(setupFile) && File.Exists(setupFile);
    if (onlyIfNeeded && !haveSetup && !Installed()) { Console.WriteLine("No lab-setup.json next to the installer: installed as a member app only."); return 0; }
    EnsureFolders();
    if (haveSetup) { File.Copy(setupFile, Path.Combine(Paths.Agent, "lab-setup.json"), true); Console.WriteLine("Lab setup file copied."); }

    // Ctrl+Alt+Del from a service needs this policy ("Disable or enable software Secure Attention Sequence": services)
    using (RegistryKey k = Registry.LocalMachine.CreateSubKey(PolicyKey))
    using (RegistryKey ours = Registry.LocalMachine.CreateSubKey(OurKey)) {
      object cur = k.GetValue("SoftwareSASGeneration");
      if (ours.GetValue("PreviousSoftwareSASGeneration") == null) ours.SetValue("PreviousSoftwareSASGeneration", cur == null ? -1 : (int)cur, RegistryValueKind.DWord);
      int v = cur == null ? 0 : (int)cur;
      k.SetValue("SoftwareSASGeneration", v | 1, RegistryValueKind.DWord);
    }

    // let the app receive direct connections (otherwise Windows asks someone to click "Allow" on the first run)
    Run(Sys("netsh.exe"), "advfirewall firewall delete rule name=\"" + Paths.DisplayName + "\"");
    Run(Sys("netsh.exe"), "advfirewall firewall add rule name=\"" + Paths.DisplayName + "\" dir=in action=allow program=\"" + Paths.AppExe + "\" enable=yes profile=any");

    string bin = "\"" + Path.Combine(Paths.Here, "ScreenShareRemoteService.exe") + "\"";
    if (Installed()) {
      StopService();
      Run(Sys("sc.exe"), "config " + Paths.ServiceName + " binPath= \"" + bin.Replace("\"", "\\\"") + "\" start= auto");
    } else {
      int r = Run(Sys("sc.exe"), "create " + Paths.ServiceName + " binPath= \"" + bin.Replace("\"", "\\\"") + "\" start= auto DisplayName= \"" + Paths.DisplayName + "\"");
      if (r != 0) { Console.WriteLine("Could not create the service."); return 1; }
    }
    Run(Sys("sc.exe"), "description " + Paths.ServiceName + " \"Remote access to this PC with " + Paths.Product + ", also at the sign-in screen.\"");
    Run(Sys("sc.exe"), "failure " + Paths.ServiceName + " reset= 86400 actions= restart/5000/restart/5000/restart/60000");
    try {
      using (ServiceController sc = new ServiceController(Paths.ServiceName)) { sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20)); }
      Console.WriteLine("Service running.");
    } catch (Exception e) { Console.WriteLine("Could not start the service: " + e.Message); return 1; }
    return 0;
  }

  public static int StopService() {
    try {
      using (ServiceController sc = new ServiceController(Paths.ServiceName)) {
        if (sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); }
      }
    } catch (Exception) { }
    return 0;
  }

  public static int Uninstall(bool keepData) {
    StopService();
    if (Installed()) Run(Sys("sc.exe"), "delete " + Paths.ServiceName);
    Run(Sys("netsh.exe"), "advfirewall firewall delete rule name=\"" + Paths.DisplayName + "\"");
    try {
      using (RegistryKey ours = Registry.LocalMachine.OpenSubKey(OurKey))
      using (RegistryKey k = Registry.LocalMachine.OpenSubKey(PolicyKey, true)) {
        object prev = ours != null ? ours.GetValue("PreviousSoftwareSASGeneration") : null;
        if (prev != null && k != null) { if ((int)prev < 0) k.DeleteValue("SoftwareSASGeneration", false); else k.SetValue("SoftwareSASGeneration", (int)prev, RegistryValueKind.DWord); }
      }
      Registry.LocalMachine.DeleteSubKeyTree(OurKey, false);
    } catch (Exception e) { Console.WriteLine("registry: " + e.Message); }
    if (!keepData) {
      for (int i = 0; i < 5 && Directory.Exists(Paths.Root); i++) {
        try { Directory.Delete(Paths.Root, true); } catch { Thread.Sleep(1000); }
      }
    }
    return 0;
  }
}

// Updates. The app checks GitHub for a newer release and, when the person clicks "Restart and update", asks this
// service (update-request). The service installs only a release whose manifest is signed with the release key
// (its public half is in update.json next to this program) and whose download matches the manifest's SHA-256.
// The installer stops this service and closes the app; when the new version's service starts, it reopens the app
// for whoever is at the screen.
class UpdateError : Exception { public UpdateError(string m) : base(m) { } }

static class Updater {
  static int busy = 0;

  // update-request: set the service's event (exit code 2: the service isn't running)
  public static int Signal() {
    try {
      using (EventWaitHandle e = EventWaitHandle.OpenExisting(Paths.UpdateEvent, EventWaitHandleRights.Modify | EventWaitHandleRights.Synchronize)) { e.Set(); }
      return 0;
    } catch (WaitHandleCannotBeOpenedException) { return 2; }
    catch (UnauthorizedAccessException) { return 3; }
  }

  public static string CurrentVersion() {
    try { return Access.Get(new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Paths.UpdateConfig)), "version"); }
    catch { return ""; }
  }

  // 1.10.0 > 1.9.3
  public static int Compare(string a, string b) {
    string[] pa = (a ?? "").Split('.'), pb = (b ?? "").Split('.');
    for (int i = 0; i < Math.Max(3, Math.Max(pa.Length, pb.Length)); i++) {
      int x = 0, y = 0;
      if (i < pa.Length) int.TryParse(pa[i], out x);
      if (i < pb.Length) int.TryParse(pb[i], out y);
      if (x != y) return x > y ? 1 : -1;
    }
    return 0;
  }

  public static void Request() {
    if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) return;     // already on it
    Thread t = new Thread(() => { try { Run(); } finally { Interlocked.Exchange(ref busy, 0); } });
    t.IsBackground = true; t.Name = "update"; t.Start();
  }

  static void State(string state, string version, string error) {
    try {
      File.WriteAllText(Paths.UpdateState, "{\"state\":" + Supervisor.Json(state) + ",\"version\":" + Supervisor.Json(version) + ",\"from\":" + Supervisor.Json(CurrentVersion()) +
                                           ",\"error\":" + Supervisor.Json(error) + ",\"at\":" + Supervisor.Json(DateTime.UtcNow.ToString("o")) + "}");
    } catch (Exception e) { Paths.Write("update state: " + e.Message); }
  }

  static void Run() {
    string version = "";
    try {
      Paths.Write("update requested");
      State("downloading", "", "");
      string installer;
      Dictionary<string, object> m = Prepare(Paths.UpdateConfig, Paths.Updates, out installer);
      version = Access.Get(m, "version");
      Paths.Write("update " + version + " downloaded and verified: installing it");
      File.WriteAllText(Paths.Relaunch, "{\"version\":" + Supervisor.Json(version) + ",\"at\":" + Supervisor.Json(DateTime.UtcNow.ToString("o")) + "}");
      State("installing", version, "");
      // The installer stops this service first, so a small script runs it and then starts the service again in
      // any case (if the installer failed halfway, the PC stays reachable with the version it had).
      string exitFile = Path.Combine(Paths.Updates, "installer-exit.txt"), script = Path.Combine(Paths.Updates, "run-update.cmd");
      try { File.Delete(exitFile); } catch { }
      // The installer unpacks itself into the temporary folder before it runs. The system account's usual one
      // (C:\Windows\Temp) lets any user create files, so it gets a folder only administrators can touch.
      string tmp = Path.Combine(Paths.Updates, "tmp");
      try { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); } catch { }
      Directory.CreateDirectory(tmp);
      File.WriteAllText(script,
        "@echo off\r\n" +
        "set \"TEMP=" + tmp + "\"\r\n" +
        "set \"TMP=" + tmp + "\"\r\n" +
        "start \"\" /wait \"" + installer + "\" /S\r\n" +
        ">\"" + exitFile + "\" echo %ERRORLEVEL%\r\n" +
        "\"" + Path.Combine(Environment.SystemDirectory, "sc.exe") + "\" start " + Paths.ServiceName + " >nul 2>&1\r\n", Encoding.ASCII);
      ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d /c \"\"" + script + "\"\"");
      psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WorkingDirectory = Paths.Updates;
      using (Process p = Process.Start(psi)) p.WaitForExit();
      // Still here: the installer never got as far as stopping this service, so nothing was installed.
      Thread.Sleep(1000);
      AfterUpdate(false);
    } catch (UpdateError e) {
      Paths.Write("update: " + e.Message);
      State("failed", version, e.Message);
    } catch (Exception e) {
      Paths.Write("update failed: " + e);
      State("failed", version, e is WebException ? "could not download the update" : "could not start the installer");
    }
  }

  // Downloads and checks the newest release; returns its manifest. (Separate, with its own paths, for tests.)
  public static Dictionary<string, object> Prepare(string configFile, string dir, out string installer) {
    installer = null;
    JavaScriptSerializer js = new JavaScriptSerializer();
    Dictionary<string, object> cfg = js.Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
    string current = Access.Get(cfg, "version"), product = Access.Get(cfg, "product"), prefix = Access.Get(cfg, "allowedPrefix");
    try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }     // TLS 1.2 (GitHub)

    byte[] raw;
    try { raw = Fetch(Access.Get(cfg, "manifestUrl"), product + "/" + current); }
    catch (WebException e) { throw new UpdateError("could not download the update (" + e.Message + ")"); }
    Dictionary<string, object> doc;
    try { doc = js.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(raw)); } catch { throw new UpdateError("not an update manifest"); }
    string text = Access.Get(doc, "manifest"), sig = Access.Get(doc, "sig");
    if (text == "" || sig == "") throw new UpdateError("not an update manifest");

    RSAParameters key = new RSAParameters();
    key.Modulus = Convert.FromBase64String(Access.Get(cfg, "n"));
    key.Exponent = Convert.FromBase64String(Access.Get(cfg, "e"));
    bool ok;
    using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider()) {
      rsa.PersistKeyInCsp = false;
      rsa.ImportParameters(key);
      try { ok = rsa.VerifyData(Encoding.UTF8.GetBytes(text), "SHA256", Convert.FromBase64String(sig)); } catch (FormatException) { ok = false; }
    }
    if (!ok) throw new UpdateError("the update is not signed with the release key");

    Dictionary<string, object> m = js.Deserialize<Dictionary<string, object>>(text);
    string version = Access.Get(m, "version"), url = Access.Get(m, "url"), sha = Access.Get(m, "sha256").ToLowerInvariant();
    long size = 0; long.TryParse(Access.Get(m, "size"), out size);
    if (Access.Get(m, "product") != product) throw new UpdateError("the update is for another program");
    if (!Regex.IsMatch(version, @"^\d+\.\d+\.\d+$") || !Regex.IsMatch(sha, "^[0-9a-f]{64}$")) throw new UpdateError("incomplete update manifest");
    if (Compare(version, current) <= 0) throw new UpdateError("no newer version");
    if (prefix == "" || !url.StartsWith(prefix, StringComparison.Ordinal)) throw new UpdateError("the update's address is not allowed");

    Directory.CreateDirectory(dir);
    foreach (string f in Directory.GetFiles(dir)) { try { File.Delete(f); } catch { } }     // earlier downloads
    string target = Path.Combine(dir, Regex.Replace(product, "[^A-Za-z0-9-]", "") + "-Setup-" + version + ".exe"), part = target + ".part";
    try { using (WebClient wc = Client(product + "/" + current)) wc.DownloadFile(url, part); }
    catch (WebException e) { throw new UpdateError("could not download the update (" + e.Message + ")"); }
    byte[] got;
    using (SHA256 h = SHA256.Create()) using (FileStream fs = File.OpenRead(part)) got = h.ComputeHash(fs);
    if (Access.Hex(got) != sha || (size > 0 && new FileInfo(part).Length != size)) { File.Delete(part); throw new UpdateError("the downloaded update is damaged"); }
    if (File.Exists(target)) File.Delete(target);
    File.Move(part, target);
    installer = target;
    return m;
  }

  static WebClient Client(string agent) {
    WebClient wc = new WebClient();
    wc.Headers[HttpRequestHeader.UserAgent] = agent;
    wc.Headers[HttpRequestHeader.CacheControl] = "no-cache";
    return wc;
  }
  static byte[] Fetch(string url, string agent) { using (WebClient wc = Client(agent)) return wc.DownloadData(url); }

  // At service start: did an update just run? Note how it went, and reopen the app for whoever is at the screen.
  public static void AfterUpdate(bool reopenApp) {
    if (!File.Exists(Paths.Relaunch)) return;
    Dictionary<string, object> r;
    try { r = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Paths.Relaunch)); } catch { r = new Dictionary<string, object>(); }
    try { File.Delete(Paths.Relaunch); } catch { }
    DateTime at;
    if (!DateTime.TryParse(Access.Get(r, "at"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out at) || (DateTime.UtcNow - at.ToUniversalTime()).TotalMinutes > 30) return;
    string target = Access.Get(r, "version"), now = CurrentVersion();
    bool ok = Compare(now, target) >= 0;
    string code = "";
    try { code = File.ReadAllText(Path.Combine(Paths.Updates, "installer-exit.txt")).Trim(); } catch { }
    Paths.Write(ok ? "updated to " + now : "the update to " + target + " did not install (still " + now + (code != "" ? ", installer exit code " + code : "") + ")");
    State(ok ? "done" : "failed", target, ok ? "" : "the installer did not finish" + (code != "" ? " (code " + code + ")" : ""));
    if (reopenApp) RelaunchApp();
  }

  // the app, as the person signed in at the screen (not as the system account), with "--updated"
  static void RelaunchApp() {
    uint sid = Native.WTSGetActiveConsoleSessionId();
    IntPtr tok, env = IntPtr.Zero;
    if (sid == 0xFFFFFFFF || !Native.WTSQueryUserToken(sid, out tok)) { Paths.Write("nobody signed in at the screen: the app opens at the next sign-in"); return; }
    try {
      if (!Native.CreateEnvironmentBlock(out env, tok, false)) env = IntPtr.Zero;
      Native.STARTUPINFO si = new Native.STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO));
      si.lpDesktop = @"winsta0\default";
      Native.PROCESS_INFORMATION pi;
      StringBuilder cmd = new StringBuilder("\"" + Paths.AppExe + "\" --updated");
      if (!Native.CreateProcessAsUser(tok, Paths.AppExe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x400 /* CREATE_UNICODE_ENVIRONMENT */, env, Paths.AppDir, ref si, out pi))
        throw new Exception("CreateProcessAsUser " + Marshal.GetLastWin32Error());
      Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess);
      Paths.Write("app reopened in session " + sid);
    } catch (Exception e) { Paths.Write("could not reopen the app: " + e.Message); }
    finally { if (env != IntPtr.Zero) Native.DestroyEnvironmentBlock(env); Native.CloseHandle(tok); }
  }
}

static class Program {
  [STAThread]
  static int Main(string[] args) {
    string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
    try {
      switch (cmd) {
        case "install": return Setup.Install(args.Length > 1 ? args[1] : null, false);
        case "install-if-needed": return Setup.Install(args.Length > 1 ? args[1] : null, true);
        case "uninstall": return Setup.Uninstall(args.Length > 1 && args[1] == "--keep-data");
        case "stop": return Setup.StopService();
        case "configure": return ConfigureForm.Run(false, args);
        case "configure-if-needed": return ConfigureForm.Run(true, args);
        case "update-request": return Updater.Signal();
      }
    } catch (Exception e) { Console.WriteLine(e.Message); return 1; }
    ServiceBase.Run(new RemoteService());
    return 0;
  }
}

// This PC's remote-access settings, kept where only the system account and administrators can read them.
// The password itself is never stored: only a PBKDF2-SHA256 key (150 000 rounds, as the app checks it).
static class Access {
  public const int Rounds = 150000;               // must match remote/host-main.js and app/remote-common.js
  public static Dictionary<string, object> Read() {
    try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Paths.AccessFile)) ?? new Dictionary<string, object>(); }
    catch { return new Dictionary<string, object>(); }
  }
  public static void Write(Dictionary<string, object> a) {
    string tmp = Paths.AccessFile + ".tmp";
    File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(a), new UTF8Encoding(false));
    if (File.Exists(Paths.AccessFile)) File.Replace(tmp, Paths.AccessFile, null); else File.Move(tmp, Paths.AccessFile);
  }
  public static string Hex(byte[] b) { StringBuilder sb = new StringBuilder(); foreach (byte x in b) sb.Append(x.ToString("x2")); return sb.ToString(); }
  public static byte[] Unhex(string h) { byte[] b = new byte[h.Length / 2]; for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(h.Substring(i * 2, 2), 16); return b; }
  public static byte[] Random(int n) { byte[] b = new byte[n]; using (RandomNumberGenerator r = RandomNumberGenerator.Create()) r.GetBytes(b); return b; }
  public static string Key(string password, string saltHex) {
    using (Rfc2898DeriveBytes k = new Rfc2898DeriveBytes(password, Unhex(saltHex), Rounds, HashAlgorithmName.SHA256)) return Hex(k.GetBytes(32));
  }
  // 9 digits, the first not 0 (like the app's IDs)
  public static string NewId() {
    byte[] b = Random(8); ulong v = BitConverter.ToUInt64(b, 0);
    return ((v % 9) + 1).ToString() + ((v / 9) % 100000000).ToString("D8");
  }
  public static string Get(Dictionary<string, object> a, string k) { object v; return a.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  public static string FormatId(string id) { return Regex.Replace(id, @"(\d{3})(?=\d)", "$1 "); }
  // what the app shows under "This computer" (the agent rewrites it once it runs)
  public static void WriteStatus(Dictionary<string, object> a) {
    bool on = a.ContainsKey("enabled") && (a["enabled"] as bool? ?? false);
    var st = new Dictionary<string, object> { { "state", on ? "starting" : "off" }, { "id", Get(a, "id") }, { "enabled", on },
      { "pc", Environment.MachineName }, { "updated", DateTime.UtcNow.ToString("o") } };
    try { File.WriteAllText(Paths.StatusFile, new JavaScriptSerializer().Serialize(st), new UTF8Encoding(false)); } catch { }
  }
}

// The settings dialog: shown by the installer, and by the app's "Change password or settings…" (as administrator).
class ConfigureForm : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  readonly Dictionary<string, object> a;
  readonly CheckBox enable, banner, ask;
  readonly TextBox pw, pw2;
  readonly Label err;
  readonly List<Control> dependent = new List<Control>();

  // language: Portuguese unless the app says otherwise ("configure --lang=en"); saved for the on-screen bar too
  static bool pt = true;
  static string T(string en, string ptText) { return pt ? ptText : en; }

  public static int Run(bool onlyIfNeeded, string[] args) {
    foreach (string x in args) if (x.StartsWith("--lang=")) pt = x.Substring(7) != "en";
    if (onlyIfNeeded && File.Exists(Paths.AccessFile)) return 0;
    try { SetProcessDPIAware(); } catch { }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) {
      MessageBox.Show(T("Changing remote access to this PC needs administrator permission.", "Para mudar o acesso remoto a este PC é preciso permissão de administrador."), Paths.Product, MessageBoxButtons.OK, MessageBoxIcon.Warning);
      return 1;
    }
    Setup.EnsureFolders();
    using (ConfigureForm f = new ConfigureForm()) return f.ShowDialog() == DialogResult.OK ? 0 : 2;
  }

  Label Text1(string t, bool muted = false, bool bold = false) {
    Label l = new Label { Text = t, AutoSize = true, Margin = new Padding(0, 6, 8, 2), MaximumSize = new Size(560, 0) };
    if (muted) l.ForeColor = SystemColors.GrayText;
    if (bold) l.Font = new Font(Font, FontStyle.Bold);
    return l;
  }

  internal ConfigureForm() {
    a = Access.Read();
    if (!Regex.IsMatch(Access.Get(a, "id"), @"^\d{9}$")) a["id"] = Access.NewId();
    bool hasPw = Access.Get(a, "key").Length == 64;
    bool firstTime = !File.Exists(Paths.AccessFile);

    Text = Paths.Product + " – " + T("remote access to this PC", "acesso remoto a este PC");
    Font = new Font("Segoe UI", 9.75f);
    FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen; ShowInTaskbar = true; TopMost = true;
    AutoScaleMode = AutoScaleMode.Font; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink; Padding = new Padding(18, 14, 18, 14);

    TableLayoutPanel t = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Fill };
    t.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 380));
    Action<Control> full = c => { t.Controls.Add(c); t.SetColumnSpan(c, 2); };
    Action<Control, Control> pair = (l, c) => { t.Controls.Add(l); t.Controls.Add(c); };

    enable = new CheckBox { Text = T("Allow remote access to this PC", "Permitir acesso remoto a este PC"), AutoSize = true,
                            Checked = firstTime || (a.ContainsKey("enabled") && (a["enabled"] as bool? ?? false)), Margin = new Padding(0, 0, 0, 0) };
    enable.Font = new Font(Font, FontStyle.Bold);
    full(enable);
    Label when = Text1(T("It works from startup, also at the sign-in screen and the lock screen, without anyone signed in.",
                         "Funciona desde a inicialização, também na tela de entrada e na tela de bloqueio, sem ninguém conectado."), true);
    when.Margin = new Padding(0, 0, 0, 10);
    full(when);

    FlowLayoutPanel idRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
    Label id = new Label { Text = Access.FormatId(Access.Get(a, "id")), AutoSize = true, Font = new Font("Consolas", 16f, FontStyle.Bold), Margin = new Padding(0, 2, 10, 2) };
    Button copy = new Button { Text = T("Copy", "Copiar"), AutoSize = true };
    copy.Click += (s, e) => { try { Clipboard.SetText(Access.Get(a, "id")); copy.Text = T("Copied", "Copiado"); } catch { } };
    idRow.Controls.Add(id); idRow.Controls.Add(copy);
    pair(Text1(T("This PC's ID:", "ID deste PC:")), idRow);
    full(Text1(T("Others connect with this ID and the password below. Write it down, or copy it into your list of PCs.",
                 "Os outros se conectam com este ID e a senha abaixo. Anote-o ou copie-o para a sua lista de PCs."), true));

    pw = new TextBox { UseSystemPasswordChar = true, Width = 300, Margin = new Padding(0, 4, 0, 2) };
    pw2 = new TextBox { UseSystemPasswordChar = true, Width = 300, Margin = new Padding(0, 4, 0, 2) };
    Label l1 = Text1(hasPw ? T("New password:", "Nova senha:") : T("Password:", "Senha:")), l2 = Text1(T("Repeat it:", "Repita a senha:"));
    pair(l1, pw); pair(l2, pw2);
    Label hint = Text1(hasPw ? T("Leave empty to keep the current password. A new one disconnects anyone connected now.",
                                 "Deixe em branco para manter a senha atual. Uma senha nova desconecta quem estiver conectado agora.")
                             : T("At least 8 characters. Anyone with the ID and this password can control this PC.",
                                 "Pelo menos 8 caracteres. Qualquer pessoa com o ID e esta senha pode controlar este PC."), true);
    full(hint);

    banner = new CheckBox { Text = T("Show a bar on screen while someone is connected", "Mostrar uma barra na tela enquanto alguém estiver conectado"), AutoSize = true,
                            Checked = !a.ContainsKey("banner") || (a["banner"] as bool? ?? true), Margin = new Padding(0, 12, 0, 2) };
    ask = new CheckBox { Text = T("Ask the person at this PC before each connection", "Pedir permissão a quem estiver neste PC antes de cada conexão"), AutoSize = true,
                         Checked = Access.Get(a, "consent") == "ask", Margin = new Padding(0, 2, 0, 2) };
    full(banner); full(ask);
    Label askHint = Text1(T("The bar has an End button. The question is skipped when nobody is signed in.",
                            "A barra tem um botão Encerrar. Se ninguém estiver conectado ao Windows, a pergunta não aparece."), true);
    askHint.Margin = new Padding(20, 0, 0, 0);
    full(askHint);

    err = new Label { AutoSize = true, ForeColor = Color.Firebrick, Margin = new Padding(0, 10, 0, 0), MaximumSize = new Size(560, 0) };
    full(err);

    FlowLayoutPanel buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
    Button save = new Button { Text = T("Save", "Salvar"), AutoSize = true, MinimumSize = new Size(90, 0) };
    Button cancel = new Button { Text = T("Cancel", "Cancelar"), AutoSize = true, MinimumSize = new Size(90, 0), DialogResult = DialogResult.Cancel };
    buttons.Controls.Add(cancel); buttons.Controls.Add(save);
    full(buttons);
    AcceptButton = save; CancelButton = cancel;
    Controls.Add(t);

    dependent.AddRange(new Control[] { idRow, pw, pw2, l1, l2, hint, banner, ask, askHint });
    enable.CheckedChanged += (s, e) => { foreach (Control c in dependent) c.Enabled = enable.Checked; };
    foreach (Control c in dependent) c.Enabled = enable.Checked;
    save.Click += (s, e) => Save(hasPw);
    Shown += (s, e) => { if (enable.Checked) pw.Focus(); };
  }

  void Save(bool hasPw) {
    err.Text = "";
    if (enable.Checked) {
      if (pw.Text.Length == 0 && !hasPw) { err.Text = T("Choose a password.", "Escolha uma senha."); pw.Focus(); return; }
      if (pw.Text.Length > 0 && pw.Text.Length < 8) { err.Text = T("Use at least 8 characters.", "Use pelo menos 8 caracteres."); pw.Focus(); return; }
      if (pw.Text != pw2.Text) { err.Text = T("The two passwords are different.", "As duas senhas são diferentes."); pw2.Focus(); return; }
    }
    try {
      if (enable.Checked && pw.Text.Length > 0) {
        string salt = Access.Hex(Access.Random(16));
        a["salt"] = salt; a["key"] = Access.Key(pw.Text, salt);
      }
      a["enabled"] = enable.Checked;
      a["banner"] = banner.Checked;
      a["consent"] = ask.Checked ? "ask" : "never";
      a["localEnd"] = true;
      a["lang"] = pt ? "pt" : "en";                 // the bar and the question on this PC's screen
      a["updated"] = DateTime.UtcNow.ToString("o");
      Access.Write(a);
      Access.WriteStatus(a);
      Paths.Write("settings saved: remote access " + (enable.Checked ? "on" : "off") + (pw.Text.Length > 0 ? ", new password" : ""));
    } catch (Exception ex) { err.Text = T("Could not save: ", "Não foi possível salvar: ") + ex.Message; return; }
    DialogResult = DialogResult.OK;
    Close();
  }
}

// (tests on Linux, with Mono: the password key must come out exactly as the app computes it)
static class HashCheck {
  static int Main(string[] args) { Console.WriteLine(Access.Key(args[0], args[1])); Console.WriteLine(Access.NewId()); return 0; }
}

// (tests: ScreenShareRemoteService built with -main:UpdateCheck)  UpdateCheck <update.json> <download folder>
static class UpdateCheck {
  static int Main(string[] args) {
    string installer;
    try { Dictionary<string, object> m = Updater.Prepare(args[0], args[1], out installer); Console.WriteLine("OK " + Access.Get(m, "version") + " " + installer); return 0; }
    catch (UpdateError e) { Console.WriteLine("ERR " + e.Message); return 1; }
  }
}
