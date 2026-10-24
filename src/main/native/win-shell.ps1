# Long-lived helper that answers Wedge's questions about the Windows shell:
#   probe                 -> the window under the cursor, the cursor position, and the
#                            name of the file item under it (empty if not on a file)
#   focused <hwnd> ...    -> path of the focused item in that Explorer window / the desktop
#   selected <hwnd> ...   -> paths of all selected items there
# Protocol: one request per line ("<id>`t<cmd>`t<args...>"), one reply per line ("<id>`t<result>").
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WedgeShell {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  // Per-monitor awareness makes cursor and window coordinates true physical
  // pixels on every monitor. "System" awareness rescales them on monitors whose
  // scaling differs from the main one, which put the wheel in the wrong place.
  public static void MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {} // PER_MONITOR_AWARE_V2
    SetProcessDPIAware();
  }

  public static string Probe() {
    POINT p;
    GetCursorPos(out p);
    IntPtr h = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
    var cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    var title = new StringBuilder(512);
    GetWindowText(h, title, 512);
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string proc = "";
    try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return h.ToInt64() + "\t" + cls + "\t" + proc + "\t" + title.ToString().Replace("\t", " ") + "\t" + p.X + "\t" + p.Y;
  }
}
"@
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'desktop-icons.cs'))
[WedgeShell]::MakeDpiAware()
$shell = New-Object -ComObject Shell.Application
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$itemTypes = @([System.Windows.Automation.ControlType]::ListItem, [System.Windows.Automation.ControlType]::DataItem)

# Name of the file/folder item under a screen point, or '' when the point is
# on anything else (title bar, toolbar, empty space, navigation pane...).
function Get-ItemAt([int]$x, [int]$y) {
  $el = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y)))
  for ($i = 0; $el -and $i -lt 4; $i++) {
    if ($itemTypes -contains $el.Current.ControlType) {
      # The navigation pane's tree items are not files; neither is "This PC" etc. in it.
      $parent = $walker.GetParent($el)
      if ($parent -and $parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Tree) { return '' }
      return $el.Current.Name
    }
    $el = $walker.GetParent($el)
  }
  return ''
}

function Get-View([string]$hwnd, [string]$cls, [string]$title) {
  if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') {
    $loc = $null; $root = $null; $h = 0
    return $shell.Windows().FindWindowSW([ref]$loc, [ref]$root, 8, [ref]$h, 1) # SWC_DESKTOP, SWFO_NEEDDISPATCH
  }
  $windows = @($shell.Windows() | Where-Object { $_.HWND -eq [int64]$hwnd })
  # Windows 11 tabs share one window handle; the title names the active tab.
  if ($windows.Count -gt 1) {
    $active = @($windows | Where-Object { $title -like "$($_.LocationName)*" })
    if ($active.Count -ge 1) { $windows = $active }
  }
  if ($windows.Count -ge 1) { return $windows[0] }
  return $null
}

[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line -split "`t"
  $out = ''
  try {
    switch ($parts[1]) {
      'probe' {
        $out = [WedgeShell]::Probe()
        $f = $out -split "`t"
        $item = ''
        if (@('Progman', 'WorkerW') -contains $f[1]) {
          # Desktop: ask the icon list directly; UI Automation misses its icons on some builds.
          $item = [DesktopIcons]::ItemAt([int]$f[4], [int]$f[5])
          if (-not $item) { $item = Get-ItemAt ([int]$f[4]) ([int]$f[5]) }
        } elseif (@('CabinetWClass', 'ExploreWClass') -contains $f[1]) { $item = Get-ItemAt ([int]$f[4]) ([int]$f[5]) }
        $out = "$out`t$item"
      }
      'focused' {
        $item = (Get-View $parts[2] $parts[3] $parts[4]).Document.FocusedItem
        if ($item) { $out = "$($item.Name)`t$($item.Path)" }
      }
      'only' {
        # Select just the focused item, undoing what Shift/Ctrl in the shortcut did to the selection.
        $doc = (Get-View $parts[2] $parts[3] $parts[4]).Document
        if ($doc.FocusedItem) { $doc.SelectItem($doc.FocusedItem, 1 + 4 + 16); $out = 'ok' } # SELECT | DESELECTOTHERS | FOCUSED
      }
      'selected' {
        $out = ((Get-View $parts[2] $parts[3] $parts[4]).Document.SelectedItems() | ForEach-Object { $_.Path }) -join "`t"
      }
      'alive' { $out = [string][WedgeShell]::IsWindow([IntPtr][int64]$parts[2]) }
    }
  } catch { $out = '' }
  [Console]::Out.WriteLine("$($parts[0])`t$out")
  [Console]::Out.Flush()
}
