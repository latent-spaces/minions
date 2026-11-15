// Trusted Windows lifecycle helper, compiled in memory by the packaged PS script.
// References: learn.microsoft.com/windows/win32/procthread/job-objects and
// /api/processthreadsapi/nf-processthreadsapi-createprocessw.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Minions {
  public static class WindowsJob {
    const uint KillOnClose = 0x2000, Suspended = 4, NoWindow = 0x08000000, ExtendedStartup = 0x80000;
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
      public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
      public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong r1, r2, r3, r4, r5, r6; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public Limits basic; public Counters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long user, kernel, periodUser, periodKernel; public uint faults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
      public int cb; public string reserved, desktop, title; public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
      public short show, reserved2; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(ref Security security, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);

    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static void Send(StreamWriter writer, object value) { writer.WriteLine(new JavaScriptSerializer().Serialize(value)); writer.Flush(); }
    static string Quote(string value) {
      if (value.IndexOf('\0') >= 0) throw new ArgumentException();
      StringBuilder result = new StringBuilder("\""); int slashes = 0;
      foreach (char ch in value) {
        if (ch == '\\') { slashes++; continue; }
        if (ch == '"') result.Append('\\', slashes * 2 + 1); else result.Append('\\', slashes);
        slashes = 0; result.Append(ch);
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static bool Empty(IntPtr job) {
      Accounting value;
      Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      return value.activeProcesses == 0;
    }
    static void Reap(IntPtr job) {
      Check(TerminateJobObject(job, 1));
      long until = Now() + 10000;
      while (!Empty(job)) { if (Now() >= until) throw new TimeoutException(); Thread.Sleep(20); }
    }
    static IntPtr NewJob(string name) {
      IntPtr descriptor;
      string sid = WindowsIdentity.GetCurrent().User.Value;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero));
      IntPtr job = IntPtr.Zero;
      try {
        Security security = new Security { length = Marshal.SizeOf(typeof(Security)), descriptor = descriptor, inherit = 0 };
        job = CreateJobObject(ref security, name); int error = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(error);
        if (error == 183) throw new InvalidOperationException("A mission job already exists.");
        ExtendedLimits limits = new ExtendedLimits(); limits.basic.flags = KillOnClose;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        return job;
      } catch { if (job != IntPtr.Zero) CloseHandle(job); throw; }
      finally { LocalFree(descriptor); }
    }
    static ProcessInfo Launch(IntPtr job, IDictionary<string, object> message) {
      long launchBy = message.ContainsKey("launchByAt") && message["launchByAt"] != null ? Convert.ToInt64(message["launchByAt"]) : Int64.MaxValue;
      if (launchBy <= Now() || Convert.ToInt64(message["deadline"]) <= Now()) throw new TimeoutException();
      string command = (string)message["command"];
      if (!Path.IsPathRooted(command) || !command.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException();
      StringBuilder args = new StringBuilder(Quote(command));
      foreach (object arg in (IEnumerable)message["args"]) args.Append(' ').Append(Quote((string)arg));
      if (args.Length >= 32767) throw new ArgumentException();
      ProcessInfo child = new ProcessInfo(); IntPtr size = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
      IntPtr[] inherited = new IntPtr[3]; bool attributesReady = false, assigned = false;
      try {
        // Only duplicate stdin/out/err; the job and control pipe cannot leak to a child.
        for (int i = 0; i < 3; i++) Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10 - i), GetCurrentProcess(), out inherited[i], 0, true, 2));
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attributes = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); attributesReady = true;
        handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.Copy(inherited, 0, handles, 3);
        Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
        StartupEx start = new StartupEx(); start.startup.cb = Marshal.SizeOf(typeof(StartupEx)); start.startup.flags = 0x100;
        start.startup.input = inherited[0]; start.startup.output = inherited[1]; start.startup.error = inherited[2]; start.attributes = attributes;
        Check(CreateProcess(command, args, IntPtr.Zero, IntPtr.Zero, true, Suspended | NoWindow | ExtendedStartup, IntPtr.Zero, Environment.CurrentDirectory, ref start, out child));
        // A suspended process cannot start a child before containment succeeds.
        Check(AssignProcessToJobObject(job, child.process)); assigned = true;
        if (launchBy <= Now() || Convert.ToInt64(message["deadline"]) <= Now()) throw new TimeoutException();
        if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception();
        CloseHandle(child.thread); child.thread = IntPtr.Zero; return child;
      } catch {
        if (child.process != IntPtr.Zero) {
          if (assigned) Reap(job); else { Check(TerminateProcess(child.process, 1)); if (WaitForSingleObject(child.process, 10000) != 0) throw new TimeoutException(); }
          CloseHandle(child.process);
        }
        if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
        throw;
      } finally {
        if (attributesReady) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        foreach (IntPtr handle in inherited) if (handle != IntPtr.Zero) CloseHandle(handle);
      }
    }
    public static int Run(string mode, string pipeName, string jobName) {
      if (!System.Text.RegularExpressions.Regex.IsMatch(jobName ?? "", @"^Local\\Minions-[a-f0-9]{32}$")) throw new ArgumentException();
      IntPtr job = IntPtr.Zero; ProcessInfo child = new ProcessInfo();
      try {
        if (mode == "Cleanup") {
          job = OpenJobObject(0x0c, false, jobName);
          if (job == IntPtr.Zero) { if (Marshal.GetLastWin32Error() != 2) throw new Win32Exception(); }
          else Reap(job);
          Console.Out.WriteLine("{\"cleanupConfirmed\":true}"); return 0;
        }
        job = NewJob(jobName);
        if (mode == "Probe") { if (!Empty(job)) throw new InvalidOperationException(); Console.Out.WriteLine("{\"supported\":true}"); return 0; }
        if (mode != "Run" || !System.Text.RegularExpressions.Regex.IsMatch(pipeName ?? "", @"^minions-[a-f0-9]{32}$")) throw new ArgumentException();
        PipeSecurity acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        using (NamedPipeServerStream pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, acl)) {
          IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
          if (!connection.AsyncWaitHandle.WaitOne(30000)) throw new TimeoutException(); pipe.EndWaitForConnection(connection);
          using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
          using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
            Send(writer, new { ready = true });
            Task<string> pending = reader.ReadLineAsync(); long deadline = Now() + 10000; bool stopped = false;
            for (;;) {
              if (pending.IsCompleted) {
                string line = pending.GetAwaiter().GetResult(); if (line == null) { Reap(job); return 1; }
                if (line.Length > 1024 * 1024) throw new ArgumentException();
                IDictionary<string, object> message = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 }.DeserializeObject(line) as IDictionary<string, object>;
                if (message == null) throw new ArgumentException();
                if (child.process == IntPtr.Zero) {
                  if (message.ContainsKey("action")) { Send(writer, new { cleanupConfirmed = true }); return 1; }
                  deadline = Convert.ToInt64(message["deadline"]);
                  if (deadline <= Now() || deadline - Now() > 86400000) throw new ArgumentException();
                  child = Launch(job, message); Send(writer, new { nativeStarted = child.pid });
                } else if (message.ContainsKey("action") && (string)message["action"] == "extend-deadline") {
                  long value = Convert.ToInt64(message["deadline"]); bool valid = !stopped && Now() < deadline && value >= deadline && value - Now() <= 86400000;
                  if (valid) deadline = value;
                  Send(writer, new { deadlineRequest = (string)message["id"], deadlineAt = valid ? (long?)value : null });
                } else { stopped = true; Reap(job); }
                pending = reader.ReadLineAsync();
              }
              if (Now() >= deadline) { stopped = true; Send(writer, new { guardStop = "deadline" }); Reap(job); }
              if (child.process != IntPtr.Zero && WaitForSingleObject(child.process, 0) == 0) {
                uint code; Check(GetExitCodeProcess(child.process, out code));
                Send(writer, new { nativeClosed = new { exitCode = code, signal = (string)null } });
                Reap(job); Send(writer, new { cleanupConfirmed = true }); return stopped ? 1 : unchecked((int)code);
              }
              if (stopped && child.process == IntPtr.Zero) { Send(writer, new { cleanupConfirmed = true }); return 1; }
              Thread.Sleep(10);
            }
          }
        }
      } finally {
        // Closing the last non-inherited handle also kills the entire job after
        // an unexpected exception or forced helper exit. Never infer success here.
        if (job != IntPtr.Zero) CloseHandle(job);
        if (child.process != IntPtr.Zero) CloseHandle(child.process);
      }
    }
  }
}
