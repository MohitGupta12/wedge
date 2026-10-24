// Wedge in the Windows 11 right-click menu (the compact one, not "Show more options").
//
// Windows 11 only lists IExplorerCommand handlers that belong to a packaged app. Wedge
// stays a normal app and registers a tiny "sparse" package: it holds only a manifest
// and logos, and points at WedgeShell.dll next to Wedge. The package is unsigned, which
// Windows 11 allows for a publisher with the special OID below, but then it has to be
// installed for all users, so registering asks for admin approval once.
// What the entries show, and how they start Wedge, lives in shell-menu.cfg (below);
// HKCU\Software\Wedge\Shell only remembers what was registered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { app } = require('electron');
const { run } = require('./util');

const SHELL_KEY = 'HKCU\\Software\\Wedge\\Shell';
const PACKAGE_NAME = 'Wedge.ShellMenu';
const PUBLISHER = 'CN=Wedge, OID.2.25.311729368913984317654407730594956997722=1';
const CLSID_CONVERT = '7E2A4C61-3B5D-4F0E-9A51-2C8D7B6E1F01';
const CLSID_EDIT = '7E2A4C61-3B5D-4F0E-9A51-2C8D7B6E1F02';

const reg = (...args) => run('reg.exe', args);
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The compact menu arrived in Windows 11 (build 22000).
function supported() {
  return process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;
}

// Where the package points: the folder with the exe, the exe and the DLL inside it.
function layout() {
  if (app.isPackaged) {
    const root = path.dirname(process.execPath);
    return { root, exe: path.basename(process.execPath), dll: path.join('resources', 'shell', 'WedgeShell.dll') };
  }
  const root = path.join(__dirname, '..', '..');
  return { root, exe: path.relative(root, process.execPath), dll: path.join('build', 'shell', 'WedgeShell.dll') };
}

function launchCommand() {
  return app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
}

function iconFile() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : path.join(__dirname, '..', '..');
  const ico = path.join(root, 'build', 'icon.ico');
  return fs.existsSync(ico) ? ico : `${process.execPath},0`;
}

function manifest({ exe, dll }) {
  // One verb: Windows groups several from one package into a submenu without an icon.
  // The handler itself adds a Convert/Edit submenu when an editor can open the file.
  const verbs = `<desktop5:Verb Id="Wedge" Clsid="${CLSID_CONVERT}"/>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop4="http://schemas.microsoft.com/appx/manifest/desktop/windows10/4"
  xmlns:desktop5="http://schemas.microsoft.com/appx/manifest/desktop/windows10/5"
  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 desktop4 desktop5 desktop6 com rescap">
  <Identity Name="${PACKAGE_NAME}" Publisher="${PUBLISHER}" Version="1.0.0.0" ProcessorArchitecture="neutral"/>
  <Properties>
    <DisplayName>Wedge</DisplayName>
    <PublisherDisplayName>Wedge</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
    <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
  </Properties>
  <Resources><Resource Language="en-us"/></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.22000.0" MaxVersionTested="10.0.26100.0"/>
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
    <rescap:Capability Name="unvirtualizedResources"/>
  </Capabilities>
  <Applications>
    <Application Id="Wedge" Executable="${exe}" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <uap:VisualElements AppListEntry="none" DisplayName="Wedge" Description="Wedge" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png"/>
      <Extensions>
        <desktop4:Extension Category="windows.fileExplorerContextMenus">
          <desktop4:FileExplorerContextMenus>
            <desktop5:ItemType Type="*">${verbs}</desktop5:ItemType>
            <desktop5:ItemType Type="Directory">${verbs}</desktop5:ItemType>
          </desktop4:FileExplorerContextMenus>
        </desktop4:Extension>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="Wedge right-click menu">
              <com:Class Id="${CLSID_CONVERT}" Path="${dll}" ThreadingModel="STA"/>
              <com:Class Id="${CLSID_EDIT}" Path="${dll}" ThreadingModel="STA"/>
            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

// ----- a minimal MSIX writer: stored zip entries, a block map and content types -----

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // no flags, no data descriptor
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00, the earliest valid DOS date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0x00210000, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function msix(files) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('base64');
  const blocks = files.map(({ name, data }) => {
    const parts = [];
    for (let i = 0; i < Math.max(1, data.length); i += 65536) parts.push(`<Block Hash="${sha(data.subarray(i, i + 65536))}"/>`);
    return `<File Name="${name}" Size="${data.length}" LfhSize="${30 + Buffer.byteLength(name.replace(/\\/g, '/'))}">${parts.join('')}</File>`;
  });
  const blockMap = `<?xml version="1.0" encoding="UTF-8"?><BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">${blocks.join('')}</BlockMap>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml"/>'
    + '<Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml"/></Types>';
  return zip([...files, { name: 'AppxBlockMap.xml', data: Buffer.from(blockMap) }, { name: '[Content_Types].xml', data: Buffer.from(types) }]);
}

async function logos() {
  const sharp = require('sharp');
  const src = path.join(path.dirname(iconFile()), 'icon.png');
  const make = (size) => sharp(src).resize(size, size).png().toBuffer();
  return [
    { name: 'Assets\\Square44x44Logo.png', data: await make(44) },
    { name: 'Assets\\Square150x150Logo.png', data: await make(150) },
    { name: 'Assets\\StoreLogo.png', data: await make(50) },
  ];
}

