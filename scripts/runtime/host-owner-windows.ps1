param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('{"event":"host-owner-bootstrap","stage":"script-started"}')
[Console]::Out.Flush()
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Collections.Concurrent;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public sealed class WorldHubOwnedJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedBytes; public IntPtr reserved2,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit value,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,int length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref SI startup,out PI info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job,process; StreamWriter input; ConcurrentQueue<string> controls=new ConcurrentQueue<string>(); volatile bool controlClosed;
  public int Pid { get; private set; }
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public WorldHubOwnedJob(string executable,string command,string cwd) {
    IntPtr pipeRead=IntPtr.Zero,pipeWrite=IntPtr.Zero,thread=IntPtr.Zero;
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new ExtendedLimit(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
      var attributes=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=1 }; Check(CreatePipe(out pipeRead,out pipeWrite,ref attributes,0)); Check(SetHandleInformation(pipeWrite,1,0));
      var startup=new SI { cb=Marshal.SizeOf(typeof(SI)),flags=0x100,input=pipeRead,output=GetStdHandle(-11),error=GetStdHandle(-12) }; PI info;
      // No business instruction executes before suspended child attachment to the Job.
      Check(CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out info));
      process=info.process; thread=info.thread; Pid=info.pid;
      Check(AssignProcessToJobObject(job,process)); Check(ResumeThread(thread)!=0xffffffff);
      CloseHandle(pipeRead); pipeRead=IntPtr.Zero; CloseHandle(thread); thread=IntPtr.Zero;
      input=new StreamWriter(new FileStream(new SafeFileHandle(pipeWrite,true),FileAccess.Write),new UTF8Encoding(false)); input.AutoFlush=true; pipeWrite=IntPtr.Zero;
      var reader=new Thread(()=> { try { while(true) { var line=Console.In.ReadLine(); if(line==null) break; if(line.Length>131072 || controls.Count>=256) break; controls.Enqueue(line); } } finally { controlClosed=true; } }); reader.IsBackground=true; reader.Start();
    } catch { if(process!=IntPtr.Zero) TerminateProcess(process,1); Dispose(); throw; }
    finally { if(pipeRead!=IntPtr.Zero) CloseHandle(pipeRead); if(pipeWrite!=IntPtr.Zero) CloseHandle(pipeWrite); if(thread!=IntPtr.Zero) CloseHandle(thread); }
  }
  public bool ChildExited { get { uint code; Check(GetExitCodeProcess(process,out code)); return code!=259; } }
  public uint ExitCode { get { uint code; Check(GetExitCodeProcess(process,out code)); return code; } }
  public uint Active { get { Accounting info; Check(QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return info.active; } }
  public string NextControl() { string line; return controls.TryDequeue(out line)?line:null; }
  public bool ControlClosed { get { return controlClosed && controls.IsEmpty; } }
  public void Send(string line) { if(!ChildExited) { try { input.WriteLine(line); } catch(IOException) {} } }
  public void Retire() { Check(TerminateJobObject(job,0)); }
  public void Dispose() { if(input!=null) { input.Dispose(); input=null; } if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } if(process!=IntPtr.Zero) { CloseHandle(process); process=IntPtr.Zero; } }
}
'@
[Console]::Out.WriteLine('{"event":"host-owner-bootstrap","stage":"compiler-ready"}')
[Console]::Out.Flush()
$configurationBytes = [Convert]::FromBase64String($Configuration)
$configurationValue = [Text.Encoding]::UTF8.GetString($configurationBytes) | ConvertFrom-Json
$job = [WorldHubOwnedJob]::new($configurationValue.executable, $configurationValue.command, $configurationValue.cwd)
$retired = $false
try {
  [Console]::Out.WriteLine((@{event='host-owner-ready'; programPid=$job.Pid; profile='windows-job/v1'} | ConvertTo-Json -Compress))
  $observedExit = $false
  while ($true) {
    if (!$observedExit -and $job.ChildExited) { $observedExit=$true; [Console]::Out.WriteLine((@{event='host-program-exit'; code=$job.ExitCode} | ConvertTo-Json -Compress)) }
    $line = $job.NextControl()
    if ($null -ne $line) {
      try { $frame = $line | ConvertFrom-Json } catch { $frame=$null }
      if ($frame.command -eq 'retire-host-tree') { break }
      if ($line.Length -gt 131072) { break }
      $job.Send($line)
    }
    if ($job.ControlClosed) { break }
    Start-Sleep -Milliseconds 20
  }
  $job.Retire()
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ($job.Active -ne 0) { if ([DateTime]::UtcNow -ge $deadline) { throw 'Current owned Job retirement remains unconfirmed' }; Start-Sleep -Milliseconds 20 }
  $retired=$true
  [Console]::Out.WriteLine('{"event":"host-tree-retired","profile":"windows-job/v1"}')
} finally { $job.Dispose() }
if (!$retired) { exit 1 }
