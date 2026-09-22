# FFmpeg Lite — Video/Audio Conversion API

Self-hosted FFmpeg with a REST API. Upload media, run any FFmpeg command, and download the result — all with persistent storage on a Railway volume.

## Deploy and Host

Host your own FFmpeg on Railway. This template provisions an FFmpeg 7 conversion API with persistent storage for input and output media.

[![Deploy to Railway](https://railway.app/button.svg)](https://railway.com/deploy/Sqvme0)

## Why Deploy

FFmpeg is the universal media transcoding engine. Running it on Railway gives you a durable, globally reachable endpoint with:

- **Persistent media** — input and output files survive restarts on a Railway volume
- **Pure REST API** — integrate from any language, no UI required
- **Async jobs** — start a conversion and poll status; long jobs are safe
- **Batteries included** — FFmpeg 7.1 with x264, AAC, MP3, and all common codecs
- **Hobby-safe** — software encoding on a small plan handles light workloads fine

## Common Use Cases

- **Media transcoding for apps** — produce HLS/MP4/WEBM renditions for your player
- **Audio extraction and downmixing** — pull MP3/AAC from video, resample for speech models
- **Thumbnail generation** — extract frames and posters for library UIs
- **Format normalization** — convert codecs before uploads and archival
- **Paired with your stack** — a conversion endpoint for Wizarr, Sharely, or any media backend

### Deployment Dependencies

This template is self-contained — no external services required. All media persists on the service's volume at `/data`. The instance is ready out of the box on one-click deploy.

**After first successful deploy:**

1. Check the instance is up: `curl https://<your-domain>/health` (returns `{"ok":true,...}`)
2. Upload a file: `curl -X PUT "https://<your-domain>/api/upload?name=in.mp4" --data-binary @sample.mp4`

## About Hosting

FFmpeg Lite runs as a single container on Railway. Media persists on a Railway volume at `/data`. The API listens on port 8080 (mapped to your Railway public domain).

## Features

- **Any FFmpeg command** — pass `args` as raw ffmpeg options applied after `-i <input>`
- **Async job queue** — job ids, statuses, durations, and a 16KB log tail per job
- **Upload/download** — `PUT /api/upload` (up to 2GB) and `GET /dl/<path>` streaming
- **Concurrency guard** — `MAX_CONCURRENT` cap, returns 429 when saturated
- **Job timeout** — per-job cap (`JOB_TIMEOUT_MS`, 30 min default)
- **Health check** — `/health` reports ffmpeg version and active job count

## Dependencies for

- **No external services required** — FFmpeg Lite runs standalone
- **Volume** — `/data` volume required for input + output media

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API port. Railway maps this to the public domain. | `8080` |
| `DATA_DIR` | Media directory. Must match the volume mount. | `/data` |
| `MAX_CONCURRENT` | Max simultaneous conversion jobs. | `2` |
| `JOB_TIMEOUT_MS` | Per-job timeout before the process is killed. | `1800000` |

## Quick Start

After deployment, the API is ready at your Railway public domain:

```bash
# Check health
curl https://your-domain.up.railway.app/health

# Upload an input file
curl -X PUT "https://your-domain.up.railway.app/api/upload?name=in.mp4" \
  --data-binary @in.mp4

# Start a conversion (extract MP3 audio)
curl -X POST https://your-domain.up.railway.app/api/convert \
  -H 'Content-Type: application/json' \
  -d '{"input":"in.mp4","args":["-vn","-c:a","libmp3lame"],"output":"out/in.mp3"}'
# -> {"ok":true,"job":{"id":"..."}}

# Poll job status
curl https://your-domain.up.railway.app/api/jobs/<id>

# Download the result
curl -OJ https://your-domain.up.railway.app/dl/out/in.mp3

# List jobs / running count
curl https://your-domain.up.railway.app/api/jobs

# Delete a media file
curl -X DELETE https://your-domain.up.railway.app/api/files/out/in.mp3
```

`args` holds raw FFmpeg output options, applied as `ffmpeg -y -i <input> <args> [output]`.

## License

MIT
