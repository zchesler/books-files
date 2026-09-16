import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TARGET_FORMATS = new Set(['epub', 'mobi', 'azw3']);
// Formats Calibre can read. KFX needs a plugin, so it's left out; DRM-protected
// files of any format are served as-is but fail to convert.
export const SOURCE_FORMATS = new Set(['epub', 'mobi', 'azw', 'azw3', 'pdf', 'fb2', 'lit', 'pdb', 'docx', 'rtf', 'txt']);

export const CONTENT_TYPES = {
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw: 'application/vnd.amazon.ebook',
  azw3: 'application/vnd.amazon.ebook',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

// Resolves a path relative to the ebook root, following symlinks, and refuses
// anything that ends up outside the root or isn't an ebook file.
export async function resolveSource(realRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
  let real;
  try {
    real = await fs.promises.realpath(path.resolve(realRoot, relPath));
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + path.sep)) return null;
  const ext = path.extname(real).slice(1).toLowerCase();
  if (!SOURCE_FORMATS.has(ext)) return null;
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return null;
  return { path: real, ext, stat };
}

// Changes whenever the source file changes, so an updated book is reconverted.
export function cacheKey(source, format) {
  return crypto
    .createHash('sha256')
    .update(`${source.path}\0${source.stat.size}\0${source.stat.mtimeMs}\0${format}`)
    .digest('hex')
    .slice(0, 32);
}

export function describeFailure(output, code, signal) {
  if (signal === 'SIGKILL') return 'Conversion took too long';
  if (/DRMError|locked with DRM|DRM[- ]protected/i.test(output)) return 'This book is DRM-protected and can’t be converted';
  const lastLine = output.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return `Conversion failed (exit ${code})${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}`;
}

export function tokenMatches(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(header || ''));
  return Boolean(token) && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
