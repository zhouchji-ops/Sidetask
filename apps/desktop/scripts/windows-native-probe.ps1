param(
  [ValidateSet('environment', 'processes', 'runtime', 'windows', 'close')][string]$Action = 'environment',
  [string]$Executable = '',
  [int]$OwnerProcessId = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Only process-scoped reads and WM_CLOSE of this run's exact application are used.
# Never terminate by process name: the user's regular SideTask may be running.
if ($Action -eq 'processes') {
  $expected = [System.IO.Path]::GetFullPath($Executable)
  $items = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object ProcessId, ParentProcessId, SessionId, ExecutablePath, CreationDate)
  ConvertTo-Json -InputObject $items -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'runtime') {
  if ($OwnerProcessId -le 0) { throw 'A positive OwnerProcessId is required' }
  $owner = Get-Process -Id $OwnerProcessId -ErrorAction Stop
  if (![string]::Equals($owner.Path, [System.IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime owner path mismatch' }
  $all = @(Get-CimInstance Win32_Process)
  $owned = [System.Collections.Generic.HashSet[uint32]]::new()
  $null = $owned.Add([uint32]$OwnerProcessId)
  do {
    $added = $false
    foreach ($process in $all) {
      if ($owned.Contains([uint32]$process.ParentProcessId) -and $owned.Add([uint32]$process.ProcessId)) { $added = $true }
    }
  } while ($added)
  $items = @($all | Where-Object { $owned.Contains([uint32]$_.ProcessId) -and $_.Name -ieq 'msedgewebview2.exe' -and $_.ExecutablePath } | ForEach-Object {
    @{ processId = $_.ProcessId; path = $_.ExecutablePath; version = (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion }
  })
  ConvertTo-Json -InputObject $items -Depth 4 -Compress
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SideTaskSmokeNative {
  public delegate bool EnumProc(IntPtr window, IntPtr param);
  public delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref Rect bounds, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MonitorInfo {
    public uint Size; public Rect Monitor, Work; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Device;
  }
  public class ScreenRect {
    public int X, Y; public long Width, Height;
    public ScreenRect(Rect rect) { X=rect.Left; Y=rect.Top; Width=(long)rect.Right-rect.Left; Height=(long)rect.Bottom-rect.Top; }
  }
  public class Screen { public string device; public bool primary; public ScreenRect bounds, workArea; }
  public class Window { public long Handle; public string Title; public bool Visible; public uint Dpi; public Rect Bounds; public string CoordinateSpace="physical-pixels"; public int ProbeDpiAwareness=2; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc callback, IntPtr param);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  // PowerShell itself is DPI-unaware. Set awareness within each synchronous
  // native sampling method, before any coordinates are read, then restore it.
  // Merely attaching GetDpiForWindow to a virtualized rectangle is insufficient.
  private sealed class PhysicalScope : IDisposable {
    private IntPtr previous;
    public PhysicalScope() {
      previous=SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
      if(previous == IntPtr.Zero) throw new Exception("Per-monitor DPI context unavailable: " + Marshal.GetLastWin32Error());
      if(GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) != 2) {
        Dispose(); throw new Exception("Physical pixel sampling requires per-monitor DPI awareness");
      }
    }
    public void Dispose() {
      if(previous != IntPtr.Zero) { SetThreadDpiAwarenessContext(previous); previous=IntPtr.Zero; }
    }
  }
  public static bool HasInputDesktop() { var d = OpenInputDesktop(0, false, 0x0100); if(d == IntPtr.Zero) return false; CloseDesktop(d); return true; }
  public static Screen[] Screens() {
    using(var physical = new PhysicalScope()) {
      var output = new List<Screen>(); string failure=null;
      var success=EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr monitor, IntPtr dc, ref Rect unused, IntPtr param) => {
        var info=new MonitorInfo(); info.Size=(uint)Marshal.SizeOf(typeof(MonitorInfo));
        if(!GetMonitorInfo(monitor, ref info)) { failure="GetMonitorInfo failed: " + Marshal.GetLastWin32Error(); return false; }
        output.Add(new Screen { device=info.Device, primary=(info.Flags & 1) != 0, bounds=new ScreenRect(info.Monitor), workArea=new ScreenRect(info.Work) }); return true;
      }, IntPtr.Zero);
      if(!success) throw new Exception(failure ?? "EnumDisplayMonitors failed: " + Marshal.GetLastWin32Error());
      return output.ToArray();
    }
  }
  public static Window[] Windows(uint owner) {
    using(var physical = new PhysicalScope()) {
      var output = new List<Window>(); string failure=null;
      var success=EnumWindows((hwnd, unused) => { uint pid; GetWindowThreadProcessId(hwnd, out pid); if(pid != owner) return true;
        var title = new StringBuilder(1024); GetWindowText(hwnd, title, title.Capacity); Rect bounds;
        if(!GetWindowRect(hwnd, out bounds)) { failure="GetWindowRect failed: " + Marshal.GetLastWin32Error(); return false; }
        var dpi=GetDpiForWindow(hwnd);
        if(dpi == 0) { failure="GetDpiForWindow failed"; return false; }
        output.Add(new Window { Handle=hwnd.ToInt64(), Title=title.ToString(), Visible=IsWindowVisible(hwnd), Dpi=dpi, Bounds=bounds }); return true;
      }, IntPtr.Zero);
      if(!success) throw new Exception(failure ?? "EnumWindows failed: " + Marshal.GetLastWin32Error());
      return output.ToArray();
    }
  }
  public static void Close(uint owner) {
    var matches = Array.FindAll(Windows(owner), w => w.Title == "\u4fa7\u7b3a \u00b7 SideTask");
    if(matches.Length != 1) throw new Exception("Expected exactly one SideTask console owned by this run");
    if(!PostMessage(new IntPtr(matches[0].Handle), 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new Exception("WM_CLOSE failed");
  }
}
'@

if ($Action -in @('windows', 'close')) {
  if ($OwnerProcessId -le 0) { throw 'A positive OwnerProcessId is required' }
  $owner = Get-Process -Id $OwnerProcessId -ErrorAction Stop
  if (![string]::Equals($owner.Path, [System.IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Process path does not match this run executable'
  }
  if ($Action -eq 'close') { [SideTaskSmokeNative]::Close([uint32]$OwnerProcessId) }
  ConvertTo-Json -InputObject @([SideTaskSmokeNative]::Windows([uint32]$OwnerProcessId)) -Depth 5 -Compress
  exit 0
}

$runtimeRoots = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients'
)
$runtimes = @($runtimeRoots | ForEach-Object {
  if (Test-Path -LiteralPath $_) {
    Get-ChildItem -LiteralPath $_ | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
      Where-Object { $_.name -like '*WebView2*' } | Select-Object name, pv, location
  }
})
$screens = @([SideTaskSmokeNative]::Screens())
@{
  os = [Environment]::OSVersion.VersionString
  architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  interactive = [Environment]::UserInteractive
  inputDesktop = [SideTaskSmokeNative]::HasInputDesktop()
  sessionId = (Get-Process -Id $PID).SessionId
  coordinateSpace = 'physical-pixels'
  probeDpiAwareness = 'per-monitor-v2'
  screens = $screens
  webview2 = $runtimes
} | ConvertTo-Json -Depth 6 -Compress
