// Wedge's entries in the Windows 11 right-click menu.
//
// Windows 11 only lists IExplorerCommand handlers from packaged apps in its compact
// menu, so this DLL is registered through a sparse package (see src/main/shellmenu.js).
// Packaged code gets its own view of HKCU and AppData, so the app shares settings
// through a small UTF-8 file in places the package sees as they are: next to this DLL,
// or else %TEMP%\Wedge\shell-menu.cfg. One key=value per line:
//   command=how to start Wedge, e.g. "C:\...\Wedge.exe"
//   icon=icon for the entries
//   convert=1 shows "Convert with Wedge"
//   editExts=extensions that show "Edit with Wedge", e.g. ;.jpg;.png;.pdf;
//   debug=1 logs calls to %TEMP%\Wedge\shell-menu.log
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <map>
#include <new>
#include <string>

static HMODULE g_module = nullptr;
static LONG g_refs = 0;

// {7E2A4C61-3B5D-4F0E-9A51-2C8D7B6E1F01} and ...02
static const CLSID CLSID_Convert = { 0x7e2a4c61, 0x3b5d, 0x4f0e, { 0x9a, 0x51, 0x2c, 0x8d, 0x7b, 0x6e, 0x1f, 0x01 } };
static const CLSID CLSID_Edit = { 0x7e2a4c61, 0x3b5d, 0x4f0e, { 0x9a, 0x51, 0x2c, 0x8d, 0x7b, 0x6e, 0x1f, 0x02 } };

static std::wstring dllFolder() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(g_module, path, MAX_PATH);
  if (!n || n == MAX_PATH) return L"";
  PathRemoveFileSpecW(path);
  return std::wstring(path) + L"\\";
}

static std::wstring tempFolder() {
  wchar_t path[MAX_PATH];
  if (!GetTempPathW(MAX_PATH, path)) return L"";
  return std::wstring(path) + L"Wedge\\";
}

static HANDLE openConfig() {
  for (const std::wstring &dir : { dllFolder(), tempFolder() }) {
    if (dir.empty()) continue;
    HANDLE f = CreateFileW((dir + L"shell-menu.cfg").c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (f != INVALID_HANDLE_VALUE) return f;
  }
  return INVALID_HANDLE_VALUE;
}

// Re-read on every call: it is tiny, and the app may change it at any time.
static std::map<std::wstring, std::wstring> config() {
  std::map<std::wstring, std::wstring> values;
  HANDLE f = openConfig();
  if (f == INVALID_HANDLE_VALUE) return values;
  char buf[16384];
  DWORD read = 0;
  BOOL ok = ReadFile(f, buf, sizeof(buf) - 1, &read, nullptr);
  CloseHandle(f);
  if (!ok || !read) return values;
  int len = MultiByteToWideChar(CP_UTF8, 0, buf, (int)read, nullptr, 0);
  std::wstring text(len, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, buf, (int)read, &text[0], len);
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find(L'\n', start);
    if (end == std::wstring::npos) end = text.size();
    std::wstring line = text.substr(start, end - start);
    if (!line.empty() && line.back() == L'\r') line.pop_back();
    size_t eq = line.find(L'=');
    if (eq != std::wstring::npos) values[line.substr(0, eq)] = line.substr(eq + 1);
    start = end + 1;
  }
  return values;
}

static std::wstring readString(const wchar_t *name) {
  auto values = config();
  auto it = values.find(name);
  return it == values.end() ? L"" : it->second;
}

static DWORD readDword(const wchar_t *name) {
  return (DWORD)_wtoi(readString(name).c_str());
}

static void trace(const char *what) {
  if (!readDword(L"debug")) return;
  HANDLE f = CreateFileW((tempFolder() + L"shell-menu.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  char line[256];
  int n = wsprintfA(line, "%lu pid=%lu %s\r\n", GetTickCount(), GetCurrentProcessId(), what);
  DWORD written;
  WriteFile(f, line, n, &written, nullptr);
  CloseHandle(f);
}

static HRESULT dupString(const std::wstring &s, LPWSTR *out) {
  return SHStrDupW(s.c_str(), out);
}

// The pressed item's file system path, or empty for virtual items.
static std::wstring firstPath(IShellItemArray *items, DWORD *count) {
  *count = 0;
  if (!items || FAILED(items->GetCount(count)) || !*count) return L"";
  IShellItem *item = nullptr;
  if (FAILED(items->GetItemAt(0, &item))) return L"";
  LPWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
    result = path;
    CoTaskMemFree(path);
  }
  item->Release();
  return result;
}

static std::wstring lowerExt(const std::wstring &path) {
  const wchar_t *ext = PathFindExtensionW(path.c_str());
  std::wstring e = ext ? ext : L"";
  for (auto &c : e) c = (wchar_t)towlower(c);
  return e;
}

static bool editable(IShellItemArray *items) {
  DWORD count = 0;
  std::wstring path = firstPath(items, &count);
  if (count != 1 || path.empty()) return false;
  std::wstring ext = lowerExt(path);
  return !ext.empty() && readString(L"editExts").find(L";" + ext + L";") != std::wstring::npos;
}

// Windows shows one entry per package. Root is that entry: "Convert with Wedge" for most
// files, or a "Wedge" submenu holding Convert and Edit when an editor can open the file.
enum class Kind { Root, Convert, Edit };

class Command;

class SubCommands : public IEnumExplorerCommand {
 public:
  SubCommands() { InterlockedIncrement(&g_refs); }
  ~SubCommands();
  IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == IID_IEnumExplorerCommand) {
      *ppv = static_cast<IEnumExplorerCommand *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs_);
    if (!r) delete this;
    return r;
  }
  IFACEMETHODIMP Next(ULONG count, IExplorerCommand **out, ULONG *fetched) override;
  IFACEMETHODIMP Skip(ULONG count) override {
    next_ += count;
    return next_ <= 2 ? S_OK : S_FALSE;
  }
  IFACEMETHODIMP Reset() override {
    next_ = 0;
    return S_OK;
  }
  IFACEMETHODIMP Clone(IEnumExplorerCommand **out) override {
    *out = nullptr;
    return E_NOTIMPL;
  }

 private:
  ULONG next_ = 0;
  LONG refs_ = 1;
};

