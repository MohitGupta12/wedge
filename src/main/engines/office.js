// Optional LibreOffice integration. When LibreOffice is installed it gives
// higher-fidelity Office conversions; everything still works without it.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { base, run, withTemp } = require('../util');

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ],
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  linux: ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice'],
};

let cached;
function find() {
  if (cached !== undefined) return cached;
  cached = (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p)) || null;
  return cached;
}

function available() {
  return !!find();
}

// Converts into `outDir`, returning the produced file path.
async function convert(file, target, outDir) {
  const soffice = find();
  if (!soffice) throw new Error('LibreOffice is not installed');
  // A private profile avoids clashing with a running LibreOffice instance.
  const profile = path.join(outDir, 'lo-profile');
  await run(soffice, [
    `-env:UserInstallation=file:///${profile.replace(/\\/g, '/').replace(/^\//, '')}`,
    '--headless', '--norestore', '--convert-to', target, '--outdir', outDir, file,
  ]);
  const produced = path.join(outDir, `${base(file)}.${target}`);
  if (!fs.existsSync(produced)) throw new Error('LibreOffice did not produce an output file');
  return produced;
}

async function convertTo(file, target, out) {
  return withTemp(async (dir) => {
    const produced = await convert(file, target, dir);
    await fsp.copyFile(produced, out);
    return out;
  });
}

module.exports = { available, convert, convertTo, find };
