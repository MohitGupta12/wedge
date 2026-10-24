// Wedge's Windows shell helper: a small native stand-in for native/win-shell.ps1 that
// answers the same questions with a few MB of memory instead of a PowerShell runtime.
//   probe                    -> window under the cursor, cursor position, and the name
//                               of the file item under it ('' if not on a file)
//   focused <hwnd> <cls> <t> -> name and path of the focused item in that window
//   selected <hwnd> <cls> <t>-> paths of the selected items
//   only <hwnd> <cls> <t>    -> select just the focused item
//   alive <hwnd>             -> whether the window still exists
// Protocol: one request per line ("<id>\t<cmd>\t<args...>"), one reply per line
// ("<id>\t<result>"), UTF-8 both ways. Prints "ready" once started.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <exdisp.h>
#include <shlguid.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <uiautomation.h>
#include <cstdio>
#include <string>
#include <vector>

static IUIAutomation *g_uia = nullptr;
static IUIAutomationTreeWalker *g_walker = nullptr;

template <class T> static void release(T *&p) {
  if (p) p->Release();
  p = nullptr;
}

static std::string utf8(const std::wstring &w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::wstring wide(const std::string &s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

// Tabs and newlines would break the line protocol.
static std::wstring clean(std::wstring s) {
  for (auto &c : s) if (c == L'\t' || c == L'\n' || c == L'\r') c = L' ';
  return s;
}

static std::wstring className(HWND h) {
  wchar_t buf[256] = L"";
  GetClassNameW(h, buf, 256);
  return buf;
}

static bool isDesktopClass(const std::wstring &cls) { return cls == L"Progman" || cls == L"WorkerW"; }
static bool isExplorerClass(const std::wstring &cls) { return cls == L"CabinetWClass" || cls == L"ExploreWClass"; }

// ----- desktop icons: LVM_HITTEST on the desktop's list view ---------------------

static HWND desktopList() {
  HWND view = FindWindowExW(GetShellWindow(), nullptr, L"SHELLDLL_DefView", nullptr);
  if (!view) {
    EnumWindows([](HWND h, LPARAM p) -> BOOL {
      HWND v = FindWindowExW(h, nullptr, L"SHELLDLL_DefView", nullptr);
      if (v) { *(HWND *)p = v; return FALSE; }
      return TRUE;
    }, (LPARAM)&view);
  }
  return view ? FindWindowExW(view, nullptr, L"SysListView32", nullptr) : nullptr;
}

static std::wstring desktopItemAt(POINT screen) {
  HWND list = desktopList();
  if (!list) return L"";
  POINT p = screen;
  ScreenToClient(list, &p);
  DWORD pid = 0;
  GetWindowThreadProcessId(list, &pid);
  HANDLE proc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, FALSE, pid);
  if (!proc) return L"";
  std::wstring result;
  BYTE *mem = (BYTE *)VirtualAllocEx(proc, nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (mem) {
    LVHITTESTINFO hit = {};
    hit.pt = p;
    SIZE_T n;
    WriteProcessMemory(proc, mem, &hit, sizeof(hit), &n);
    int index = (int)SendMessageW(list, LVM_HITTEST, 0, (LPARAM)mem);
    if (index >= 0) {
      LVITEMW item = {};
      item.iSubItem = 0;
      item.pszText = (LPWSTR)(mem + 512);
      item.cchTextMax = 260;
      WriteProcessMemory(proc, mem, &item, sizeof(item), &n);
      int len = (int)SendMessageW(list, LVM_GETITEMTEXTW, index, (LPARAM)mem);
      if (len > 0) {
        std::vector<wchar_t> text(len + 1, 0);
        ReadProcessMemory(proc, mem + 512, text.data(), len * sizeof(wchar_t), &n);
        result.assign(text.data(), len);
      }
    }
    VirtualFreeEx(proc, mem, 0, MEM_RELEASE);
  }
  CloseHandle(proc);
  return result;
}

// ----- Explorer windows: UI Automation -------------------------------------------

// Name of the file/folder item under a point, or '' on anything else (toolbar,
// empty space, the navigation pane's tree...).
static std::wstring explorerItemAt(POINT p) {
  if (!g_uia) return L"";
  IUIAutomationElement *el = nullptr;
  if (FAILED(g_uia->ElementFromPoint(p, &el)) || !el) return L"";
  std::wstring name;
  for (int i = 0; el && i < 4; i++) {
    CONTROLTYPEID type = 0;
    el->get_CurrentControlType(&type);
    if (type == UIA_ListItemControlTypeId || type == UIA_DataItemControlTypeId) {
      IUIAutomationElement *parent = nullptr;
      g_walker->GetParentElement(el, &parent);
      CONTROLTYPEID ptype = 0;
      if (parent) parent->get_CurrentControlType(&ptype);
      release(parent);
      if (ptype != UIA_TreeControlTypeId) {
        BSTR b = nullptr;
        if (SUCCEEDED(el->get_CurrentName(&b)) && b) {
          name = b;
          SysFreeString(b);
        }
      }
      break;
    }
    IUIAutomationElement *parent = nullptr;
    g_walker->GetParentElement(el, &parent);
    release(el);
    el = parent;
  }
  release(el);
  return name;
}

static std::wstring probe() {
  POINT p;
  GetCursorPos(&p);
  HWND h = GetAncestor(WindowFromPoint(p), GA_ROOT);
  std::wstring cls = className(h);
  wchar_t title[512] = L"";
  GetWindowTextW(h, title, 512);
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  std::wstring procName;
  if (HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
    wchar_t path[MAX_PATH];
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameW(proc, 0, path, &size)) {
      std::wstring full(path, size);
      size_t slash = full.find_last_of(L'\\');
      procName = full.substr(slash + 1);
      size_t dot = procName.find_last_of(L'.');
      if (dot != std::wstring::npos) procName = procName.substr(0, dot);
    }
    CloseHandle(proc);
  }
  std::wstring item;
  if (isDesktopClass(cls)) {
    item = desktopItemAt(p);
    if (item.empty()) item = explorerItemAt(p);
  } else if (isExplorerClass(cls)) {
    item = explorerItemAt(p);
  }
  return std::to_wstring((long long)(INT_PTR)h) + L"\t" + cls + L"\t" + procName + L"\t" + clean(title) + L"\t" +
         std::to_wstring(p.x) + L"\t" + std::to_wstring(p.y) + L"\t" + clean(item);
}

// ----- Shell views: the folder view inside an Explorer window or the desktop -----

static IFolderView2 *viewFromBrowser(IDispatch *disp) {
  IFolderView2 *view = nullptr;
  IServiceProvider *sp = nullptr;
  if (disp && SUCCEEDED(disp->QueryInterface(IID_PPV_ARGS(&sp)))) {
    IShellBrowser *browser = nullptr;
    if (SUCCEEDED(sp->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(&browser)))) {
      IShellView *sv = nullptr;
      if (SUCCEEDED(browser->QueryActiveShellView(&sv))) {
        sv->QueryInterface(IID_PPV_ARGS(&view));
        release(sv);
      }
      release(browser);
    }
    release(sp);
  }
  return view;
}

