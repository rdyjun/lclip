/**
 * clientExport.js — Client-side video export using FFmpeg.wasm.
 *
 * Architecture (mirrors server-side 2-pass pipeline):
 *   Phase 1 (per clip, sequential):
 *     • Fetch time-trimmed H.264 clip from /api/videos/clip/:id?start=X&end=Y
 *     • Write to FFmpeg.wasm VFS
 *     • Apply spatial transform (crop + scale) → clip_N.mp4 in VFS
 *     • Delete raw download from VFS to keep memory usage low
 *   Phase 2 (single composite pass):
 *     • Build filter_complex: black canvas → overlay each clip → drawtext subtitles
 *     • Mix audio from video clips + background audio
 *     • Read output MP4 → create Object URL → return to caller for download
 *
 * Requires:
 *   • Page served with COOP: same-origin + COEP: credentialless (for SharedArrayBuffer)
 *   • /api/videos/clip/:id  — server clip-extraction endpoint
 *   • /api/fonts/resolve    — server font-serving endpoint
 */

const ClientExport = (() => {

  // ── FFmpeg.wasm lazy loader ────────────────────────────────────────────────

  // Served from the same origin (node_modules served via express.static in server.js).
  // This ensures the Worker chunk (814.ffmpeg.js) is also same-origin,
  // which is required under COEP.
  const FFMPEG_JS   = '/vendor/ffmpeg/ffmpeg.js';
  const FFMPEG_CORE = '/vendor/ffmpeg-core/ffmpeg-core.js';
  const FFMPEG_WASM = '/vendor/ffmpeg-core/ffmpeg-core.wasm';
  // @ffmpeg/core (single-threaded) — no workerURL needed

  let _ffmpeg = null;

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload  = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function getFFmpeg() {
    if (_ffmpeg) return _ffmpeg;
    await loadScript(FFMPEG_JS);
    // The UMD bundle exposes FFmpegWASM globally
    const { FFmpeg } = window.FFmpegWASM;
    _ffmpeg = new FFmpeg();
    // Single-threaded core: only coreURL + wasmURL (no workerURL)
    await _ffmpeg.load({
      coreURL: FFMPEG_CORE,
      wasmURL: FFMPEG_WASM,
    });
    return _ffmpeg;
  }

  // ── Spatial filter helpers (mirrors src/utils/ffmpeg.js) ──────────────────

  const evenFloor = n => Math.max(2, n % 2 === 0 ? n : n - 1);

  function computeClipFilter(clip, srcW, srcH, outputWidth, outputHeight) {
    const scaleW = clip.width  || outputWidth;
    const scaleH = clip.height || outputHeight;
    const fit    = clip.fit    || 'cover';
    const cx     = clip.x || 0;
    const cy     = clip.y || 0;

    if (fit === 'cover' && srcW > 0 && srcH > 0) {
      const fx = Math.max(0, -cx);
      const fy = Math.max(0, -cy);
      const fw = evenFloor(Math.max(1, Math.min(outputWidth,  cx + scaleW) - Math.max(0, cx)));
      const fh = evenFloor(Math.max(1, Math.min(outputHeight, cy + scaleH) - Math.max(0, cy)));

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
      const scaleFilter =
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease,` +
        `pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:black`;
      return { scaleFilter, fw: scaleW, fh: scaleH, overlayX: cx, overlayY: cy };
    }

    // fill / fallback
    return {
      scaleFilter: `scale=${scaleW}:${scaleH}:flags=bilinear`,
      fw: scaleW, fh: scaleH, overlayX: cx, overlayY: cy,
    };
  }

  // ── Color helpers (mirrors src/utils/ffmpeg.js) ────────────────────────────

  function rgbToFFmpegColor(hex) {
    if (!hex || !hex.startsWith('#')) return 'white';
    return '0x' + hex.slice(1);
  }

  function rgbaToFFmpegColor(cssColor) {
    if (!cssColor || cssColor === 'none' || cssColor === 'transparent') return null;
    const m = cssColor.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/
    );
    if (m) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      const a  = m[4] !== undefined ? parseFloat(m[4]) : 1;
      const aa = Math.round(a * 255);
      return '0x' + [r, g, b, aa].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    if (cssColor.startsWith('#')) {
      const hex = cssColor.slice(1);
      if (hex.length === 3) return `0x${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}ff`;
      if (hex.length === 6) return `0x${hex}ff`;
      if (hex.length === 8) return `0x${hex}`;
    }
    return null;
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  function getVideoId(src) {
    const m = src && src.match(/\/api\/videos\/stream\/([^/?]+)/);
    return m ? m[1] : null;
  }

  async function fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return { data: new Uint8Array(await r.arrayBuffer()), headers: r.headers };
  }

  // ── Main export function ───────────────────────────────────────────────────

  /**
   * exportVideo(project, { onProgress, onLog }) → Promise<blobURL>
   *
   * onProgress(percent 0-100, message)
   * onLog(message)       — raw FFmpeg log lines
   */
  async function exportVideo(project, { onProgress, onLog } = {}) {
    const prog = (pct, msg) => onProgress && onProgress(pct, msg);
    const log  = msg => onLog && onLog(msg);

    prog(0, 'FFmpeg.wasm 로딩 중...');
    const ff = await getFFmpeg();
    ff.on('log', ({ message }) => log(message));

    const { layers, outputWidth = 1080, outputHeight = 1920, fps = 30 } = project;

    // ── Collect clips by type, respecting layer visibility ───────────────────
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

    if (!allVideoClips.length) throw new Error('비디오 클립이 없습니다');

    // ── Fetch source video metadata (width/height for filter computation) ────
    const videoIds = [...new Set(
      allVideoClips.map(c => getVideoId(c.src)).filter(Boolean)
    )];
    prog(1, '소스 메타데이터 확인 중...');
    const videoMeta = {};
    await Promise.all(videoIds.map(async id => {
      try {
        const r = await fetch(`/api/videos/${id}`);
        videoMeta[id] = await r.json();
      } catch (e) {
        videoMeta[id] = { width: 0, height: 0 };
      }
    }));

    const totalDuration = allVideoClips.reduce((max, c) => Math.max(max, c.endTime), 0);
    const n = allVideoClips.length;

    // ── Phase 1: fetch each clip from server, scale in FFmpeg.wasm ───────────
    // Server endpoint returns H.264-encoded clip so FFmpeg.wasm can decode it
    // regardless of the original codec (e.g. HEVC/H.265).
    const scaledClips = []; // { name, clip, overlayX, overlayY, hasAudio }

    for (let i = 0; i < n; i++) {
      const clip    = allVideoClips[i];
      const videoId = getVideoId(clip.src);
      const meta    = videoMeta[videoId] || {};
      const srcW    = meta.width  || 0;
      const srcH    = meta.height || 0;
      const { scaleFilter, overlayX, overlayY } =
        computeClipFilter(clip, srcW, srcH, outputWidth, outputHeight);

      const pctDl = Math.round(i / n * 40);
      prog(pctDl, `클립 다운로드 중 (${i + 1}/${n})...`);

      // Download trimmed clip from server
      const clipUrl =
        `/api/videos/clip/${videoId}` +
        `?start=${clip.srcStart.toFixed(3)}&end=${clip.srcEnd.toFixed(3)}`;
      const { data: rawData, headers } = await fetchBytes(clipUrl);
      const hasAudio = headers.get('X-Has-Audio') === '1';

      const rawName = `__raw_${i}.mp4`;
      await ff.writeFile(rawName, rawData);

      prog(Math.round((i + 0.5) / n * 40), `클립 스케일링 중 (${i + 1}/${n})...`);

      // Apply spatial transform
      const scaledName = `clip_${i}.mp4`;
      const audioArgs  = hasAudio
        ? ['-c:a', 'aac', '-b:a', '128k']
        : ['-an'];

      await ff.exec([
        '-i', rawName,
        '-vf', `${scaleFilter},setsar=1/1`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10',
        ...audioArgs,
        scaledName,
      ]);

      // Free raw download from VFS immediately to save memory
      await ff.deleteFile(rawName);

      prog(Math.round((i + 1) / n * 40), `클립 완료 (${i + 1}/${n})`);
      scaledClips.push({ name: scaledName, clip, overlayX, overlayY, hasAudio });
    }

    // ── Load fonts needed by subtitle clips ──────────────────────────────────
    prog(42, '폰트 로딩 중...');
    const fontVfsMap = {}; // fontFamily+bold → VFS path like /fonts/f0.ttf
    await (async () => {
      let fontIdx = 0;
      for (const subClip of allSubtitleClips) {
        if (!subClip.text) continue;
        const key = `${subClip.fontFamily || ''}_${subClip.bold ? '1' : '0'}`;
        if (key in fontVfsMap) continue;

        const url =
          `/api/fonts/resolve` +
          `?family=${encodeURIComponent(subClip.fontFamily || '')}` +
          `&bold=${subClip.bold ? '1' : '0'}`;
        try {
          const { data } = await fetchBytes(url);
          const vfsPath = `/fonts/f${fontIdx}.ttf`;
          await ff.createDir('/fonts').catch(() => {}); // ignore if exists
          await ff.writeFile(vfsPath, data);
          fontVfsMap[key] = vfsPath;
          fontIdx++;
        } catch (e) {
          // Font unavailable on server — FFmpeg.wasm will use its built-in default
          fontVfsMap[key] = null;
        }
      }
    })();

    // ── Load background audio clips ──────────────────────────────────────────
    prog(44, '오디오 로딩 중...');
    const audioVfsNames = []; // parallel to allAudioClips
    for (let i = 0; i < allAudioClips.length; i++) {
      const audioClip = allAudioClips[i];
      try {
        const { data } = await fetchBytes(audioClip.src);
        const name = `__audio_${i}${audioClip.src.match(/\.[^.]+$/)?.[0] || '.mp3'}`;
        await ff.writeFile(name, data);
        audioVfsNames.push(name);
      } catch (e) {
        audioVfsNames.push(null);
      }
    }

    // ── Phase 2: Composite ────────────────────────────────────────────────────
    prog(46, '합성 준비 중...');

    const cmd       = [];  // flat args array for ff.exec()
    const filterParts      = [];
    const audioFilterParts = [];
    const allAudioLabels   = [];

    // Add video clip inputs
    scaledClips.forEach(({ name }) => cmd.push('-i', name));

    // Add background audio inputs
    const bgAudioOffset = scaledClips.length;
    let bgAudioCount = 0;
    allAudioClips.forEach((_, i) => {
      if (audioVfsNames[i]) {
        cmd.push('-i', audioVfsNames[i]);
        bgAudioCount++;
      }
    });

    // Black canvas base
    filterParts.push(
      `color=c=black:size=${outputWidth}x${outputHeight}` +
      `:duration=${totalDuration}:rate=${fps}[bg]`
    );

    // Overlay each video clip
    let currentBase = '[bg]';
    scaledClips.forEach(({ clip, overlayX, overlayY, hasAudio }, i) => {
      filterParts.push(`[${i}:v]setpts=PTS+${clip.startTime}/TB[tv${i}]`);
      filterParts.push(
        `${currentBase}[tv${i}]overlay=x=${overlayX}:y=${overlayY}` +
        `:enable='between(t,${clip.startTime},${clip.endTime})'[base${i}]`
      );
      currentBase = `[base${i}]`;

      if (hasAudio) {
        const delayMs = Math.round(clip.startTime * 1000);
        audioFilterParts.push(`[${i}:a]adelay=${delayMs}:all=1[av${i}]`);
        allAudioLabels.push(`[av${i}]`);
      }
    });

    // Subtitle drawtext filters
    let subtitleBase = currentBase;
    let subtitleIdx  = 0;
    allSubtitleClips.forEach(clip => {
      if (!clip.text) return;
      const escaped = clip.text
        .replace(/%/g, '%%')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n');
      const colorHex = rgbToFFmpegColor(clip.color || '#ffffff');
      const fontSize  = clip.fontSize || 48;
      const fontKey   = `${clip.fontFamily || ''}_${clip.bold ? '1' : '0'}`;
      const fontFile  = fontVfsMap[fontKey];

      const align = clip.align || 'center';
      let xExpr;
      if (align === 'left')       xExpr = String(clip.x || 0);
      else if (align === 'right') xExpr = `${clip.x ?? outputWidth}-(text_w)`;
      else                        xExpr = `${clip.x || Math.round(outputWidth / 2)}-(text_w/2)`;

      let drawParts = [];
      if (fontFile) drawParts.push(`fontfile='${fontFile}'`);
      drawParts.push(`text='${escaped}'`);
      drawParts.push(`fontsize=${fontSize}`);
      drawParts.push(`fontcolor=${colorHex}`);
      drawParts.push(`x=${xExpr}`, `y=${clip.y ?? 100}`);

      const bgColor = clip.backgroundColor;
      if (bgColor && bgColor !== 'none') {
        const ffmpegBg = rgbaToFFmpegColor(bgColor);
        if (ffmpegBg) {
          const pad = clip.backgroundPadding || 16;
          drawParts.push(`box=1`, `boxcolor=${ffmpegBg}`, `boxborderw=${pad}`);
        }
      }

      drawParts.push(`enable='between(t,${clip.startTime},${clip.endTime})'`);

      filterParts.push(
        `${subtitleBase}drawtext=${drawParts.join(':')}[subs${subtitleIdx}]`
      );
      subtitleBase = `[subs${subtitleIdx}]`;
      subtitleIdx++;
    });

    // Background audio (background music layers)
    let bgAudioIdx = 0;
    allAudioClips.forEach((clip, i) => {
      if (!audioVfsNames[i]) return;
      const inputIdx = bgAudioOffset + bgAudioIdx;
      const vol = clip.volume !== undefined ? clip.volume : 0.8;
      audioFilterParts.push(`[${inputIdx}:a]volume=${vol}[abg${i}]`);
      allAudioLabels.push(`[abg${i}]`);
      bgAudioIdx++;
    });

    // Mix all audio streams
    let audioMapLabel = null;
    if (allAudioLabels.length === 1) {
      audioMapLabel = allAudioLabels[0].replace(/[\[\]]/g, '');
    } else if (allAudioLabels.length > 1) {
      audioFilterParts.push(
        `${allAudioLabels.join('')}amix=inputs=${allAudioLabels.length}` +
        `:duration=longest:normalize=0[amixed]`
      );
      audioMapLabel = 'amixed';
    }

    const filterGraph    = [...filterParts, ...audioFilterParts].join(';');
    const finalVidLabel  = (subtitleIdx > 0 ? subtitleBase : currentBase)
                            .replace(/[\[\]]/g, '');

    // -map args
    cmd.push('-filter_complex', filterGraph);
    cmd.push('-map', `[${finalVidLabel}]`);
    if (audioMapLabel) cmd.push('-map', `[${audioMapLabel}]`);

    // Output codec options
    cmd.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    cmd.push('-r', String(fps));
    cmd.push('-pix_fmt', 'yuv420p');
    cmd.push('-t', String(totalDuration));
    if (audioMapLabel) cmd.push('-c:a', 'aac', '-b:a', '192k');
    else               cmd.push('-an');
    cmd.push('output.mp4');

    // Progress callback for Phase 2
    const onP2Progress = ({ progress }) => {
      const pct = Math.min(99, 46 + Math.round((progress || 0) * 53));
      prog(pct, `합성 렌더링 중 (${Math.round((progress || 0) * 100)}%)`);
    };
    ff.on('progress', onP2Progress);

    prog(47, '합성 렌더링 시작...');
    await ff.exec(cmd);

    ff.off('progress', onP2Progress);
    prog(99, '출력 파일 읽는 중...');

    // Read output from VFS → Blob URL
    const outData = await ff.readFile('output.mp4');
    const blob    = new Blob([outData.buffer], { type: 'video/mp4' });
    const url     = URL.createObjectURL(blob);

    // Clean up VFS
    await ff.deleteFile('output.mp4').catch(() => {});
    for (const { name } of scaledClips) await ff.deleteFile(name).catch(() => {});
    for (const name of audioVfsNames) if (name) await ff.deleteFile(name).catch(() => {});

    prog(100, '완료');
    return url;
  }

  return { exportVideo };
})();
