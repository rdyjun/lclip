const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { Videos } = require('../models/db');
const config = require('../config');
const { renderSubtitlePng } = require('./subtitleRenderer');

// FFMPEG_PATH env var takes priority (set in Dockerfile for system FFmpeg).
// Falls back to ffmpeg-static for local dev environments.
if (!process.env.FFMPEG_PATH) {
  try {
    ffmpeg.setFfmpegPath(require('ffmpeg-static'));
  } catch (e) {
    console.warn('ffmpeg-static not found, using system ffmpeg');
  }
}
if (!process.env.FFPROBE_PATH) {
  try {
    ffmpeg.setFfprobePath(require('@ffprobe-installer/ffprobe').path);
  } catch (e) {
    console.warn('ffprobe-installer not found, using system ffprobe');
  }
}

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const duration = metadata.format.duration || 0;
      const width  = videoStream ? videoStream.width  : 0;
      const height = videoStream ? videoStream.height : 0;
      let fps = 30;
      if (videoStream && videoStream.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/');
        if (parts.length === 2) fps = Math.round(parseInt(parts[0]) / parseInt(parts[1]));
      }
      resolve({ duration: parseFloat(duration), width, height, fps });
    });
  });
}

// Round down to nearest even number (≥2). libx264 + yuv420p requires even W/H.
const evenFloor = n => Math.max(2, n % 2 === 0 ? n : n - 1);

// Build an atempo filter chain for the given speed (atempo range: 0.5–2.0).
// e.g. 0.25 → "atempo=0.5,atempo=0.5", 4 → "atempo=2.0,atempo=2.0"
function buildAtempoFilter(speed) {
  const filters = [];
  let s = speed;
  while (s < 0.5) { filters.push('atempo=0.5'); s /= 0.5; }
  while (s > 2.0) { filters.push('atempo=2.0'); s /= 2.0; }
  if (Math.abs(s - 1.0) > 0.001) filters.push(`atempo=${s.toFixed(6)}`);
  return filters.join(',');
}

