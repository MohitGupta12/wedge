// Video and audio conversion and tools via the bundled FFmpeg.
const fsp = require('fs/promises');
const path = require('path');
const { ext, base, outDir, outPath, uniqueDir, ffmpeg, probe, parseTime, withTemp } = require('../util');

const VIDEO_ARGS = {
  mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  mov: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'],
  mkv: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-c:a', 'aac', '-b:a', '160k'],
  m4v: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '128k'],
  avi: ['-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-q:a', '3'],
  wmv: ['-c:v', 'wmv2', '-b:v', '3M', '-c:a', 'wmav2', '-b:a', '192k'],
};

const AUDIO_ARGS = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  aac: ['-c:a', 'aac', '-b:a', '192k'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-c:a', 'pcm_s16be'],
  wma: ['-c:a', 'wmav2', '-b:a', '192k'],
};

const GIF_FILTER = 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';

function isVideoTarget(t) {
  return t in VIDEO_ARGS || t === 'gif';
}

async function convert(file, target, _settings, progress) {
  const out = outPath(file, target);
  const info = await probe(file);
  let args;
  if (target === 'gif') args = ['-i', file, '-filter_complex', GIF_FILTER, '-loop', '0', out];
  else if (isVideoTarget(target)) {
    if (!info.hasVideo) throw new Error('This file has no video stream');
    // libx264 needs even dimensions.
    const vf = ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
    args = ['-i', file, ...vf, ...VIDEO_ARGS[target], out];
  } else if (target in AUDIO_ARGS) {
    if (!info.hasAudio) throw new Error('This file has no audio stream');
    args = ['-i', file, '-vn', '-map_metadata', '0', ...AUDIO_ARGS[target], out];
  } else throw new Error(`Unsupported target ${target}`);
  await ffmpeg(args, { onProgress: progress, duration: info.duration });
  return [out];
}

function codecFor(file) {
  const e = ext(file);
  if (e in VIDEO_ARGS) return VIDEO_ARGS[e];
  if (e in AUDIO_ARGS) return AUDIO_ARGS[e];
  if (e === 'gif') return [];
  return VIDEO_ARGS.mp4;
}

function sameExt(file) {
  const e = ext(file);
  return e in VIDEO_ARGS || e in AUDIO_ARGS || e === 'gif' ? e : 'mp4';
}

async function trim(file, opts, progress) {
  const start = parseTime(opts.start) || 0;
  const end = parseTime(opts.end);
  const out = outPath(file, sameExt(file), '-trimmed');
  const args = ['-ss', String(start), '-i', file];
  if (end) {
    if (end <= start) throw new Error('End must be after start');
    args.push('-t', String(end - start));
  }
  if (opts.precise === 'no') args.push('-c', 'copy', out);
  else args.push(...codecFor(file), out);
  await ffmpeg(args, { onProgress: progress, duration: end ? end - start : 0 });
  return [out];
}

const QUALITY_CRF = { high: 23, balanced: 28, small: 33 };

