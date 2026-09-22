'use strict';
// FFmpeg Lite API server (zero-dependency; runs on noble's Node 18).
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = fs.realpathSync(process.env.DATA_DIR || '/data');
const FFMPEG = 'ffmpeg';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 1800000);
const MAX_BODY = 10 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const LOG_CAP = 16384;

const jobs = new Map();
let running = 0;

function safeName(name) {
  const base = String(path.basename(name)).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'unnamed';
}
function inside(p) {
  const a = fs.realpathSync(path.dirname(p));
  return a === DATA_DIR || DATA_DIR.startsWith(a);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function tail(s) { return s.length > LOG_CAP ? s.slice(-LOG_CAP) : s; }

function runJob(job, argv) {
  const t0 = Date.now();
  running++;
  const child = spawn(FFMPEG, argv, { cwd: DATA_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const push = (chunk) => { log = tail(log + chunk.toString()); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  const timer = setTimeout(() => { job.error = 'timed_out'; child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  child.on('error', (e) => { clearTimeout(timer); job.error = e.code === 'ENOENT' ? 'ffmpeg binary not found in image' : e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    running--;
    job.log = tail(log);
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - t0;
    if (code === 0 && !job.error) {
      job.status = 'done';
      if (job.out && fs.existsSync(job.outPath)) job.outBytes = fs.statSync(job.outPath).size;
    } else {
      job.status = 'failed';
      job.error = job.error || ('ffmpeg exit ' + code);
    }
  });
}
function readBody(req, cap, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > cap) { req.destroy(); return cb(new Error('payload too large')); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', cb);
}

function handleConvert(body, res) {
  let req = {};
  try { req = JSON.parse(body.toString() || '{}'); }
  catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON body' }); }

  const input = String(req.input || req.file || '').replace(/^\/+/, '');
  if (!input) return json(res, 400, { ok: false, error: 'missing input' });
  const inPath = path.join(DATA_DIR, input);
  try { if (!fs.statSync(inPath).isFile()) throw new Error('not a file'); }
  catch (e) { return json(res, 404, { ok: false, error: 'input not found in /data: ' + input }); }

  let args = req.args;
  if (typeof args === 'string') args = args.split(/\s+/).filter(Boolean);
  if (!Array.isArray(args)) args = [];
  if (!args.every((a) => typeof a === 'string')) return json(res, 400, { ok: false, error: 'args must be a string or array of strings' });

  const out = req.output ? String(req.output).replace(/^\/+/, '') : null;
  let outPath = null;
  if (out) {
    outPath = path.join(DATA_DIR, out);
    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); }
    catch (e) { return json(res, 500, { ok: false, error: 'cannot create output path' }); }
  }

  if (running >= MAX_CONCURRENT) {
    return json(res, 429, { ok: false, error: 'too many jobs running (limit ' + MAX_CONCURRENT + ')' });
  }

  // args = output-side ffmpeg options, applied after the input:
  //   ffmpeg -y -i <input> <args...> [output]
  const argv = ['-y', '-i', inPath].concat(args);
  if (out) argv.push(outPath);

  const id = newId();
  const job = { id, status: 'running', input, out, outPath: outPath || null, startedAt: new Date().toISOString(), log: '' };
  jobs.set(id, job);
  runJob(job, argv);
  return json(res, 202, { ok: true, job: { id, status: job.status, input: job.input, output: out ? path.relative(DATA_DIR, outPath) : null } });
}

function handleList(res) {
  json(res, 200, { ok: true, jobs: Array.from(jobs.values()).map((j) => ({ id: j.id, status: j.status, input: j.input, output: j.out, startedAt: j.startedAt, durationMs: j.durationMs, error: j.error })), running: running, maxConcurrent: MAX_CONCURRENT });
}

function handleJob(id, res) {
  const job = jobs.get(id);
  if (!job) return json(res, 404, { ok: false, error: 'job not found' });
  const view = { ok: true, job: { id: job.id, status: job.status, input: job.input, output: job.out, startedAt: job.startedAt, finishedAt: job.finishedAt, durationMs: job.durationMs, outBytes: job.outBytes, error: job.error, log: job.log } };
  return json(res, 200, view);
}

function handleUpload(req, res) {
  const url = new URL(req.url, 'http://x');
  const name = safeName(url.searchParams.get('name') || 'upload.bin');
  const dest = path.join(DATA_DIR, name);
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) { return json(res, 500, { ok: false, error: 'cannot create dir' }); }
  const tmp = dest + '.part';
  const stream = fs.createWriteStream(tmp);
  let total = 0;
  req.on('data', (c) => { total += c.length; if (total > MAX_UPLOAD) { stream.destroy(); req.destroy(); return json(res, 413, { ok: false, error: 'upload too large' }); } });
  req.pipe(stream);
  req.on('error', (e) => { stream.destroy(); json(res, 500, { ok: false, error: e.message }); });
  stream.on('close', () => { fs.renameSync(tmp, dest); json(res, 201, { ok: true, file: name, bytes: total }); });
  stream.on('error', (e) => { json(res, 500, { ok: false, error: e.message }); });
}

function handleDownload(url, res) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/dl\//, ''));
  const full = path.join(DATA_DIR, rel);
  try {
    if (!full.startsWith(DATA_DIR + path.sep) || !fs.statSync(full).isFile()) throw new Error('x');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { json(res, 404, { ok: false, error: 'file not found' }); }
}

let FF_VER = '';
function handleDelete(url, res) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/api\/files\//, ''));
  if (!rel || rel === '.' || rel === '/') return json(res, 400, { ok: false, error: 'bad path' });
  const full = path.join(DATA_DIR, rel);
  if (!full.startsWith(DATA_DIR + path.sep)) return json(res, 400, { ok: false, error: 'bad path' });
  try {
    const st = fs.statSync(full); // throws if missing -> 404
    fs.rmSync(full, { recursive: true, maxRetries: 3 });
    json(res, 200, { ok: true, deleted: rel, bytes: st.size });
  } catch (e) { json(res, 404, { ok: false, error: 'not found: ' + rel }); }
}

function ffVersion(cb) {
  if (FF_VER) return cb(FF_VER);
  const c = spawn(FFMPEG, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let d = '';
  const acc = (ch) => { d += ch.toString(); };
  c.stdout.on('data', acc);
  c.stderr.on('data', acc);
  c.on('error', () => cb('unknown'));
  c.on('close', () => { FF_VER = (d.split('\n')[0] || 'unknown').trim(); cb(FF_VER); });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/health' || p === '/')) {
      return ffVersion((ver) => json(res, 200, { ok: true, service: 'ffmpeg-lite', ffmpeg: ver, data_dir: DATA_DIR, running: running }));
    }
    if (req.method === 'POST' && p === '/api/convert') {
      return readBody(req, MAX_BODY, (err, body) => { if (err) return json(res, 413, { ok: false, error: err.message }); return handleConvert(body, res); });
    }
    if (req.method === 'GET' && p === '/api/jobs') return handleList(res);
    const jm = p.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && jm) return handleJob(jm[1], res);
    const fm = p.match(/^\/api\/files\/.+$/);
    if (req.method === 'DELETE' && fm) return handleDelete(url, res);
    if (req.method === 'PUT' && p === '/api/upload') return handleUpload(req, res);
    if (req.method === 'GET' && p.startsWith('/dl/')) return handleDownload(url, res);
    json(res, 404, { ok: false, error: 'not found', endpoints: ['GET /health', 'POST /api/convert', 'GET /api/jobs', 'GET /api/jobs/<id>', 'PUT /api/upload?name=', 'DELETE /api/files/<path>', 'GET /dl/<path>'] });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => { console.log('ffmpeg-lite listening on 0.0.0.0:' + PORT + ' (data=' + DATA_DIR + ')'); });
server.on('error', (e) => { console.error('server error', e.code, e.message); process.exit(1); });
