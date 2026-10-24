// Desktop icon hit testing for win-shell.ps1. UI Automation does not see the desktop's
// icons on some Windows 11 builds, so this asks the icon list itself (LVM_HITTEST).
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DesktopIcons {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr a, UIntPtr size, uint type, uint protect);
  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr a, UIntPtr size, uint type);
  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr a, byte[] b, UIntPtr n, out UIntPtr w);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr a, byte[] b, UIntPtr n, out UIntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint LVM_HITTEST = 0x1012, LVM_GETITEMTEXTW = 0x1073;

  // The desktop's icon list: Progman > SHELLDLL_DefView > SysListView32, or under a
  // WorkerW when the wallpaper slideshow / a live wallpaper has moved it there.
  public static IntPtr FindList() {
    IntPtr view = FindWindowEx(GetShellWindow(), IntPtr.Zero, "SHELLDLL_DefView", null);
    if (view == IntPtr.Zero) {
      EnumWindows((h, l) => {
        IntPtr v = FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (v != IntPtr.Zero) { view = v; return false; }
        return true;
      }, IntPtr.Zero);
    }
    return view == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(view, IntPtr.Zero, "SysListView32", null);
  }

  // Runs fn with a scratch buffer inside Explorer, where list view messages read and write.
  static T WithRemote<T>(IntPtr list, Func<IntPtr, IntPtr, T> fn, T fallback) {
    uint pid;
    GetWindowThreadProcessId(list, out pid);
    IntPtr proc = OpenProcess(0x0008 | 0x0010 | 0x0020, false, pid); // VM_OPERATION | VM_READ | VM_WRITE
    if (proc == IntPtr.Zero) return fallback;
    IntPtr mem = VirtualAllocEx(proc, IntPtr.Zero, (UIntPtr)4096, 0x3000, 0x04);
    try { return mem == IntPtr.Zero ? fallback : fn(proc, mem); }
    finally {
      if (mem != IntPtr.Zero) VirtualFreeEx(proc, mem, UIntPtr.Zero, 0x8000);
      CloseHandle(proc);
    }
  }

  static string ItemText(IntPtr list, IntPtr proc, IntPtr mem, int index) {
    // LVITEMW (x64): iSubItem at 8, pszText at 24, cchTextMax at 32. Text goes at +512.
    byte[] item = new byte[88];
    BitConverter.GetBytes((long)mem + 512).CopyTo(item, 24);
    BitConverter.GetBytes(260).CopyTo(item, 32);
    UIntPtr n;
    WriteProcessMemory(proc, mem, item, (UIntPtr)item.Length, out n);
    int len = (int)SendMessage(list, LVM_GETITEMTEXTW, (IntPtr)index, mem);
    if (len <= 0) return "";
    byte[] text = new byte[len * 2];
    ReadProcessMemory(proc, mem + 512, text, (UIntPtr)text.Length, out n);
    return Encoding.Unicode.GetString(text);
  }

  // Label of the desktop icon at a screen point (physical pixels), or "" for empty desktop.
  public static string ItemAt(int x, int y) {
    IntPtr list = FindList();
    if (list == IntPtr.Zero) return "";
    POINT p = new POINT { X = x, Y = y };
    ScreenToClient(list, ref p);
    return WithRemote(list, (proc, mem) => {
      byte[] hit = new byte[24]; // LVHITTESTINFO: pt, flags, iItem, iSubItem, iGroup
      BitConverter.GetBytes(p.X).CopyTo(hit, 0);
      BitConverter.GetBytes(p.Y).CopyTo(hit, 4);
      UIntPtr n;
      WriteProcessMemory(proc, mem, hit, (UIntPtr)hit.Length, out n);
      int index = (int)SendMessage(list, LVM_HITTEST, IntPtr.Zero, mem);
      return index < 0 ? "" : ItemText(list, proc, mem, index);
    }, "");
  }
}
