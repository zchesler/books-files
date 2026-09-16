import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cacheKey, describeFailure, resolveSource, tokenMatches } from '../src/lib.js';

function makeLibrary() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'books-files-')));
  fs.mkdirSync(path.join(root, 'Author', 'Book'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Author', 'Book', 'Book.azw'), 'book');
  fs.writeFileSync(path.join(root, 'Author', 'Book', 'cover.jpg'), 'jpg');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'books-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.epub'), 'secret');
  return { root, outside };
}

test('resolves ebooks inside the library', async () => {
  const { root } = makeLibrary();
  const source = await resolveSource(root, 'Author/Book/Book.azw');
  assert.equal(source.ext, 'azw');
  assert.equal(source.path, path.join(root, 'Author', 'Book', 'Book.azw'));
});

test('refuses paths outside the library, non-ebooks and missing files', async () => {
  const { root, outside } = makeLibrary();
  assert.equal(await resolveSource(root, '../etc/passwd'), null);
  assert.equal(await resolveSource(root, path.join(outside, 'secret.epub')), null);
  assert.equal(await resolveSource(root, `../${path.basename(outside)}/secret.epub`), null);
  assert.equal(await resolveSource(root, 'Author/Book/cover.jpg'), null);
  assert.equal(await resolveSource(root, 'Author/Book/missing.epub'), null);
  assert.equal(await resolveSource(root, 'Author/Book'), null);
  assert.equal(await resolveSource(root, ''), null);
  assert.equal(await resolveSource(root, 'Author/Book/Book.azw\0.epub'), null);
});

test('refuses symlinks that point outside the library', async (t) => {
  const { root, outside } = makeLibrary();
  try {
    fs.symlinkSync(path.join(outside, 'secret.epub'), path.join(root, 'Author', 'link.epub'));
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  assert.equal(await resolveSource(root, 'Author/link.epub'), null);
});

test('cache key changes when the file or format changes', async () => {
  const { root } = makeLibrary();
  const file = path.join(root, 'Author', 'Book', 'Book.azw');
  const before = await resolveSource(root, 'Author/Book/Book.azw');
  assert.notEqual(cacheKey(before, 'epub'), cacheKey(before, 'mobi'));
  fs.writeFileSync(file, 'a longer version of the book');
  const after = await resolveSource(root, 'Author/Book/Book.azw');
  assert.notEqual(cacheKey(before, 'epub'), cacheKey(after, 'epub'));
});

test('explains conversion failures', () => {
  assert.match(describeFailure('calibre.ebooks.DRMError: This file is locked with DRM', 1, null), /DRM-protected/);
  assert.equal(describeFailure('', null, 'SIGKILL'), 'Conversion took too long');
  assert.match(describeFailure('Traceback...\nValueError: bad input\n', 1, null), /exit 1\): ValueError: bad input/);
});

test('checks the bearer token exactly', () => {
  const token = 'a'.repeat(40);
  assert.equal(tokenMatches(`Bearer ${token}`, token), true);
  assert.equal(tokenMatches(`Bearer ${token}x`, token), false);
  assert.equal(tokenMatches(undefined, token), false);
  assert.equal(tokenMatches('Bearer ', ''), false);
});