static IFolderView2 *findView(HWND hwnd, const std::wstring &cls, const std::wstring &title) {
  IShellWindows *windows = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&windows)))) return nullptr;
  IFolderView2 *result = nullptr;
  if (isDesktopClass(cls)) {
    VARIANT loc = {}, root = {};
    loc.vt = VT_I4;
    loc.lVal = CSIDL_DESKTOP;
    root.vt = VT_EMPTY;
    long h = 0;
    IDispatch *disp = nullptr;
    if (windows->FindWindowSW(&loc, &root, SWC_DESKTOP, &h, SWFO_NEEDDISPATCH, &disp) == S_OK) {
      result = viewFromBrowser(disp);
      release(disp);
    }
  } else {
    // Windows 11 tabs share one window handle; the title names the active tab.
    long count = 0;
    windows->get_Count(&count);
    IFolderView2 *fallback = nullptr;
    for (long i = 0; i < count && !result; i++) {
      VARIANT idx = {};
      idx.vt = VT_I4;
      idx.lVal = i;
      IDispatch *disp = nullptr;
      if (FAILED(windows->Item(idx, &disp)) || !disp) continue;
      IWebBrowserApp *app = nullptr;
      if (SUCCEEDED(disp->QueryInterface(IID_PPV_ARGS(&app)))) {
        SHANDLE_PTR h = 0;
        app->get_HWND(&h);
        if ((HWND)h == hwnd) {
          BSTR name = nullptr;
          app->get_LocationName(&name);
          bool active = name && title.compare(0, SysStringLen(name), name) == 0;
          if (name) SysFreeString(name);
          IFolderView2 *v = viewFromBrowser(disp);
          if (v && active) result = v;
          else if (v && !fallback) fallback = v;
          else release(v);
        }
        release(app);
      }
      release(disp);
    }
    if (result) release(fallback);
    else result = fallback;
  }
  release(windows);
  return result;
}