class Command : public IExplorerCommand {
 public:
  explicit Command(Kind kind) : kind_(kind) { InterlockedIncrement(&g_refs); }
  ~Command() { InterlockedDecrement(&g_refs); }

  IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
      *ppv = static_cast<IExplorerCommand *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs_);
    if (!r) delete this;
    return r;
  }

  IFACEMETHODIMP GetTitle(IShellItemArray *items, LPWSTR *name) override {
    trace("GetTitle");
    if (kind_ == Kind::Root) return dupString(editable(items) ? L"Wedge" : L"Convert with Wedge", name);
    return dupString(kind_ == Kind::Edit ? L"Edit with Wedge" : L"Convert with Wedge", name);
  }
  IFACEMETHODIMP GetIcon(IShellItemArray *, LPWSTR *icon) override {
    std::wstring i = readString(L"icon");
    if (i.empty()) return E_NOTIMPL;
    return dupString(i, icon);
  }
  IFACEMETHODIMP GetToolTip(IShellItemArray *, LPWSTR *tip) override {
    *tip = nullptr;
    return E_NOTIMPL;
  }
  IFACEMETHODIMP GetCanonicalName(GUID *guid) override {
    *guid = kind_ == Kind::Edit ? CLSID_Edit : CLSID_Convert;
    return S_OK;
  }
  IFACEMETHODIMP GetState(IShellItemArray *items, BOOL, EXPCMDSTATE *state) override {
    *state = ECS_HIDDEN;
    trace("GetState");
    if (readString(L"command").empty()) return S_OK;
    bool convert = readDword(L"convert") != 0;
    bool edit = editable(items);
    if (kind_ == Kind::Root) {
      // Remembered for GetFlags, which Windows asks without the items.
      sub_ = convert && edit;
      if (convert || edit) *state = ECS_ENABLED;
    } else if (kind_ == Kind::Convert ? convert : edit) {
      *state = ECS_ENABLED;
    }
    return S_OK;
  }
  IFACEMETHODIMP Invoke(IShellItemArray *items, IBindCtx *) override {
    DWORD count = 0;
    std::wstring path = firstPath(items, &count);
    std::wstring command = readString(L"command");
    if (path.empty() || command.empty()) return E_FAIL;
    bool edit = kind_ == Kind::Edit || (kind_ == Kind::Root && !readDword(L"convert"));
    std::wstring line = command + (edit ? L" --edit \"" : L" --wheel \"") + path + L"\"";
    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};
    // Let Wedge's window take focus when it opens.
    AllowSetForegroundWindow(ASFW_ANY);
    if (!CreateProcessW(nullptr, &line[0], nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
      return HRESULT_FROM_WIN32(GetLastError());
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return S_OK;
  }
  IFACEMETHODIMP GetFlags(EXPCMDFLAGS *flags) override {
    *flags = kind_ == Kind::Root && sub_ ? ECF_HASSUBCOMMANDS : ECF_DEFAULT;
    return S_OK;
  }
  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand **out) override {
    *out = nullptr;
    if (kind_ != Kind::Root) return E_NOTIMPL;
    *out = new (std::nothrow) SubCommands();
    return *out ? S_OK : E_OUTOFMEMORY;
  }

 private:
  Kind kind_;
  bool sub_ = false;
  LONG refs_ = 1;
};

SubCommands::~SubCommands() { InterlockedDecrement(&g_refs); }

IFACEMETHODIMP SubCommands::Next(ULONG count, IExplorerCommand **out, ULONG *fetched) {
  ULONG n = 0;
  while (n < count && next_ < 2) {
    out[n] = new (std::nothrow) Command(next_ == 0 ? Kind::Convert : Kind::Edit);
    if (!out[n]) break;
    n++;
    next_++;
  }
  if (fetched) *fetched = n;
  return n == count ? S_OK : S_FALSE;
}

class Factory : public IClassFactory {
 public:
  explicit Factory(bool edit) : edit_(edit) {}
  IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) override {
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory *>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs_);
    if (!r) delete this;
    return r;
  }
  IFACEMETHODIMP CreateInstance(IUnknown *outer, REFIID riid, void **ppv) override {
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    Command *cmd = new (std::nothrow) Command(edit_ ? Kind::Edit : Kind::Root);
    if (!cmd) return E_OUTOFMEMORY;
    HRESULT hr = cmd->QueryInterface(riid, ppv);
    cmd->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock) InterlockedIncrement(&g_refs);
    else InterlockedDecrement(&g_refs);
    return S_OK;
  }

 private:
  bool edit_;
  LONG refs_ = 1;
};

extern "C" BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}

extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid, REFIID riid, void **ppv) {
  *ppv = nullptr;
  trace("DllGetClassObject");
  bool edit;
  if (clsid == CLSID_Convert) edit = false;
  else if (clsid == CLSID_Edit) edit = true;
  else return CLASS_E_CLASSNOTAVAILABLE;
  Factory *f = new (std::nothrow) Factory(edit);
  if (!f) return E_OUTOFMEMORY;
  HRESULT hr = f->QueryInterface(riid, ppv);
  f->Release();
  return hr;
}

extern "C" HRESULT __stdcall DllCanUnloadNow() {
  return g_refs == 0 ? S_OK : S_FALSE;
}
