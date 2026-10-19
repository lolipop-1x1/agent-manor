import { win32 } from "node:path";

export const WINDOWS_INSTALL_PAYLOAD = "AGENT_MANOR_INSTALL_PROCESS";
export const WINDOWS_DESCENDANTS_MARKER = "AGENT_MANOR_INSTALL_DESCENDANTS_RUNNING";
export const WINDOWS_MISSING_COMMAND_MARKER = "AGENT_MANOR_INSTALL_COMMAND_NOT_FOUND";

/** Windows 原生 argv 的反斜杠和引号规则；不通过 cmd 或 PowerShell 解释参数。 */
export function windowsArgument(value: string): string {
  let quoted = '"', slashes = 0;
  for (const character of value) {
    if (character === "\\") { slashes++; continue; }
    quoted += "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return quoted + "\\".repeat(slashes * 2) + '"';
}

// wrapper 留在 Job 外；安装器先挂起创建、加入 Job，再恢复执行，后代默认继承 Job。
const wrapper = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_MANOR_INSTALL_PROCESS)) | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('AGENT_MANOR_INSTALL_PROCESS', $null, 'Process')
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ManorInstallJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Length;
    public IntPtr Descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr information, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting information, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  static void SetLimits(IntPtr job, uint flags) {
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.Flags = flags;
    int size = Marshal.SizeOf(typeof(ExtendedLimits));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, memory, false);
      if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(memory); }
  }
  static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      // 句柄异常关闭时终止成员；不允许后代脱离 Job。
      SetLimits(job, 0x00002000);
      return job;
    } catch { CloseHandle(job); throw; }
  }
  static uint Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info.ActiveProcesses;
  }
  static void Stop(IntPtr job, ref IntPtr process, bool assigned, uint code) {
    if (process != IntPtr.Zero && !assigned) TerminateProcess(process, code);
    if (!TerminateJobObject(job, code)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (process != IntPtr.Zero) {
      WaitForSingleObject(process, 0xffffffff);
      CloseHandle(process);
      process = IntPtr.Zero;
    }
    while (Active(job) != 0) Thread.Sleep(10);
  }
  public static int Run(string application, string arguments, string directory) {
    IntPtr job = Create();
    IntPtr input = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    bool assigned = false;
    int cancelled = 0;
    Thread cancellation = new Thread(delegate() {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line == "abort") { Interlocked.Exchange(ref cancelled, 1); return; }
        }
      } catch { }
      Interlocked.Exchange(ref cancelled, 1);
    });
    cancellation.IsBackground = true;
    cancellation.Start();
    try {
      SecurityAttributes security = new SecurityAttributes();
      security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
      security.Inherit = true;
      input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
      if (input == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      StartupInfo startup = new StartupInfo();
      startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
      startup.Flags = 0x100;
      startup.Input = input;
      startup.Output = GetStdHandle(-11);
      startup.Error = GetStdHandle(-12);
      if (!SetHandleInformation(startup.Output, 1, 1) || !SetHandleInformation(startup.Error, 1, 1)
          || !SetHandleInformation(GetStdHandle(-10), 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (Interlocked.CompareExchange(ref cancelled, 0, 0) != 0) { Stop(job, ref child.Process, assigned, 130); return 130; }
      // 挂起创建且不新建控制台；加入 Job 之前不会执行安装代码。
      if (!CreateProcess(application, new StringBuilder(arguments), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out child)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(job, child.Process)) throw new Win32Exception(Marshal.GetLastWin32Error());
      assigned = true;
      if (Interlocked.CompareExchange(ref cancelled, 0, 0) != 0) { Stop(job, ref child.Process, assigned, 130); return 130; }
      if (ResumeThread(child.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      CloseHandle(child.Thread);
      child.Thread = IntPtr.Zero;
      for (;;) {
        if (Interlocked.CompareExchange(ref cancelled, 0, 0) != 0) { Stop(job, ref child.Process, assigned, 130); return 130; }
        uint state = WaitForSingleObject(child.Process, 20);
        if (state == 0) break;
        if (state != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      uint code;
      if (!GetExitCodeProcess(child.Process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
      // 释放根进程句柄后再读取活动计数，避免完成进程的句柄延迟 Job 计数归零。
      CloseHandle(child.Process);
      child.Process = IntPtr.Zero;
      if (Active(job) != 0) {
        Console.Error.WriteLine("AGENT_MANOR_INSTALL_DESCENDANTS_RUNNING");
        Stop(job, ref child.Process, assigned, 125);
        return 125;
      }
      return unchecked((int)code);
    } catch {
      Stop(job, ref child.Process, assigned, 1);
      throw;
    } finally {
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
      CloseHandle(job);
    }
  }
}
'@
  $directory = $null
  if ($payload.cwd) { $directory = [string]$payload.cwd }
  $code = [ManorInstallJob]::Run([string]$payload.command, [string]$payload.arguments, $directory)
  exit $code
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = 1
  if ($cause -is [ComponentModel.Win32Exception] -and ($cause.NativeErrorCode -eq 2 -or $cause.NativeErrorCode -eq 3)) {
    [Console]::Error.WriteLine('AGENT_MANOR_INSTALL_COMMAND_NOT_FOUND')
    $code = 127
  }
  [Console]::Error.WriteLine('Installation process containment failed: ' + $cause.Message)
  exit $code
}
`;

/** 固定脚本与用户参数通过独立编码通道传递；无法建立 Job 时不会启动安装器。 */
export function windowsInstallLaunch(command: string, args: string[], cwd?: string, environment: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const payload = Buffer.from(JSON.stringify({ command, arguments: [command, ...args].map(windowsArgument).join(" "), ...(cwd ? { cwd } : {}) }), "utf8").toString("base64");
  return { command: win32.join(environment.SystemRoot ?? environment.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")], env: { ...environment, [WINDOWS_INSTALL_PAYLOAD]: payload } };
}
