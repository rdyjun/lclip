FROM node:20-alpine

# System FFmpeg + fontconfig + Korean fonts for subtitle drawtext
# Same fonts offered in the editor UI — TTF versions downloaded from Google Fonts
RUN apk add --no-cache ffmpeg fontconfig curl && \
    F=/usr/share/fonts/korean && mkdir -p $F && \
    B="https://github.com/google/fonts/raw/main/ofl" && \
    # Required fallback — build fails if these are unavailable
    curl -fsSL "$B/nanumgothic/NanumGothic-Regular.ttf"             -o $F/NanumGothic-Regular.ttf && \
    curl -fsSL "$B/nanumgothic/NanumGothic-Bold.ttf"                -o $F/NanumGothic-Bold.ttf && \
    # Optional — best-effort (|| true so build succeeds even if CDN hiccup)
    curl -fsSL "$B/nanummyeongjo/NanumMyeongjo-Regular.ttf"         -o $F/NanumMyeongjo-Regular.ttf      || true && \
    curl -fsSL "$B/nanummyeongjo/NanumMyeongjo-Bold.ttf"            -o $F/NanumMyeongjo-Bold.ttf         || true && \
    curl -fsSL "$B/gowundodum/GowunDodum-Regular.ttf"               -o $F/GowunDodum-Regular.ttf         || true && \
    curl -fsSL "$B/gowunbatang/GowunBatang-Regular.ttf"             -o $F/GowunBatang-Regular.ttf        || true && \
    curl -fsSL "$B/blackhansans/BlackHanSans-Regular.ttf"           -o $F/BlackHanSans-Regular.ttf       || true && \
    curl -fsSL "$B/dohyeon/DoHyeon-Regular.ttf"                     -o $F/DoHyeon-Regular.ttf            || true && \
    curl -fsSL "$B/ibmplexsanskr/IBMPlexSansKR-Regular.ttf"        -o $F/IBMPlexSansKR-Regular.ttf      || true && \
    curl -fsSL "$B/ibmplexsanskr/IBMPlexSansKR-SemiBold.ttf"       -o $F/IBMPlexSansKR-Bold.ttf         || true && \
    curl -fsSL "$B/jua/Jua-Regular.ttf"                             -o $F/Jua-Regular.ttf                || true && \
    curl -fsSL "$B/notosanskr/static/NotoSansKR-Regular.ttf"        -o $F/NotoSansKR-Regular.ttf         || true && \
    curl -fsSL "$B/notosanskr/static/NotoSansKR-Bold.ttf"           -o $F/NotoSansKR-Bold.ttf            || true && \
    fc-cache -fv

WORKDIR /app

# Install production dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create default storage directories (can be overridden by volume mounts)
RUN mkdir -p \
    /app/data \
    /app/uploads/videos \
    /app/uploads/audio \
    /app/uploads/thumbnails \
    /app/uploads/tmp \
    /app/exports

EXPOSE 3000

# Tell fluent-ffmpeg to use system binaries (takes priority over ffmpeg-static)
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV NODE_ENV=production

CMD ["node", "server.js"]