async function compressVideo(file, opts, progress) {
  const crf = String(QUALITY_CRF[opts.quality] || 28);
  const height = Number(opts.height) || 0;
  const scale = height ? `scale=-2:'min(${height},ih)'` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const out = outPath(file, 'mp4', '-compressed');
  await ffmpeg(['-i', file, '-vf', scale, '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { onProgress: progress });
  return [out];
}

async function resizeVideo(file, opts, progress) {
  const h = Number(opts.height) || 720;
  const out = outPath(file, sameExt(file) === 'gif' ? 'gif' : 'mp4', `-${h}p`);
  await ffmpeg(['-i', file, '-vf', `scale=-2:${h}`, ...(out.endsWith('.gif') ? [] : VIDEO_ARGS.mp4), out], { onProgress: progress });
  return [out];
}

async function mute(file, _opts, progress) {
  const out = outPath(file, sameExt(file), '-muted');
  await ffmpeg(['-i', file, '-c:v', 'copy', '-an', out], { onProgress: progress });
  return [out];
}

async function frame(file, opts) {
  const t = parseTime(opts.time) || 0;
  const out = outPath(file, opts.format || 'png', `-frame-${String(t).replace('.', '_')}s`);
  await ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', out]);
  return [out];
}

async function rotateVideo(file, opts, progress) {
  const filters = { '90': 'transpose=1', '180': 'transpose=1,transpose=1', '270': 'transpose=2', hflip: 'hflip', vflip: 'vflip' };
  const out = outPath(file, sameExt(file), '-rotated');
  await ffmpeg(['-i', file, '-vf', filters[opts.angle] || filters['90'], ...codecFor(file), out], { onProgress: progress });
  return [out];
}

async function speed(file, opts, progress) {
  const f = Number(opts.factor) || 2;
  const info = await probe(file);
  const out = outPath(file, sameExt(file), `-${f}x`);
  // atempo accepts 0.5..2, so chain it for larger factors.
  const tempo = [];
  let r = f;
  while (r > 2) { tempo.push('atempo=2'); r /= 2; }
  while (r < 0.5) { tempo.push('atempo=0.5'); r /= 0.5; }
  tempo.push(`atempo=${r}`);
  const args = ['-i', file];
  if (info.hasVideo) args.push('-filter:v', `setpts=${1 / f}*PTS`);
  if (info.hasAudio) args.push('-filter:a', tempo.join(','));
  args.push(...codecFor(file), out);
  await ffmpeg(args, { onProgress: progress, duration: info.duration / f });
  return [out];
}

async function merge(files, _opts, progress) {
  const infos = await Promise.all(files.map(probe));
  const video = infos.every((i) => i.hasVideo);
  const audio = infos.every((i) => i.hasAudio);
  const total = infos.reduce((a, i) => a + i.duration, 0);
  const args = [];
  for (const f of files) args.push('-i', f);
  const parts = [];
  let filter = '';
  if (video) {
    const W = infos[0].width - (infos[0].width % 2);
    const H = infos[0].height - (infos[0].height % 2);
    infos.forEach((_, i) => {
      filter += `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];`;
    });
  }
  infos.forEach((_, i) => {
    if (video) parts.push(`[v${i}]`);
    if (audio) parts.push(`[${i}:a]`);
  });
  filter += `${parts.join('')}concat=n=${files.length}:v=${video ? 1 : 0}:a=${audio ? 1 : 0}`;
  filter += video ? (audio ? '[v][a]' : '[v]') : '[a]';
  const target = video ? 'mp4' : sameExt(files[0]);
  const out = outPath(files[0], target, ' (merged)');
  args.push('-filter_complex', filter);
  if (video) args.push('-map', '[v]');
  if (audio) args.push('-map', '[a]');
  args.push(...(video ? VIDEO_ARGS.mp4 : AUDIO_ARGS[target] || AUDIO_ARGS.mp3), out);
  await ffmpeg(args, { onProgress: progress, duration: total });
  return [out];
}

async function normalize(file, _opts, progress) {
  const out = outPath(file, sameExt(file), '-normalized');
  await ffmpeg(['-i', file, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', ...codecFor(file), out], { onProgress: progress });
  return [out];
}

async function audioCompress(file, opts, progress) {
  const kbps = Number(opts.bitrate) || 128;
  const target = opts.format || 'mp3';
  const out = outPath(file, target, `-${kbps}k`);
  const codec = { mp3: 'libmp3lame', m4a: 'aac', ogg: 'libvorbis', opus: 'libopus' }[target];
  await ffmpeg(['-i', file, '-vn', '-c:a', codec, '-b:a', `${kbps}k`, out], { onProgress: progress });
  return [out];
}

async function channels(file, opts, progress) {
  const stereo = opts.to === 'stereo';
  const out = outPath(file, sameExt(file), stereo ? '-stereo' : '-mono');
  // Mono to stereo duplicates the same audio into both channels.
  await ffmpeg(['-i', file, '-ac', stereo ? '2' : '1', ...codecFor(file), out], { onProgress: progress });
  return [out];
}

// Removes leading and trailing silence, keeping pauses inside the recording.
async function trimSilence(file, opts, progress) {
  const db = Number(opts.threshold) || -50;
  const edge = `silenceremove=start_periods=1:start_threshold=${db}dB:start_silence=0.1`;
  const out = outPath(file, sameExt(file), '-trimmed');
  await ffmpeg(['-i', file, '-af', `${edge},areverse,${edge},areverse`, ...codecFor(file), out], { onProgress: progress });
  return [out];
}

const WAVE_SIZES = { landscape: '1280x720', portrait: '720x1280', square: '1080x1080' };

// Renders an audio file as an MP4 with an animated waveform.
async function visualize(file, opts, progress) {
  const size = WAVE_SIZES[opts.shape] || WAVE_SIZES.landscape;
  const color = String(opts.color || '#6d5bf7').replace('#', '0x');
  const info = await probe(file);
  const out = outPath(file, 'mp4', '-waveform');
  await ffmpeg([
    '-i', file,
    '-filter_complex', `[0:a]showwaves=s=${size}:mode=cline:rate=30:colors=${color},format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-shortest', out,
  ], { onProgress: progress, duration: info.duration });
  return [out];
}

// "0:05-0:07, 1:10-1:12" -> [[5, 7], [70, 72]]
function parseRangesTime(spec) {
  const ranges = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [a, b] = part.split('-').map((s) => parseTime(s.trim()));
    if (a === null || b === null || !(b > a)) throw new Error(`Invalid range "${part}". Use start-end, e.g. 0:05-0:07`);
    return [a, b];
  });
  if (!ranges.length) throw new Error('Enter at least one range to bleep');
  return ranges;
}

// Silences the given ranges and lays a 1 kHz tone over them.
async function bleep(file, opts, progress) {
  const expr = parseRangesTime(opts.ranges).map(([a, b]) => `between(t,${a},${b})`).join('+');
  const info = await probe(file);
  const out = outPath(file, sameExt(file), '-bleeped');
  const filter = `[0:a]volume=0:enable='${expr}'[m];sine=frequency=1000:sample_rate=48000,volume=0.25,volume=0:enable='not(${expr})'[s];[m][s]amix=inputs=2:duration=first:normalize=0[a]`;
  const args = ['-i', file, '-filter_complex', filter, '-map', '[a]'];
  if (info.hasVideo) {
    // Keep the picture untouched; re-encode only the audio in a codec the container accepts.
    const audio = { webm: ['-c:a', 'libopus'], avi: ['-c:a', 'libmp3lame'], wmv: ['-c:a', 'wmav2'] }[ext(file)] || ['-c:a', 'aac', '-b:a', '192k'];
    args.push('-map', '0:v', '-c:v', 'copy', ...audio);
  } else {
    args.push(...(AUDIO_ARGS[ext(file)] || AUDIO_ARGS.mp3));
  }
  args.push(out);
  await ffmpeg(args, { onProgress: progress, duration: info.duration });
  return [out];
}

// Writes or strips embedded tags without re-encoding.
async function metadata(file, opts, progress) {
  const strip = opts.action === 'strip';
  const out = outPath(file, ext(file) || 'mp4', strip ? '-clean' : '-tagged');
  const args = ['-i', file, '-map', '0', '-c', 'copy'];
  if (strip) args.push('-map_metadata', '-1', '-map_chapters', '-1');
  else {
    for (const key of ['title', 'artist', 'album', 'comment', 'date']) {
      if (opts[key]) args.push('-metadata', `${key}=${opts[key]}`);
    }
  }
  args.push(out);
  await ffmpeg(args, { onProgress: progress });
  return [out];
}

const CROP_RATIOS = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, '4:5': 4 / 5, '21:9': 21 / 9 };

// Center-crops a video to an aspect ratio, keeping the original audio.
async function cropVideo(file, opts, progress) {
  const r = CROP_RATIOS[opts.aspect] || 1;
  const w = `trunc(min(iw\\,ih*${r})/2)*2`;
  const h = `trunc(min(ih\\,iw/${r})/2)*2`;
  const out = outPath(file, sameExt(file) === 'gif' ? 'gif' : 'mp4', '-cropped');
  const args = ['-i', file, '-vf', `crop=${w}:${h}`];
  if (!out.endsWith('.gif')) args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart');
  args.push(out);
  await ffmpeg(args, { onProgress: progress });
  return [out];
}

async function fade(file, opts, progress) {
  const info = await probe(file);
  const fin = Number(opts.fadeIn) || 0;
  const fout = Number(opts.fadeOut) || 0;
  const af = [];
  if (fin) af.push(`afade=t=in:st=0:d=${fin}`);
  if (fout) af.push(`afade=t=out:st=${Math.max(0, info.duration - fout)}:d=${fout}`);
  if (!af.length) throw new Error('Set a fade in or fade out length');
  const out = outPath(file, sameExt(file), '-faded');
  await ffmpeg(['-i', file, '-af', af.join(','), ...codecFor(file), out], { onProgress: progress, duration: info.duration });
  return [out];
}

async function volume(file, opts, progress) {
  const db = Number(opts.db) || 0;
  const out = outPath(file, sameExt(file), `-${db >= 0 ? '+' : ''}${db}dB`);
  await ffmpeg(['-i', file, '-af', `volume=${db}dB`, ...codecFor(file), out], { onProgress: progress });
  return [out];
}

// Splits media into equal-length segments.
async function split(file, opts, progress) {
  const len = parseTime(opts.every) || 60;
  const dir = uniqueDir(path.join(outDir(file), `${base(file)} parts`));
  await fsp.mkdir(dir, { recursive: true });
  const pattern = path.join(dir, `${base(file)}-part%03d.${sameExt(file)}`);
  await ffmpeg(['-i', file, '-f', 'segment', '-segment_time', String(len), '-reset_timestamps', '1', ...codecFor(file), pattern], { onProgress: progress });
  return [dir];
}

module.exports = {
  convert, trim, compressVideo, resizeVideo, mute, frame, rotateVideo, speed, merge,
  normalize, audioCompress, channels, trimSilence, visualize, bleep, metadata, cropVideo, fade, volume, split, withTemp,
  codecFor, sameExt,
};
