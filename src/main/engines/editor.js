// Presets for creative editors: the everyday conversions video, audio and
// design people reach for. Every one is zero-click with industry defaults.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('../util').lazy('sharp');
const { ext, base, outDir, outPath, uniquePath, uniqueDir, withTemp, ffmpeg, probe } = require('../util');
const media = require('./media');
const image = require('./image');

const PCM_48K = ['-c:a', 'pcm_s16le', '-ar', '48000'];

async function videoInfo(file) {
  const info = await probe(file);
  if (!info.hasVideo) throw new Error('This file has no video stream');
  return info;
}

// ----- video -------------------------------------------------------------------

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
const FPS_EXACT = { 23.976: '24000/1001', 29.97: '30000/1001', 59.94: '60000/1001' };

// Phone and screen recordings drift between frame rates; editors need a constant one.
function snapFps(fps) {
  if (!fps) return 30;
  return STANDARD_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best));
}

async function fixVfr(file, _o, progress) {
  const info = await videoInfo(file);
  const rate = FPS_EXACT[snapFps(info.fps)] || String(snapFps(info.fps));
  const out = outPath(file, 'mp4', '-cfr');
  const args = ['-i', file, '-vf', `fps=${rate},scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
  // Resample audio against its timestamps so it stays in sync with the new frame timing.
  if (info.hasAudio) args.push('-af', 'aresample=async=1:first_pts=0', '-ar', '48000', '-c:a', 'aac', '-b:a', '256k');
  args.push('-movflags', '+faststart', out);
  await ffmpeg(args, { onProgress: progress, duration: info.duration });
  return [out];
}

// ProRes profiles: 0 Proxy, 1 LT, 2 422, 3 HQ, 4 4444.
function proresArgs(profile) {
  return ['-c:v', 'prores_ks', '-profile:v', String(profile), '-vendor', 'apl0', '-pix_fmt', profile >= 4 ? 'yuva444p10le' : 'yuv422p10le'];
}

// Keep every audio track and the timecode so editing apps can relink and conform.
const KEEP_STREAMS = ['-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0'];

async function prores(file, _o, progress) {
  const info = await videoInfo(file);
  const out = outPath(file, 'mov', '-prores');
  await ffmpeg(['-i', file, ...KEEP_STREAMS, ...proresArgs(2), ...PCM_48K, out], { onProgress: progress, duration: info.duration });
  return [out];
}

async function dnxhr(file, _o, progress) {
  const info = await videoInfo(file);
  const out = outPath(file, 'mov', '-dnxhr');
  await ffmpeg(['-i', file, ...KEEP_STREAMS, '-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p', ...PCM_48K, out], { onProgress: progress, duration: info.duration });
  return [out];
}

// Half-resolution ProRes Proxy with the original file name, in a "Proxies"
// folder beside the source: the layout Premiere and Resolve relink against.
async function proxy(file, _o, progress) {
  const info = await videoInfo(file);
  const dir = path.join(outDir(file), 'Proxies');
  await fsp.mkdir(dir, { recursive: true });
  const out = uniquePath(path.join(dir, `${base(file)}.mov`));
  await ffmpeg(['-i', file, ...KEEP_STREAMS, '-vf', 'scale=-2:trunc(ih/4)*2', ...proresArgs(0), ...PCM_48K, out], { onProgress: progress, duration: info.duration });
  return [out];
}

// Repackage without re-encoding (OBS/MKV to MP4). If the codecs don't fit in
// MP4, re-encode only what has to change.
async function remux(file, _o, progress) {
  const info = await videoInfo(file);
  const out = outPath(file, 'mp4', '-remux');
  const head = ['-i', file, '-map', '0:v:0', '-map', '0:a?', '-movflags', '+faststart'];
  const attempts = [
    ['-c', 'copy'],
    ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k'],
    ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k'],
  ];
  let lastError;
  for (const codecs of attempts) {
    try {
      await ffmpeg([...head, ...codecs, out], { onProgress: progress, duration: info.duration });
      return [out];
    } catch (err) {
      lastError = err;
      await fsp.rm(out, { force: true });
    }
  }
  throw lastError;
}

// Fill a social frame: scale to cover, crop the center, 30 fps H.264.
async function socialFrame(file, width, height, suffix, progress) {
  const info = await videoInfo(file);
  const out = outPath(file, 'mp4', suffix);
  const args = ['-i', file, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  args.push('-movflags', '+faststart', out);
  await ffmpeg(args, { onProgress: progress, duration: info.duration });
  return [out];
}

const reels = (file, _o, progress) => socialFrame(file, 1080, 1920, '-9x16', progress);
const square = (file, _o, progress) => socialFrame(file, 1080, 1080, '-1x1', progress);

async function pngSequence(file, _o, progress) {
  const info = await videoInfo(file);
  const dir = uniqueDir(path.join(outDir(file), `${base(file)} frames`));
  await fsp.mkdir(dir, { recursive: true });
  await ffmpeg(['-i', file, path.join(dir, `${base(file)}_%05d.png`)], { onProgress: progress, duration: info.duration });
  return [dir];
}

// ----- audio -------------------------------------------------------------------

// The video-editing standard: 48 kHz, 24-bit PCM.
async function wav48(file, _o, progress) {
  const info = await probe(file);
  if (!info.hasAudio) throw new Error('This file has no audio');
  const out = outPath(file, 'wav', '-48k');
  await ffmpeg(['-i', file, '-vn', '-ar', '48000', '-c:a', 'pcm_s24le', out], { onProgress: progress, duration: info.duration });
  return [out];
}

async function mp3320(file, _o, progress) {
  const out = outPath(file, 'mp3', '-320k');
  await ffmpeg(['-i', file, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', out], { onProgress: progress });
  return [out];
}

// Two-pass EBU R128 loudness normalization to a target, e.g. -14 (Spotify,
// YouTube), -16 (Apple Podcasts) or -23 LUFS (broadcast).
async function loudness(file, target, progress) {
  const info = await probe(file);
  if (!info.hasAudio) throw new Error('This file has no audio');
  const spec = `I=${target}:TP=-1:LRA=11`;
  const report = await ffmpeg(['-i', file, '-vn', '-af', `loudnorm=${spec}:print_format=json`, '-f', 'null', '-'],
    { onProgress: (p) => progress?.(p / 2), duration: info.duration });
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(report);
  if (!json) throw new Error('Could not measure loudness');
  const m = JSON.parse(json[0]);
  // Measurements outside loudnorm's accepted ranges (silence reports -inf, for
  // example) make the second pass fail, so clamp them.
  const clamp = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : lo);
  const measured = `measured_I=${clamp(m.input_i, -99, 0)}:measured_TP=${clamp(m.input_tp, -99, 99)}`
    + `:measured_LRA=${clamp(m.input_lra, 0, 99)}:measured_thresh=${clamp(m.input_thresh, -99, 0)}:offset=${clamp(m.target_offset, -99, 99)}`;
  const out = outPath(file, media.sameExt(file), `${target}LUFS`);
  const encode = (filter) => {
    const args = ['-i', file, '-af', filter];
    if (info.hasVideo) {
      const audio = { webm: ['-c:a', 'libopus'], avi: ['-c:a', 'libmp3lame'], wmv: ['-c:a', 'wmav2'] }[ext(file)] || ['-c:a', 'aac', '-b:a', '256k'];
      args.push('-c:v', 'copy', ...audio);
    } else {
      args.push(...media.codecFor(file));
    }
    args.push('-y', out);
    return ffmpeg(args, { onProgress: (p) => progress?.(0.5 + p / 2), duration: info.duration });
  };
  // loudnorm works at 192 kHz internally, so resample back to 48 kHz.
  try {
    await encode(`loudnorm=${spec}:${measured}:linear=true,aresample=48000`);
  } catch (err) {
    // Some FFmpeg builds reject the measured (linear) mode; the one-pass mode still
    // reaches the target, just with gentle dynamic adjustment.
    console.warn(`Two-pass loudness failed, using one pass: ${err.message}`);
    await encode(`loudnorm=${spec},aresample=48000`);
  }
  return [out];
}

// ----- images --------------------------------------------------------------------

// Web-ready: at most 2048 px on the long edge, sRGB, metadata stripped.
async function webExport(file, format) {
  let img = (await image.load(file))
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb');
  img = format === 'webp' ? img.webp({ quality: 80, effort: 5 }) : img.flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true });
  const out = outPath(file, format, '-web');
  await img.toFile(out);
  return [out];
}

// icon.svg -> icon.png, icon@2x.png, icon@3x.png
async function svgScales(file) {
  const outs = [];
  for (const scale of [1, 2, 3]) {
    const out = uniquePath(path.join(outDir(file), `${base(file)}${scale > 1 ? `@${scale}x` : ''}.png`));
    await sharp(file, { density: 72 * scale }).png().toFile(out);
    outs.push(out);
  }
  return outs;
}

// Finds the numbered siblings of a frame: shot_0001.png -> shot_0001..shot_0240.
function sequenceFrames(file) {
  const m = /^(.*?)(\d+)$/.exec(base(file));
  if (!m) throw new Error('Image sequences are numbered files, like frame_0001.png');
  const prefix = m[1];
  const e = path.extname(file).toLowerCase();
  const dir = path.dirname(file);
  const frames = fs.readdirSync(dir)
    .filter((n) => path.extname(n).toLowerCase() === e && n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length, n.length - e.length)))
    .sort((a, b) => Number(a.slice(prefix.length, a.length - e.length)) - Number(b.slice(prefix.length, b.length - e.length)))
    .map((n) => path.join(dir, n));
  if (frames.length < 2) throw new Error('Only one frame found. Sequences need numbered files like frame_0001.png, frame_0002.png…');
  return { frames, name: prefix.replace(/[\s._-]+$/, '') || 'sequence' };
}

const SEQUENCE_FPS = 30;

async function sequenceToVideo(file, codec, progress) {
  const { frames, name } = sequenceFrames(file);
  const target = codec === 'prores' ? 'mov' : 'mp4';
  const out = uniquePath(path.join(outDir(file), `${name}.${target}`));
  await withTemp(async (dir) => {
    // A concat list keeps the frames' own order and tolerates gaps in numbering.
    const list = path.join(dir, 'frames.txt');
    const line = (f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const body = frames.map((f) => `${line(f)}\nduration ${1 / SEQUENCE_FPS}`).join('\n') + `\n${line(frames[frames.length - 1])}\n`;
    await fsp.writeFile(list, body);
    const video = codec === 'prores'
      ? proresArgs(4) // 4444 keeps the alpha channel for compositing
      : ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart'];
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-r', String(SEQUENCE_FPS), ...video, out],
      { onProgress: progress, duration: frames.length / SEQUENCE_FPS });
  });
  return [out];
}

module.exports = {
  fixVfr, prores, dnxhr, proxy, remux, reels, square, pngSequence,
  wav48, mp3320, loudness, webExport, svgScales, sequenceToVideo, snapFps,
};