// Compute the spatial filter (crop + scale) for a video clip and the overlay
// position on the output canvas.  Works for cover / contain / fill fit modes.
// Returns { scaleFilter, fw, fh, overlayX, overlayY }.
function computeClipFilter(clip, srcW, srcH, outputWidth, outputHeight) {
  const scaleW = clip.width  || outputWidth;
  const scaleH = clip.height || outputHeight;
  const fit    = clip.fit    || 'cover';
  const cx     = clip.x || 0;
  const cy     = clip.y || 0;

  if (fit === 'cover' && srcW > 0 && srcH > 0) {
    // Visible region of the clip on the output canvas (display coordinates).
    // evenFloor ensures the scale target is divisible by 2 (yuv420p requirement).
    const fx = Math.max(0, -cx);
    const fy = Math.max(0, -cy);
    const fw = evenFloor(Math.max(1, Math.min(outputWidth,  cx + scaleW) - Math.max(0, cx)));
    const fh = evenFloor(Math.max(1, Math.min(outputHeight, cy + scaleH) - Math.max(0, cy)));

    // Cover maps source → display by scaling to the axis that fills both dims.
    // force_original_aspect_ratio=increase picks the larger scale factor, then
    // the other axis is cropped from the center.
    const srcAspect = srcW / srcH;
    const tgtAspect = scaleW / scaleH;
    let sf, offX, offY;
    if (srcAspect >= tgtAspect) {
      sf   = scaleH / srcH;
      offX = (srcW * sf - scaleW) / 2;
      offY = 0;
    } else {
      sf   = scaleW / srcW;
      offX = 0;
      offY = (srcH * sf - scaleH) / 2;
    }

    // Reverse-map the visible display region back to source pixel coordinates.
    const srcCropX = Math.max(0, (fx + offX) / sf);
    const srcCropY = Math.max(0, (fy + offY) / sf);
    const srcCropW = Math.max(1, Math.min(srcW - srcCropX, fw / sf));
    const srcCropH = Math.max(1, Math.min(srcH - srcCropY, fh / sf));

    const scaleFilter =
      `crop=${Math.round(srcCropW)}:${Math.round(srcCropH)}:` +
      `${Math.round(srcCropX)}:${Math.round(srcCropY)},` +
      `scale=${fw}:${fh}:flags=bilinear`;
    return { scaleFilter, fw, fh, overlayX: Math.max(0, cx), overlayY: Math.max(0, cy) };
  }

  if (fit === 'contain') {
    const scaleFilter = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease,pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:black`;
    return { scaleFilter, fw: scaleW, fh: scaleH, overlayX: cx, overlayY: cy };
  }

  // fill (cover fallback when probe failed, or explicit fill)
  const scaleFilter = `scale=${scaleW}:${scaleH}:flags=bilinear`;
  return { scaleFilter, fw: scaleW, fh: scaleH, overlayX: cx, overlayY: cy };
}

// onProgress(percent 0-100, message) — called during export to report progress.
// Phase 1 (clip extraction): 0 → 60 %.
// Phase 2 (compositing):     60 → 100 %.
// subtitlePngMap: optional {[clipId]: Buffer} of browser-rendered PNGs.
// When provided, these are used instead of node-canvas rendering to guarantee
// the exported font matches the editor preview exactly.
async function exportVideo(project, outputPath, onProgress = null, subtitlePngMap = {}) {
  const { layers, outputWidth = 1080, outputHeight = 1920, fps = 30 } = project;

  // Collect clips by type across ALL layers, respecting visibility.
  const allVideoClips = layers
    .filter(l => l.visible !== false)
    .flatMap(l => l.clips.filter(c => c.type === 'video'))
    .sort((a, b) => a.startTime - b.startTime);

  const allSubtitleClips = layers
    .filter(l => l.visible !== false)
    .flatMap(l => l.clips.filter(c => c.type === 'subtitle'));

  const allAudioClips = layers
    .filter(l => l.visible !== false)
    .flatMap(l => l.clips.filter(c => c.type === 'audio' && c.src));

  if (!allVideoClips.length) {
    throw new Error('No video clips found');
  }

  // Resolve file paths for all video clips.
  const resolvedVideoClips = allVideoClips.map(clip => {
    let srcPath;
    const streamMatch = clip.src && clip.src.match(/\/api\/videos\/stream\/([^/]+)/);
    if (streamMatch) {
      const video = Videos.findById(streamMatch[1]);
      if (video) {
        srcPath = video.isLocal
          ? video.localPath
          : path.join(config.UPLOADS_DIR, '..', (video.path || '').replace(/^\//, ''));
      }
    }
    if (!srcPath) srcPath = path.join(config.UPLOADS_DIR, '..', clip.src.replace(/^\//, ''));
    return { ...clip, srcPath };
  });

  // Probe each clip once for audio presence and source video dimensions.
  const clipInfo = await Promise.all(
    resolvedVideoClips.map(clip =>
      new Promise(res => {
        ffmpeg.ffprobe(clip.srcPath, (err, meta) => {
          if (err) return res({ hasAudio: false, srcW: 0, srcH: 0 });
          const vStream = meta.streams.find(s => s.codec_type === 'video');
          res({
            hasAudio: meta.streams.some(s => s.codec_type === 'audio'),
            srcW: vStream ? vStream.width  : 0,
            srcH: vStream ? vStream.height : 0,
          });
        });
      })
    )
  );

  const totalDuration = allVideoClips.reduce((max, c) => Math.max(max, c.endTime), 0);

  // ── Phase 1: Extract each clip to a local temp file (sequential) ───────────
  // Running clips one-at-a-time avoids concurrent reads from NAS/slow storage,
  // which causes I/O saturation and stalls the FFmpeg filter graph.
  const tempDir = outputPath + '_clips';
  await fs.ensureDir(tempDir);

  const tempClips = []; // { file, clip, fw, fh, overlayX, overlayY, hasAudio }
  try {
    for (let i = 0; i < resolvedVideoClips.length; i++) {
      const clip = resolvedVideoClips[i];
      const { srcW, srcH, hasAudio } = clipInfo[i];
      const { scaleFilter, fw, fh, overlayX, overlayY } =
        computeClipFilter(clip, srcW, srcH, outputWidth, outputHeight);

      const tempFile = path.join(tempDir, `clip_${i}.mp4`);
      const speed = clip.speed || 1;
      const srcDuration = clip.srcEnd - clip.srcStart;
      const clipDuration = (srcDuration / speed).toFixed(3);

      // Dual-seek strategy for near-frame-accurate extraction on all codecs:
      //   • Input -ss (fast): demuxer seeks to keyframe ≤ srcStart-seekBuffer.
      //   • Output -ss seekBuffer: fine-tune — skip seekBuffer seconds of the
      //     decoded/filtered output so we land at ≈ srcStart.
      // This avoids the HEVC PTS-reset problem (trim=start=srcStart failed because
      // after fast seek HEVC resets PTS to 0; seekBuffer math now compensates).
      // setsar=1/1 corrects non-square SAR (e.g. 496:495) from some HEVC sources.
      const seekBuffer    = Math.min(clip.srcStart, 10);
      const seekStart     = clip.srcStart - seekBuffer;
      // Output -ss is in output time (after speed filter); divide by speed accordingly.
      const outSeekBuffer = (seekBuffer / speed).toFixed(3);

      const speedPts = speed !== 1 ? `setpts=PTS/${speed},` : '';
      const vFilter  = `[0:v]${speedPts}${scaleFilter},setsar=1/1[ov]`;
      let aFilter    = '';
      if (hasAudio) {
        const atempoChain = speed !== 1 ? `,${buildAtempoFilter(speed)}` : '';
        aFilter = `;[0:a]asetpts=PTS-STARTPTS${atempoChain}[oa]`;
      }
      const maps = hasAudio ? ['ov', 'oa'] : ['ov'];

      const n = resolvedVideoClips.length;
      const msg = `클립 추출 중 (${i + 1}/${n})`;
      console.log(`Extracting clip ${i + 1}/${n} → ${path.basename(tempFile)} (speed=${speed}x)`);
      onProgress?.(Math.round(i / n * 60), msg);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(clip.srcPath)
          .inputOptions(['-ss ' + seekStart.toFixed(3)])
          .complexFilter(vFilter + aFilter, maps)
          .outputOptions([
            '-ss ' + outSeekBuffer,          // fine-tune: skip buffer from decoded output
            '-t ' + clipDuration,
            '-c:v libx264', '-preset ultrafast', '-crf 10',
            ...(hasAudio ? ['-c:a aac', '-b:a 192k'] : ['-an']),
          ])
          .output(tempFile)
          .on('stderr', line => console.error(`[clip ${i}] ${line}`))
          .on('end', resolve)
          .on('error', (err, stdout, stderr) => {
            console.error(`Clip ${i} extraction failed:\n${stderr}`);
            reject(err);
          })
          .run();
      });

      onProgress?.(Math.round((i + 1) / n * 60), msg);
      tempClips.push({ file: tempFile, clip, fw, fh, overlayX, overlayY, hasAudio });
    }

    // Pre-render subtitle clips to transparent PNGs.
    // Priority: browser-rendered PNGs from subtitlePngMap (pixel-perfect match with editor preview).
    // Fallback: node-canvas rendering (used when browser PNGs are not available).
    const validSubtitlePngs = [];
    for (let i = 0; i < allSubtitleClips.length; i++) {
      const clip = allSubtitleClips[i];
      if (!clip.text) continue;
      const buf = subtitlePngMap[clip.id] || renderSubtitlePng(clip, outputWidth, outputHeight);
      if (!buf) continue;
      const pngFile = path.join(tempDir, `subtitle_${i}.png`);
      await fs.writeFile(pngFile, buf);
      validSubtitlePngs.push({ file: pngFile, clip });
    }

    // ── Phase 2: Composite from temp files (fast local disk I/O) ─────────────
    const cmd = ffmpeg();
    const filterParts = [];
    const audioFilterParts = [];
    const allAudioLabels   = [];

    filterParts.push(
      `color=c=black:size=${outputWidth}x${outputHeight}:duration=${totalDuration}:rate=${fps}[bg]`
    );

    // Video clips — each temp file has PTS starting at 0; shift to timeline pos.
    let currentBase = '[bg]';
    tempClips.forEach(({ file, clip, overlayX, overlayY, hasAudio }, i) => {
      cmd.input(file);

      // KEY: shift clip PTS to its output timeline position so the overlay filter
      // receives frames at the right time.  enable= guards pass-through before/after.
      filterParts.push(`[${i}:v]setpts=PTS+${clip.startTime}/TB[tv${i}]`);
      filterParts.push(
        `${currentBase}[tv${i}]overlay=x=${overlayX}:y=${overlayY}` +
        `:enable='between(t,${clip.startTime},${clip.endTime})'[base${i}]`
      );
      currentBase = `[base${i}]`;

      if (hasAudio) {
        const delayMs = Math.round(clip.startTime * 1000);
        const vol = clip.volume !== undefined ? clip.volume : 1;
        // Temp file audio is already trimmed to clip duration; just delay to position.
        audioFilterParts.push(`[${i}:a]volume=${vol},adelay=${delayMs}:all=1[av${i}]`);
        allAudioLabels.push(`[av${i}]`);
      }
    });

    // Subtitle PNG overlay filters (node-canvas pre-rendered, pixel-perfect match with editor preview)
    // Use -r {fps} instead of -framerate 1 to match output framerate — ensures the overlay
    // filter always has a frame available and prevents intermittent subtitle dropout.
    validSubtitlePngs.forEach(({ file }) => {
      cmd.input(file);
      cmd.inputOptions([`-r ${fps}`, '-loop 1']);
    });

    let subtitleBase = currentBase;
    validSubtitlePngs.forEach(({ clip }, i) => {
      const inputIdx = tempClips.length + i;
      filterParts.push(
        `${subtitleBase}[${inputIdx}:v]overlay=0:0:` +
        `enable='between(t,${clip.startTime},${clip.endTime})'[subover${i}]`
      );
      subtitleBase = `[subover${i}]`;
    });

    // Background audio inputs (follow video + subtitle PNG inputs)
    const bgAudioOffset = tempClips.length + validSubtitlePngs.length;
    allAudioClips.forEach((clip, i) => {
      const audioPath = path.join(config.UPLOADS_DIR, '..', clip.src.replace(/^\//, ''));
      cmd.input(audioPath);
      const vol      = clip.volume !== undefined ? clip.volume : 0.8;
      const startT   = clip.startTime || 0;
      const clipDur  = Math.max(0.1, (clip.endTime || totalDuration) - startT);
      const delayMs  = Math.round(startT * 1000);
      // atrim: trim the audio file to clip duration
      // asetpts: reset PTS to 0 after trim
      // adelay: shift the trimmed audio to its timeline start position
      audioFilterParts.push(
        `[${bgAudioOffset + i}:a]atrim=duration=${clipDur.toFixed(3)},` +
        `asetpts=PTS-STARTPTS,volume=${vol},adelay=${delayMs}:all=1[abg${i}]`
      );
      allAudioLabels.push(`[abg${i}]`);
    });

    // Mix all audio sources
    let audioMapLabel = null;
    if (allAudioLabels.length === 1) {
      audioMapLabel = allAudioLabels[0].replace(/[\[\]]/g, '');
    } else if (allAudioLabels.length > 1) {
      audioFilterParts.push(
        `${allAudioLabels.join('')}amix=inputs=${allAudioLabels.length}:duration=longest:normalize=0[amixed]`
      );
      audioMapLabel = 'amixed';
    }

    // Build final filter graph
    const filterGraph     = [...filterParts, ...audioFilterParts].join(';');
    const finalVideoLabel = (validSubtitlePngs.length > 0 ? subtitleBase : currentBase).replace(/[\[\]]/g, '');
    const mapLabels       = audioMapLabel ? [finalVideoLabel, audioMapLabel] : [finalVideoLabel];

    const outputOpts = [
      '-c:v libx264',
      '-preset veryfast',
      '-crf 23',
      `-r ${fps}`,
      '-pix_fmt yuv420p',
      `-t ${totalDuration}`,
    ];
    if (audioMapLabel) {
      outputOpts.push('-c:a aac', '-b:a 192k');
    } else {
      outputOpts.push('-an');
    }

    await new Promise((resolve, reject) => {
      cmd
        .complexFilter(filterGraph, mapLabels)
        .outputOptions(outputOpts)
        .output(outputPath)
        .on('start', cmd => console.log('FFmpeg composite started:', cmd))
        .on('progress', p => {
          const pct = Math.min(99, 60 + Math.round((p.percent || 0) * 0.4));
          onProgress?.(pct, '합성 렌더링 중');
          console.log(`Export progress: ${pct}%`);
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

  } finally {
    // Always clean up temp files even if export fails
    await fs.remove(tempDir);
  }
}

function rgbToFFmpegColor(hex) {
  if (!hex || !hex.startsWith('#')) return 'white';
  return '0x' + hex.slice(1);
}

// Converts CSS color (rgba(...) or #RRGGBB[AA]) to FFmpeg 0xRRGGBBAA format.
// Returns null for transparent/none values so callers can skip the box option.
function rgbaToFFmpegColor(cssColor) {
  if (!cssColor || cssColor === 'none' || cssColor === 'transparent') return null;

  const rgbaMatch = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    const r  = parseInt(rgbaMatch[1], 10);
    const g  = parseInt(rgbaMatch[2], 10);
    const b  = parseInt(rgbaMatch[3], 10);
    const a  = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    const aa = Math.round(a * 255);
    return (
      '0x' +
      r.toString(16).padStart(2, '0') +
      g.toString(16).padStart(2, '0') +
      b.toString(16).padStart(2, '0') +
      aa.toString(16).padStart(2, '0')
    );
  }

  if (cssColor.startsWith('#')) {
    const hex = cssColor.slice(1);
    if (hex.length === 3)  return `0x${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}ff`;
    if (hex.length === 6)  return `0x${hex}ff`;
    if (hex.length === 8)  return `0x${hex}`;
  }

  return null;
}

// Project-bundled fonts directory (cross-platform, takes priority over system fonts)
const PROJECT_FONT_DIR = path.join(__dirname, '../../fonts');
// Docker image fonts directory
const DOCKER_FONT_DIR  = '/usr/share/fonts/korean';

const FONT_MAP = {
  'Noto Sans KR, sans-serif':     { r: 'NotoSansKR-Regular.ttf',     b: 'NotoSansKR-Bold.ttf' },
  'Nanum Gothic, sans-serif':     { r: 'NanumGothic-Regular.ttf',    b: 'NanumGothic-Bold.ttf' },
  'Nanum Myeongjo, serif':        { r: 'NanumMyeongjo-Regular.ttf',  b: 'NanumMyeongjo-Bold.ttf' },
  'Gowun Dodum, sans-serif':      { r: 'GowunDodum-Regular.ttf',     b: null },
  'Gowun Batang, serif':          { r: 'GowunBatang-Regular.ttf',    b: null },
  'Black Han Sans, sans-serif':   { r: 'BlackHanSans-Regular.ttf',   b: null },
  'Do Hyeon, sans-serif':         { r: 'DoHyeon-Regular.ttf',        b: null },
  'IBM Plex Sans KR, sans-serif': { r: 'IBMPlexSansKR-Regular.ttf', b: 'IBMPlexSansKR-Bold.ttf' },
  'Jua, sans-serif':              { r: 'Jua-Regular.ttf',            b: null },
};

// NotoSansKR static Regular font — consistent metrics across FreeType and DirectWrite
const NOTO_VARIABLE = path.join(PROJECT_FONT_DIR, 'NotoSansKR-Regular.ttf');

function getFontPath(bold, fontFamily) {
  // 1. Project-bundled fonts (highest priority — same font as browser, cross-platform)
  if (fontFamily && FONT_MAP[fontFamily]) {
    const entry = FONT_MAP[fontFamily];
    const names = bold && entry.b ? [entry.b, entry.r] : [entry.r];
    for (const name of names) {
      if (!name) continue;
      const p = path.join(PROJECT_FONT_DIR, name);
      if (fs.existsSync(p)) return p;
    }
  }
  // Noto Sans KR variable font covers all weights
  if ((!fontFamily || fontFamily.includes('Noto')) && fs.existsSync(NOTO_VARIABLE)) {
    return NOTO_VARIABLE;
  }

  // 2. Docker image fonts
  if (fontFamily && FONT_MAP[fontFamily]) {
    const entry = FONT_MAP[fontFamily];
    const names = bold && entry.b ? [entry.b, entry.r] : [entry.r];
    for (const name of names) {
      if (!name) continue;
      const p = path.join(DOCKER_FONT_DIR, name);
      if (fs.existsSync(p)) return p;
    }
  }

  // 3. System font fallbacks (Windows → Linux → macOS)
  const boldFallbacks = [
    path.join(DOCKER_FONT_DIR, 'NanumGothic-Bold.ttf'),
    'C\\:/Windows/Fonts/malgunbd.ttf',
    'C\\:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
  ];
  const regularFallbacks = [
    path.join(DOCKER_FONT_DIR, 'NanumGothic-Regular.ttf'),
    'C\\:/Windows/Fonts/malgun.ttf',
    'C\\:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  const candidates = bold ? [...boldFallbacks, ...regularFallbacks] : regularFallbacks;
  for (const f of candidates) {
    const real = f.startsWith('C\\:/') ? f.replace('C\\:/', 'C:/') : f;
    if (fs.existsSync(real)) return f;
  }
  return candidates[0];
}

// Creates a fluent-ffmpeg command that extracts [start, end] seconds from
// srcPath and re-encodes to H.264/AAC fragmented MP4 (safe for streaming
// and for FFmpeg.wasm, which may not have HEVC decoder).
function createClipStream(srcPath, start, end, hasAudio = true) {
  const duration = end - start;
  const audioOpts = hasAudio ? ['-c:a aac', '-b:a 128k'] : ['-an'];
  return ffmpeg(srcPath)
    .inputOptions(['-ss ' + start.toFixed(3)])
    .outputOptions([
      '-t ' + duration.toFixed(3),
      '-c:v libx264', '-preset ultrafast', '-crf 18',
      ...audioOpts,
      // Fragmented MP4: client can start reading before transfer completes
      '-movflags frag_keyframe+empty_moov+default_base_moof',
    ])
    .format('mp4');
}

module.exports = { getVideoInfo, exportVideo, createClipStream, getFontPath };
