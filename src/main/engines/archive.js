// Archives: extract ZIP/TAR/GZ/RAR, create ZIP/TAR/TAR.GZ, and repack between them.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { lazy, base, outDir, uniquePath, uniqueDir, withTemp } = require('../util');

const AdmZip = lazy('adm-zip');
const tar = lazy('tar');

// "photo.tar.gz" -> { stem: "photo", kind: "tar.gz" }
function archiveKind(file) {
  const name = path.basename(file).toLowerCase();
  for (const k of ['tar.gz', 'tgz', 'tar', 'zip', 'gz', 'rar']) {
    if (name.endsWith(`.${k}`)) return { kind: k === 'tgz' ? 'tar.gz' : k, stem: path.basename(file).slice(0, -(k.length + 1)) };
  }
  return null;
}

async function extractTo(file, dest) {
  const { kind, stem } = archiveKind(file) || {};
  await fsp.mkdir(dest, { recursive: true });
  if (kind === 'zip') new AdmZip(file).extractAllTo(dest, true);
  else if (kind === 'tar' || kind === 'tar.gz') await tar.x({ file, cwd: dest });
  else if (kind === 'gz') await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(path.join(dest, stem)));
  else if (kind === 'rar') {
    const { createExtractorFromFile } = require('node-unrar-js');
    const extractor = await createExtractorFromFile({ filepath: file, targetPath: dest });
    [...extractor.extract().files]; // iterating drives the extraction
  } else throw new Error('Unsupported archive');
  return dest;
}

async function extract(file) {
  const { stem, kind } = archiveKind(file);
  if (kind === 'gz') {
    // A plain .gz holds one file, so put it beside the archive.
    const out = uniquePath(path.join(outDir(file), stem));
    await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(out));
    return [out];
  }
  const dest = uniqueDir(path.join(outDir(file), stem));
  return [await extractTo(file, dest)];
}

async function pack(entries, target, out) {
  if (target === 'zip') {
    const zip = new AdmZip();
    for (const e of entries) {
      if ((await fsp.stat(e)).isDirectory()) zip.addLocalFolder(e, path.basename(e));
      else zip.addLocalFile(e);
    }
    await zip.writeZipPromise(out);
  } else {
    // tar paths are relative to a shared parent; group entries by directory.
    const cwd = path.dirname(entries[0]);
    const sameDir = entries.every((e) => path.dirname(e) === cwd);
    if (!sameDir) throw new Error('TAR needs files from the same folder');
    await tar.c({ gzip: target === 'tar.gz', file: out, cwd, portable: true }, entries.map((e) => path.basename(e)));
  }
  return out;
}

async function nameFor(entries) {
  if (entries.length > 1) return 'Archive';
  const isDir = (await fsp.stat(entries[0])).isDirectory();
  return isDir ? path.basename(entries[0]) : base(entries[0]);
}

async function compress(entries, target) {
  const out = uniquePath(path.join(outDir(entries[0]), `${await nameFor(entries)}.${target}`));
  return [await pack(entries, target, out)];
}

async function gzipFile(file) {
  const out = uniquePath(path.join(outDir(file), `${path.basename(file)}.gz`));
  await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
  return [out];
}

async function repack(file, target) {
  const { stem } = archiveKind(file);
  return withTemp(async (dir) => {
    const src = path.join(dir, 'x');
    await extractTo(file, src);
    const entries = (await fsp.readdir(src)).map((e) => path.join(src, e));
    if (!entries.length) throw new Error('The archive is empty');
    const out = uniquePath(path.join(outDir(file), `${stem}.${target}`));
    await pack(entries, target, out);
    return [out];
  });
}

module.exports = { archiveKind, extract, compress, gzipFile, repack };
