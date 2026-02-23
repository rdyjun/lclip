FROM node:20-alpine

# System FFmpeg — more reliable than ffmpeg-static on musl/Alpine
RUN apk add --no-cache ffmpeg

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
