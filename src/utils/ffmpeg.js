const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { Videos } = require('../models/db');
const config = require('../config');

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

async function exportVideo(project, outputPath) {
    const { layers, outputWidth = 1080, outputHeight = 1920, fps = 30 } = project;

    // Collect clips by type across ALL layers (not restricted to layer.type)
    // Bug fix: apply visibility filter consistently across all clip types
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

    // Resolve source paths and probe audio streams for all video clips up front.
    // This prevents [i:a] filter references from crashing FFmpeg when a clip has no audio.
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

    // Probe each clip for audio presence and source dimensions.
    // Source dimensions are used to compute the minimal crop region for cover mode,
    // avoiding processing millions of off-screen pixels.
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

    const cmd = ffmpeg();
    const inputs = [];
    const filterParts = [];

    const totalDuration = allVideoClips.reduce((max, c) => Math.max(max, c.endTime), 0);

    filterParts.push(
      `color=c=black:size=${outputWidth}x${outputHeight}:duration=${totalDuration}:rate=${fps}[bg]`
    );

    let currentBase = '[bg]';
    resolvedVideoClips.forEach((clip, i) => {
      const { srcPath } = clip;
      const { srcW, srcH } = clipInfo[i];

      // Fast seek: position FFmpeg near the trim start instead of decoding from 0.
      // -ss as input option does a keyframe seek (cheap); trim filter still uses
      // absolute source PTS because accurate_seek (default) preserves them.
      const seekStart = Math.max(0, clip.srcStart - 5);
      cmd.input(srcPath);
      cmd.inputOptions('-ss ' + seekStart.toFixed(3));
      const inputIdx = inputs.length;
      inputs.push(srcPath);

      const scaleW = clip.width  || outputWidth;
      const scaleH = clip.height || outputHeight;
      const fit    = clip.fit    || 'cover';
      const cx     = clip.x || 0;
      const cy     = clip.y || 0;

      // Fit-aware scale filter — preserves aspect ratio as in the editor preview.
      // For cover mode we compute the minimal source crop that covers the VISIBLE
      // canvas region, avoiding decoding/scaling millions of off-screen pixels.
      let scaleFilter;
      let overlayX = cx;
      let overlayY = cy;

      if (fit === 'cover' && srcW > 0 && srcH > 0) {
        // Visible region of the clip on the output canvas (display coordinates)
        const fx = Math.max(0, -cx);
        const fy = Math.max(0, -cy);
        const fw = Math.max(1, Math.min(outputWidth,  cx + scaleW) - Math.max(0, cx));
        const fh = Math.max(1, Math.min(outputHeight, cy + scaleH) - Math.max(0, cy));

        // Cover maps source → display by scaling to the axis that fills both dims.
        // force_original_aspect_ratio=increase picks the larger of the two scale
        // factors, then the other axis is cropped from the center.
        const srcAspect = srcW / srcH;
        const tgtAspect = scaleW / scaleH;
        let sf, offX, offY; // pixel offset of the scaleW×scaleH window inside the scaled source
        if (srcAspect >= tgtAspect) {
          // source wider → scale to height, crop left/right symmetrically
          sf   = scaleH / srcH;
          offX = (srcW * sf - scaleW) / 2;
          offY = 0;
        } else {
          // source taller → scale to width, crop top/bottom symmetrically
          sf   = scaleW / srcW;
          offX = 0;
          offY = (srcH * sf - scaleH) / 2;
        }

        // Reverse-map the visible display region back to source pixel coordinates
        const srcCropX = Math.max(0, (fx + offX) / sf);
        const srcCropY = Math.max(0, (fy + offY) / sf);
        const srcCropW = Math.max(1, Math.min(srcW - srcCropX, fw / sf));
        const srcCropH = Math.max(1, Math.min(srcH - srcCropY, fh / sf));

        // Crop source to only the visible portion, then scale that small region
        // to the display size. This avoids upscaling huge frames that mostly fall
        // outside the canvas (e.g. 5575×3128 → 1080×1920 saves ~17× pixel work).
        scaleFilter =
          `crop=${Math.round(srcCropW)}:${Math.round(srcCropH)}:` +
          `${Math.round(srcCropX)}:${Math.round(srcCropY)},` +
          `scale=${fw}:${fh}:flags=bilinear`;
        overlayX = Math.max(0, cx);
        overlayY = Math.max(0, cy);
      } else if (fit === 'cover') {
        // Probe failed — fall back to original approach
        scaleFilter = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH}`;
      } else if (fit === 'contain') {
        scaleFilter = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease,pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:black`;
      } else {
        // fill — stretch to display size
        scaleFilter = `scale=${scaleW}:${scaleH}:flags=bilinear`;
      }

      // KEY FIX: offset PTS to the output timeline position.
      // Without this, PTS starts at 0 for each trimmed clip and the overlay
      // consumes all frames before the enable condition becomes true → frozen frame.
      filterParts.push(
        `[${inputIdx}:v]trim=start=${clip.srcStart}:end=${clip.srcEnd},` +
        `setpts=PTS-STARTPTS+(${clip.startTime}/TB),${scaleFilter}[v${i}]`
      );
      filterParts.push(
        `${currentBase}[v${i}]overlay=x=${overlayX}:y=${overlayY}` +
        `:enable='between(t,${clip.startTime},${clip.endTime})'[base${i}]`
      );
      currentBase = `[base${i}]`;
    });

    // Subtitle drawtext filters
    let subtitleBase = currentBase;
    let subtitleIdx  = 0;
    allSubtitleClips.forEach(clip => {
      if (!clip.text) return;
      // % must be doubled to prevent FFmpeg drawtext from treating it as a strftime format
      const escaped  = clip.text.replace(/%/g, '%%').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\n/g, '\\n');
      const colorHex = rgbToFFmpegColor(clip.color || '#ffffff');
      const fontSize = clip.fontSize || 48;
      const fontFile = getFontPath(clip.bold, clip.fontFamily);

      // x: match canvas preview where clip.x is the text anchor point per alignment
      const align = clip.align || 'center';
      let xExpr;
      if (align === 'left') {
        xExpr = String(clip.x || 0);
      } else if (align === 'right') {
        xExpr = `${clip.x ?? outputWidth}-(text_w)`;
      } else {
        // center: anchor at clip.x (default = horizontal center of canvas)
        xExpr = `${clip.x || Math.round(outputWidth / 2)}-(text_w/2)`;
      }

      // Background box (matches canvas roundRect in preview; border-radius not supported by drawtext)
      let boxStr = '';
      const bgColor = clip.backgroundColor;
      if (bgColor && bgColor !== 'none') {
        const ffmpegBg = rgbaToFFmpegColor(bgColor);
        if (ffmpegBg) {
          const pad = clip.backgroundPadding || 16;
          boxStr = `:box=1:boxcolor=${ffmpegBg}:boxborderw=${pad}`;
        }
      }

      filterParts.push(
        `${subtitleBase}drawtext=fontfile='${fontFile}':text='${escaped}'` +
        `:fontsize=${fontSize}:fontcolor=${colorHex}:x=${xExpr}:y=${clip.y ?? 100}` +
        `${boxStr}:enable='between(t,${clip.startTime},${clip.endTime})'[subs${subtitleIdx}]`
      );
      subtitleBase = `[subs${subtitleIdx}]`;
      subtitleIdx++;
    });

    // Audio inputs (background music)
    allAudioClips.forEach(clip => {
      const audioPath = path.join(config.UPLOADS_DIR, '..', clip.src.replace(/^\//, ''));
      cmd.input(audioPath);
    });

    // ── Audio filter chain ──────────────────────────────────────────────────
    const audioFilterParts = [];
    const allAudioLabels   = [];

    // Only add [i:a] for clips that actually have an audio stream.
    // Without this guard, FFmpeg crashes when a video-only file is used.
    resolvedVideoClips.forEach((clip, i) => {
      if (!clipInfo[i].hasAudio) return;
      const delayMs = Math.round(clip.startTime * 1000);
      audioFilterParts.push(
        `[${i}:a]atrim=start=${clip.srcStart}:end=${clip.srcEnd},` +
        `asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[av${i}]`
      );
      allAudioLabels.push(`[av${i}]`);
    });

    // Background music inputs follow video clip inputs
    const bgAudioOffset = allVideoClips.length;
    allAudioClips.forEach((clip, i) => {
      const vol = clip.volume !== undefined ? clip.volume : 0.8;
      audioFilterParts.push(`[${bgAudioOffset + i}:a]volume=${vol}[abg${i}]`);
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

    // ── Build final filter graph ────────────────────────────────────────────
    const filterGraph    = [...filterParts, ...audioFilterParts].join(';');
    const finalVideoLabel = (subtitleIdx > 0 ? subtitleBase : currentBase).replace(/[\[\]]/g, '');
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

    return new Promise((resolve, reject) => {
      cmd
        .complexFilter(filterGraph, mapLabels)
        .outputOptions(outputOpts)
        .output(outputPath)
        .on('start', cmd => console.log('FFmpeg started:', cmd))
        .on('progress', p => console.log(`Export progress: ${Math.round(p.percent || 0)}%`))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
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

// Maps CSS fontFamily values (used in the editor UI) to TTF file names
// installed in /usr/share/fonts/korean/ inside the Docker image.
const FONT_DIR = '/usr/share/fonts/korean';
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

function getFontPath(bold, fontFamily) {
  // 1. Try the clip's selected font first
  if (fontFamily && FONT_MAP[fontFamily]) {
    const entry   = FONT_MAP[fontFamily];
    const names   = bold && entry.b ? [entry.b, entry.r] : [entry.r];
    for (const name of names) {
      if (!name) continue;
      const p = path.join(FONT_DIR, name);
      if (fs.existsSync(p)) return p;
    }
  }

  // 2. Generic fallback candidates (Docker → Windows → Linux → macOS)
  const boldFallbacks = [
    path.join(FONT_DIR, 'NanumGothic-Bold.ttf'),
    'C\\:/Windows/Fonts/malgunbd.ttf',
    'C\\:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  ];
  const regularFallbacks = [
    path.join(FONT_DIR, 'NanumGothic-Regular.ttf'),
    'C\\:/Windows/Fonts/malgun.ttf',
    'C\\:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ];
  const candidates = bold ? [...boldFallbacks, ...regularFallbacks] : regularFallbacks;
  for (const f of candidates) {
    const real = f.startsWith('C\\:/') ? f.replace('C\\:/', 'C:/') : f;
    if (fs.existsSync(real)) return f;
  }
  return candidates[0]; // let FFmpeg report the missing file clearly
}

module.exports = { getVideoInfo, exportVideo };
