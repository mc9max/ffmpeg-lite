# FFmpeg Lite — HTTP API wrapper around the jrottenberg/ffmpeg binary.
# 7.1.2-ubuntu2404 = ffmpeg 7.1.2 compiled on Ubuntu 24.04 (noble) with
# standard software codecs (libx264/libx265/vorbis/opus/vpx/aom — no hw accel),
# exactly what Railway hobby instances provide (no GPU).
FROM jrottenberg/ffmpeg:7.1.2-ubuntu2404

# Node.js for the zero-dependency HTTP wrapper (spec: POST /api/convert).
# noble ships Node 18.x — sufficient for this server; no npm install needed.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends nodejs \
    && ln -sf /usr/bin/node /usr/local/bin/node \
    && node --version \
    && rm -rf /var/lib/apt/lists/*

# Persistent working dir for inputs/outputs (Railway volume mounts here).
RUN mkdir -p /data
WORKDIR /data

# OCI labels: link the ghcr package to its source repo on first push
# (cannot be set retroactively via REST), and document the image.
LABEL org.opencontainers.image.source=https://github.com/mc9max/ffmpeg-lite
LABEL org.opencontainers.image.description="FFmpeg Lite — self-hosted FFmpeg REST API (upload, convert, download) with persistent volume storage"
LABEL org.opencontainers.image.licenses=MIT
LABEL org.opencontainers.image.title=ffmpeg-lite

# Thin API server. The base image sets ENTRYPOINT ["ffmpeg"], so ours
# overrides both ENTRYPOINT and CMD — the container runs the node server,
# and ffmpeg is still available as a binary for the API to shell out to.
COPY server.js /opt/ffserver/server.js
ENV DATA_DIR=/data

EXPOSE 8080
ENV PORT=8080

# Health check uses node (always present; wget/curl absent in this base).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" || exit 1

ENTRYPOINT ["node"]
CMD ["/opt/ffserver/server.js"]