// ----- registration -----------------------------------------------------------------

async function registeredHash() {
  try {
    const out = await reg('query', SHELL_KEY, '/v', 'PackageHash');
    return /PackageHash\s+REG_SZ\s+(\S+)/.exec(out)?.[1] || null;
  } catch {
    return null;
  }
}

async function isRegistered() {
  const out = await ps(`(Get-AppxPackage -Name ${PACKAGE_NAME}) -ne $null`).catch(() => 'False');
  return out.trim() === 'True';
}

async function readValue(name) {
  try {
    const out = await reg('query', SHELL_KEY, '/v', name);
    return new RegExp(`${name}\\s+REG_SZ\\s+(\\S+)`).exec(out)?.[1] || null;
  } catch {
    return null;
  }
}

// An unsigned package that starts code must be installed for all users, so this asks
// for one admin approval (UAC). It runs once, and again only if Wedge moves or the
// manifest changes. If the prompt is declined it is not shown again on its own;
// turning the right-click menu off and on in Settings asks again (force).
async function ensurePackage(force) {
  const where = layout();
  if (!fs.existsSync(path.join(where.root, where.dll))) throw new Error(`Missing ${where.dll}`);
  const xml = manifest(where);
  const hash = crypto.createHash('sha256').update(xml).update(where.root).digest('hex').slice(0, 16);
  if (hash === (await registeredHash()) && (await isRegistered())) return false;
  if (!force && hash === (await readValue('PackageDeclined'))) return false;
  // Windows' deployment service can't open packages from the app's Roaming folder; Temp works.
  const dir = path.join(app.getPath('temp'), 'Wedge');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Wedge-menu.msix');
  const log = path.join(dir, 'Wedge-menu.log');
  const script = path.join(dir, 'Wedge-menu.ps1');
  fs.writeFileSync(file, msix([{ name: 'AppxManifest.xml', data: Buffer.from(xml) }, ...(await logos())]));
  fs.rmSync(log, { force: true });
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'
try {
  Get-AppxPackage -AllUsers -Name ${PACKAGE_NAME} | Remove-AppxPackage -AllUsers
  Add-AppxPackage -Path ${psQuote(file)} -ExternalLocation ${psQuote(where.root)} -AllowUnsigned
  'ok' | Out-File -Encoding ascii ${psQuote(log)}
} catch { $_.Exception.Message | Out-File -Encoding ascii ${psQuote(log)} }
`);
  try {
    await ps(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${script}"`)}`);
  } catch (err) {
    await reg('add', SHELL_KEY, '/v', 'PackageDeclined', '/d', hash, '/f');
    throw new Error(`Admin approval was declined (${err.message.split('\n')[0]})`);
  }
  const result = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : 'no result';
  if (result !== 'ok') throw new Error(result);
  await reg('add', SHELL_KEY, '/v', 'PackageHash', '/d', hash, '/f');
  await reg('delete', SHELL_KEY, '/v', 'PackageDeclined', '/f').catch(() => {});
  return true;
}

// The handler runs inside the package, which has its own view of HKCU and AppData, so
// its settings go in a file where it reads them: next to the DLL, or %TEMP%\Wedge when
// Wedge's folder isn't writable (see src/shell/wedge-shell.cpp).
function configFiles() {
  const where = layout();
  return [path.join(where.root, path.dirname(where.dll), 'shell-menu.cfg'), path.join(app.getPath('temp'), 'Wedge', 'shell-menu.cfg')];
}

function writeConfig(values) {
  const text = `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\r\n')}\r\n`;
  let written = 0;
  for (const file of configFiles()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      written++;
    } catch {
      // Not writable (an all-users install); the other location covers it.
    }
  }
  if (!written) throw new Error('Could not save the right-click menu settings');
}

// convert: show "Convert with Wedge"; editExts: extensions that show "Edit with Wedge".
async function apply(enabled, { convert = true, editExts = [], force = false } = {}) {
  if (!supported()) return false;
  try {
    writeConfig({
      command: launchCommand(),
      icon: iconFile(),
      convert: enabled && convert ? 1 : 0,
      editExts: enabled ? `;${editExts.map((e) => `.${e.toLowerCase()}`).join(';')};` : ';',
    });
    // Development runs keep the installed app's package (re-pointing it costs a UAC
    // prompt each way); set WEDGE_SHELL_MENU=1 to register the dev copy instead.
    if (enabled && (app.isPackaged || process.env.WEDGE_SHELL_MENU)) await ensurePackage(force);
    return true;
  } catch (err) {
    console.error('Windows 11 menu update failed:', err.message);
    return false;
  }
}

async function remove() {
  if (!supported()) return;
  // Removing an all-users package also needs admin approval.
  await ps(`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Get-AppxPackage -AllUsers -Name ${PACKAGE_NAME} | Remove-AppxPackage -AllUsers'`).catch(() => {});
  await reg('delete', SHELL_KEY, '/f').catch(() => {});
  for (const file of configFiles()) fs.rmSync(file, { force: true });
}

module.exports = { apply, remove, supported, msix, manifest };
