// Builds Wedge's native Windows pieces with llvm-mingw (https://github.com/mstorsjo/llvm-mingw):
//   build/shell/WedgeShell.dll        the Windows 11 right-click menu handler
//   src/main/native/wedge-helper.exe  the shell helper the gesture asks about Explorer
// Point WEDGE_LLVM at llvm-mingw or keep it in %LOCALAPPDATA%\WedgeTools. The built
// files are checked in, so packaging Wedge does not need the compiler.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
function findLlvm() {
  if (process.env.WEDGE_LLVM) return process.env.WEDGE_LLVM;
  const tools = path.join(process.env.LOCALAPPDATA || '', 'WedgeTools');
  const dir = fs.existsSync(tools) && fs.readdirSync(tools).find((d) => d.startsWith('llvm-mingw'));
  if (!dir) throw new Error('llvm-mingw not found. Set WEDGE_LLVM to its folder.');
  return path.join(tools, dir);
}

const clang = path.join(findLlvm(), 'bin', 'x86_64-w64-mingw32-clang++.exe');
const common = ['-O2', '-s', '-std=c++17', '-D_WIN32_WINNT=0x0A00', '-static', '-static-libgcc', '-static-libstdc++', '-DUNICODE', '-D_UNICODE'];

function build(out, args) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(clang, [...common, ...args, '-o', out], { stdio: 'inherit' });
  console.log(`Built ${path.relative(ROOT, out)} (${fs.statSync(out).size} bytes)`);
}

build(path.join(ROOT, 'build', 'shell', 'WedgeShell.dll'), [
  '-shared', path.join(ROOT, 'src', 'shell', 'wedge-shell.cpp'), path.join(ROOT, 'src', 'shell', 'wedge-shell.def'),
  '-lole32', '-lshlwapi', '-luuid', '-ladvapi32', '-lshell32',
]);
// A console program without a console window: Wedge talks to it over pipes.
build(path.join(ROOT, 'src', 'main', 'native', 'wedge-helper.exe'), [
  path.join(ROOT, 'src', 'shell', 'wedge-helper.cpp'), '-mconsole',
  '-lole32', '-loleaut32', '-luuid', '-lshell32', '-lshlwapi', '-luser32',
]);
