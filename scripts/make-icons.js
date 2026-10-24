// Renders Wedge's icons from SVG. electron-builder derives the .icns from
// build/icon.png; Windows uses the .ico files written here.
//
// The mark: a pie with one wedge pulled out. Green while Wedge is running,
// red while it's paused (tray icons only).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });

const THEMES = {
  running: ['#3ddc97', '#12b76a', '#0a8f51'],
  paused: ['#ff8a80', '#e5484d', '#b42318'],
};

// A pie of radius r at (cx, cy) with the slice between a0..a1 (degrees,
// clockwise from 3 o'clock) cut out and pushed `pop` units along its bisector.
function pie(cx, cy, r, a0, a1, pop) {
  const rad = (d) => (d * Math.PI) / 180;
  const pt = (x, y, a) => `${(x + r * Math.cos(rad(a))).toFixed(2)},${(y + r * Math.sin(rad(a))).toFixed(2)}`;
  const body = `M${cx},${cy} L${pt(cx, cy, a1)} A${r},${r} 0 1 1 ${pt(cx, cy, a0)} Z`;
  const mid = rad((a0 + a1) / 2);
  const sx = cx + pop * Math.cos(mid);
  const sy = cy + pop * Math.sin(mid);
  const slice = `M${sx.toFixed(2)},${sy.toFixed(2)} L${pt(sx, sy, a0)} A${r},${r} 0 0 1 ${pt(sx, sy, a1)} Z`;
  return { body, slice };
}

function mark(size, { theme = 'running', mono = false, tile = true } = {}) {
  const s = size / 100;
  const [hi, mid, lo] = THEMES[theme];
  // The pie sits a little low-left so the pulled slice stays centred overall.
  const { body, slice } = pie((tile ? 47 : 46) * s, (tile ? 53 : 54) * s, (tile ? 29 : 38) * s, -90, -30, (tile ? 7 : 8) * s);
  const corner = (tile ? 3 : 4) * s;
  const ink = mono ? '#000' : '#ffffff';
  const shapes = `
    <path d="${body}" fill="${ink}" stroke="${ink}" stroke-width="${corner}" stroke-linejoin="round" opacity="${mono ? 0.55 : 0.92}"/>
    <path d="${slice}" fill="${ink}" stroke="${ink}" stroke-width="${corner}" stroke-linejoin="round"/>`;
  if (!tile) return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shapes}</svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${hi}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/>
      </linearGradient>
      <radialGradient id="shine" cx="28%" cy="15%" r="75%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.3"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="${4 * s}" y="${4 * s}" width="${92 * s}" height="${92 * s}" rx="${23 * s}" fill="url(#bg)"/>
    <rect x="${4 * s}" y="${4 * s}" width="${92 * s}" height="${92 * s}" rx="${23 * s}" fill="url(#shine)"/>
    ${shapes}
  </svg>`;
}

// A Windows .ico holding PNG images at several sizes (Vista+ format).
async function writeIco(file, sizes, svgFor) {
  const images = [];
  for (const size of sizes) images.push({ size, data: await sharp(Buffer.from(svgFor(size))).resize(size, size).png().toBuffer() });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...images.map((im) => im.data)]));
}

const png = (svg, file, resize) => {
  let img = sharp(Buffer.from(svg));
  if (resize) img = img.resize(resize, resize);
  return img.png().toFile(path.join(out, file));
};

(async () => {
  const hiRes = (theme) => (size) => mark(Math.max(size * 2, 64), { theme });
  await writeIco(path.join(out, 'icon.ico'), [16, 20, 24, 32, 40, 48, 64, 128, 256], hiRes('running'));
  await png(mark(1024), 'icon.png');
  for (const theme of ['running', 'paused']) {
    const suffix = theme === 'paused' ? '-paused' : '';
    await writeIco(path.join(out, `tray${suffix}.ico`), [16, 20, 24, 32, 48], hiRes(theme));
    await png(mark(64, { theme }), `tray${suffix}.png`, 32);
    await png(mark(64, { theme }), `tray${suffix}@2x.png`);
  }
  // macOS menu bar template images are monochrome; paused is drawn fainter.
  await png(mark(44, { mono: true, tile: false }), 'trayTemplate.png', 22);
  await png(mark(44, { mono: true, tile: false }), 'trayTemplate@2x.png');
  console.log('Icons written to', out);
})();