static std::wstring itemName(IShellItem *item, SIGDN form) {
  LPWSTR s = nullptr;
  std::wstring out;
  if (SUCCEEDED(item->GetDisplayName(form, &s)) && s) {
    out = s;
    CoTaskMemFree(s);
  }
  return out;
}

static std::wstring focused(HWND hwnd, const std::wstring &cls, const std::wstring &title, bool selectOnly) {
  IFolderView2 *view = findView(hwnd, cls, title);
  if (!view) return L"";
  std::wstring out;
  int index = -1;
  if (SUCCEEDED(view->GetFocusedItem(&index)) && index >= 0) {
    if (selectOnly) {
      view->SelectItem(index, SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_FOCUSED);
      out = L"ok";
    } else {
      IShellItem *item = nullptr;
      if (SUCCEEDED(view->GetItem(index, IID_PPV_ARGS(&item)))) {
        std::wstring path = itemName(item, SIGDN_FILESYSPATH);
        if (!path.empty()) out = clean(itemName(item, SIGDN_NORMALDISPLAY)) + L"\t" + clean(path);
        release(item);
      }
    }
  }
  release(view);
  return out;
}

static std::wstring selected(HWND hwnd, const std::wstring &cls, const std::wstring &title) {
  IFolderView2 *view = findView(hwnd, cls, title);
  if (!view) return L"";
  std::wstring out;
  IShellItemArray *items = nullptr;
  if (SUCCEEDED(view->GetSelection(FALSE, &items)) && items) {
    DWORD count = 0;
    items->GetCount(&count);
    for (DWORD i = 0; i < count; i++) {
      IShellItem *item = nullptr;
      if (FAILED(items->GetItemAt(i, &item))) continue;
      std::wstring path = itemName(item, SIGDN_FILESYSPATH);
      if (!path.empty()) out += (out.empty() ? L"" : L"\t") + clean(path);
      release(item);
    }
    release(items);
  }
  release(view);
  return out;
}

// ----- main loop -------------------------------------------------------------------

static std::vector<std::wstring> split(const std::wstring &s) {
  std::vector<std::wstring> parts;
  size_t start = 0;
  for (;;) {
    size_t tab = s.find(L'\t', start);
    parts.push_back(s.substr(start, tab == std::wstring::npos ? std::wstring::npos : tab - start));
    if (tab == std::wstring::npos) break;
    start = tab + 1;
  }
  return parts;
}

static void reply(const std::wstring &id, const std::wstring &result) {
  std::string line = utf8(id + L"\t" + result) + "\n";
  fwrite(line.data(), 1, line.size(), stdout);
  fflush(stdout);
}

int main() {
  // Per-monitor awareness: cursor and window coordinates stay true physical pixels
  // on every monitor, which mixed-DPI setups need to place the wheel correctly.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&g_uia)))) {
    g_uia->get_ControlViewWalker(&g_walker);
  }
  fputs("ready\n", stdout);
  fflush(stdout);
  char buf[8192];
  while (fgets(buf, sizeof(buf), stdin)) {
    std::string line(buf);
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    std::vector<std::wstring> parts = split(wide(line));
    if (parts.size() < 2) continue;
    const std::wstring &cmd = parts[1];
    auto arg = [&](size_t i) { return i < parts.size() ? parts[i] : std::wstring(); };
    HWND hwnd = (HWND)(INT_PTR)_wtoi64(arg(2).c_str());
    std::wstring out;
    if (cmd == L"probe") out = probe();
    else if (cmd == L"focused") out = focused(hwnd, arg(3), arg(4), false);
    else if (cmd == L"only") out = focused(hwnd, arg(3), arg(4), true);
    else if (cmd == L"selected") out = selected(hwnd, arg(3), arg(4));
    else if (cmd == L"alive") out = IsWindow(hwnd) ? L"True" : L"False";
    reply(parts[0], out);
  }
  release(g_walker);
  release(g_uia);
  CoUninitialize();
  return 0;
}
