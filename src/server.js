import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CONTENT_TYPES, TARGET_FORMATS, cacheKey, describeFailure, resolveSource, tokenMatches } from './lib.js';

const PORT = Number(process.env.PORT || 8790);
const EBOOK_ROOT = process.env.EBOOK_ROOT || '/ebooks';
const CACHE_DIR = process.env.CACHE_DIR || '/cache';
const TOKEN = process.env.FILES_TOKEN || '';
const MAX_CONVERSIONS = Math.max(1, Number(process.env.MAX_CONVERSIONS || 2));
const CONVERT_TIMEOUT_MS = 10 * 60_000;
// A failed conversion is remembered briefly so polling doesn't retry it in a loop.
const FAILURE_TTL_MS = 10 * 60_000;
const CACHE_MAX_AGE_MS = 14 * 24 * 3600_000;

if (TOKEN.length < 32) {
  console.error('[books-files] FILES_TOKEN must be at least 32 characters');
  process.exit(1);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
const realRoot = fs.realpathSync(EBOOK_ROOT);
const log = (message) => console.log(`[books-files] ${message}`);

/* ---------- Conversion jobs ---------- */

const jobs = new Map(); // cache key -> { state: 'converting' | 'failed', error, at }
let running = 0;
const waiting = [];

async function withSlot(fn) {
  if (running >= MAX_CONVERSIONS) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function runEbookConvert(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn('ebook-convert', [input, output], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), CONVERT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(describeFailure(tail, code, signal)));
    });
  });
}

function cachedPath(key, format) {
  return path.join(CACHE_DIR, `${key}.${format}`);
}

function startConversion(source, format, key) {
  const out = cachedPath(key, format);
  // ebook-convert picks the output format from the extension, so the partial
  // file keeps it too.
  const partial = path.join(CACHE_DIR, `${key}.partial.${format}`);
  const started = Date.now();
  jobs.set(key, { state: 'converting', at: started });
  log(`converting ${path.relative(realRoot, source.path)} -> ${format}`);
  withSlot(() => runEbookConvert(source.path, partial))
    .then(async () => {
      await fs.promises.rename(partial, out);
      jobs.delete(key);
      log(`converted ${path.basename(source.path)} -> ${format} in ${Math.round((Date.now() - started) / 1000)}s`);
    })
    .catch(async (err) => {
      await fs.promises.rm(partial, { force: true });
      jobs.set(key, { state: 'failed', error: err.message, at: Date.now() });
      log(`failed ${path.basename(source.path)} -> ${format}: ${err.message}`);
    });
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function prepare(relPath, format) {
  const source = await resolveSource(realRoot, relPath);
  if (!source) return [404, { error: 'not_found' }];
  if (format === 'original' || format === source.ext) return [200, { state: 'ready', extension: source.ext }];
  if (!TARGET_FORMATS.has(format)) return [400, { error: 'bad_format' }];

  const key = cacheKey(source, format);
  if (await exists(cachedPath(key, format))) return [200, { state: 'ready', extension: format }];
  const job = jobs.get(key);
  if (job?.state === 'converting') return [200, { state: 'converting' }];
  if (job?.state === 'failed' && Date.now() - job.at < FAILURE_TTL_MS) return [200, { state: 'failed', error: job.error }];
  startConversion(source, format, key);
  return [200, { state: 'converting' }];
}

async function serveFile(res, relPath, format) {
  const source = await resolveSource(realRoot, relPath);
  if (!source) return sendJson(res, 404, { error: 'not_found' });

  let file = source.path;
  let extension = source.ext;
  if (format !== 'original' && format !== source.ext) {
    if (!TARGET_FORMATS.has(format)) return sendJson(res, 400, { error: 'bad_format' });
    file = cachedPath(cacheKey(source, format), format);
    extension = format;
    if (!(await exists(file))) return sendJson(res, 409, { error: 'not_ready' });
    const now = new Date();
    await fs.promises.utimes(file, now, now).catch(() => {}); // keeps often-used conversions out of cleanup
  }

  const stat = await fs.promises.stat(file);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-File-Extension': extension,
  });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

/* ---------- Cache cleanup ---------- */

async function cleanCache({ removePartials = false } = {}) {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  let removed = 0;
  for (const name of await fs.promises.readdir(CACHE_DIR)) {
    const file = path.join(CACHE_DIR, name);
    try {
      const stat = await fs.promises.stat(file);
      if ((removePartials && name.includes('.partial.')) || stat.mtimeMs < cutoff) {
        await fs.promises.rm(file, { force: true });
        removed++;
      }
    } catch {
      // vanished between readdir and stat
    }
  }
  if (removed) log(`removed ${removed} old cached file(s)`);
}

/* ---------- HTTP ---------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (!tokenMatches(req.headers.authorization, TOKEN)) return sendJson(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/v1/prepare') {
      const body = await readJson(req);
      const [status, result] = await prepare(body.path, String(body.format || 'original'));
      return sendJson(res, status, result);
    }
    if (req.method === 'GET' && url.pathname === '/v1/file') {
      return await serveFile(res, url.searchParams.get('path'), url.searchParams.get('format') || 'original');
    }
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    log(`${req.method} ${url.pathname} failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.destroy();
  }
});

await cleanCache({ removePartials: true });
setInterval(() => cleanCache().catch((err) => log(`cache cleanup failed: ${err.message}`)), 6 * 3600_000).unref();

server.listen(PORT, '0.0.0.0', () => log(`serving ${realRoot} on 0.0.0.0:${PORT} (up to ${MAX_CONVERSIONS} conversions at once)`));
