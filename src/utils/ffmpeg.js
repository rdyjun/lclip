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

function exportVideo(project, outputPath) {
  return new Promise((resolve, reject) => {
    const { layers, outputWidth = 1080, outputHeight = 1920, fps = 30 } = project;

    // Collect clips by type across ALL layers (not restricted to layer.type)
    const allVideoClips = layers
      .flatMap(l => l.clips.filter(c => c.type === 'video'))
      .sort((a, b) => a.startTime - b.startTime);

    const allSubtitleClips = layers
      .filter(l => l.visible !== false)
      .flatMap(l => l.clips.filter(c => c.type === 'subtitle'));

    const allAudioClips = layers
      .flatMap(l => l.clips.filter(c => c.type === 'audio' && c.src));

    if (!allVideoClips.length) {
      return reject(new Error('No video clips found'));
    }

    const cmd = ffmpeg();
    const inputs = [];
    const filterParts = [];

    const totalDuration = allVideoClips.reduce((max, c) => Math.max(max, c.endTime), 0);

    filterParts.push(
      `color=c=black:size=${outputWidth}x${outputHeight}:duration=${totalDuration}:rate=${fps}[bg]`
    );

    let currentBase = '[bg]';
    allVideoClips.forEach((clip, i) => {
      // Resolve file path from stream URL
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

      cmd.input(srcPath);
      const inputIdx = inputs.length;
      inputs.push(srcPath);

      const scaleW = clip.width  || outputWidth;
      const scaleH = clip.height || outputHeight;
      const fit    = clip.fit    || 'cover';

      // Fit-aware scale filter — preserves aspect ratio as in the editor preview
      let scaleFilter;
      if (fit === 'cover') {
        // Scale up to cover the target area, then crop center
        scaleFilter = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase,crop=${scaleW}:${scaleH}`;
      } else if (fit === 'contain') {
        // Scale down to fit, pad with black
        scaleFilter = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease,pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:black`;
      } else {
        // fill — stretch
        scaleFilter = `scale=${scaleW}:${scaleH}`;
      }

      // KEY FIX: offset PTS to the output timeline position.
      // Without this, PTS starts at 0 for each trimmed clip and the overlay
      // consumes all frames before the enable condition becomes true → frozen frame.
      filterParts.push(
        `[${inputIdx}:v]trim=start=${clip.srcStart}:end=${clip.srcEnd},` +
        `setpts=PTS-STARTPTS+(${clip.startTime}/TB),${scaleFilter}[v${i}]`
      );
      filterParts.push(
        `${currentBase}[v${i}]overlay=x=${clip.x || 0}:y=${clip.y || 0}` +
        `:enable='between(t,${clip.startTime},${clip.endTime})'[base${i}]`
      );
      currentBase = `[base${i}]`;
    });

    // Subtitle drawtext filters
    let subtitleBase = currentBase;
    let subtitleIdx  = 0;
    allSubtitleClips.forEach(clip => {
      if (!clip.text) return;
      const escaped  = clip.text.replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\n/g, '\\n');
      const colorHex = rgbToFFmpegColor(clip.color || '#ffffff');
      const fontSize = clip.fontSize || 48;
      const fontFile = getFontPath(clip.bold);
      filterParts.push(
        `${subtitleBase}drawtext=fontfile='${fontFile}':text='${escaped}'` +
        `:fontsize=${fontSize}:fontcolor=${colorHex}:x=(w-text_w)/2:y=${clip.y || 100}` +
        `:enable='between(t,${clip.startTime},${clip.endTime})'[subs${subtitleIdx}]`
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

    // Each video clip has its own input (even if same source file), so [i:a] is safe
    allVideoClips.forEach((clip, i) => {
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
      '-preset fast',
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

function getFontPath(bold) {
  const boldCandidates = [
    '/usr/share/fonts/nanum/NanumGothic-Bold.ttf',           // Docker Alpine (Korean)
    'C\\:/Windows/Fonts/malgunbd.ttf',                       // Windows Malgun Gothic Bold
    'C\\:/Windows/Fonts/arialbd.ttf',                        // Windows Arial Bold
    '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',   // Ubuntu/Debian
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc'
  ];
  const regularCandidates = [
    '/usr/share/fonts/nanum/NanumGothic-Regular.ttf',        // Docker Alpine (Korean)
    'C\\:/Windows/Fonts/malgun.ttf',                         // Windows Malgun Gothic
    'C\\:/Windows/Fonts/arial.ttf',                          // Windows Arial
    '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',       // Ubuntu/Debian
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc'
  ];
  const candidates = bold ? [...boldCandidates, ...regularCandidates] : regularCandidates;
  for (const f of candidates) {
    const real = f.replace('C\\:/', 'C:/');
    if (fs.existsSync(real)) return f;
  }
  // Last resort: return first candidate and let FFmpeg fail with a clear error
  return candidates[0];
}

module.exports = { getVideoInfo, exportVideo };
