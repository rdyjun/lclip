FROM node:20-alpine

# System FFmpeg + fontconfig + Korean fonts for subtitle drawtext
RUN apk add --no-cache ffmpeg fontconfig curl && \
    mkdir -p /usr/share/fonts/nanum && \
    curl -fsSL -o /usr/share/fonts/nanum/NanumGothic-Regular.ttf \
      "https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf" && \
    curl -fsSL -o /usr/share/fonts/nanum/NanumGothic-Bold.ttf \
      "https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Bold.ttf" && \
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
