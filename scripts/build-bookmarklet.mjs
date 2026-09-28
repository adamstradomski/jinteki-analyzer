#!/usr/bin/env node
// Builds the Trace bookmarklet from public/trace/bookmarklet.src.js and writes it into the href
// of <a id="bookmarkletBtn"> in public/trace/index.html. Nothing else in the page is touched.
//
//   node scripts/build-bookmarklet.mjs          rewrite the href (no-op if already current)
//   node scripts/build-bookmarklet.mjs --check  exit 1 if the href differs from the build (CI)
//
// "Minifying" is a fixed transform (see the header of bookmarklet.src.js): drop full-line //
// comments, trim each line, join the lines with nothing, then encodeURIComponent. The source is
// written already minified, so this reproduces the shipped code exactly without a dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const srcPath = fileURLToPath(new URL('public/trace/bookmarklet.src.js', root));
const htmlPath = fileURLToPath(new URL('public/trace/index.html', root));
const check = process.argv.includes('--check');

function minify(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('');
}

function buildHref(source) {
  return 'javascript:' + encodeURIComponent(minify(source));
}

// The href attribute that follows id="bookmarkletBtn" inside the same start tag.
const HREF_RE = /(<a\b[^>]*\bid="bookmarkletBtn"[^>]*?\bhref=")([^"]*)(")/;

const html = readFileSync(htmlPath, 'utf8');
const match = html.match(HREF_RE);
if (!match) {
  console.error('build-bookmarklet: no href found on #bookmarkletBtn in public/trace/index.html');
  process.exit(2);
}
const current = match[2];
const built = buildHref(readFileSync(srcPath, 'utf8'));

// retargetBookmarklet() in public/trace/app.js string-replaces this encoded substring.
const prodTarget = encodeURIComponent('"https://jinteki.win/trace/#log="');
if (!built.includes(prodTarget)) {
  console.error('build-bookmarklet: built href lacks ' + prodTarget + ' (needed by retargetBookmarklet in app.js)');
  process.exit(1);
}

if (current === built) {
  console.log('build-bookmarklet: href is up to date (' + built.length + ' chars)');
  process.exit(0);
}
if (check) {
  let i = 0;
  while (i < current.length && current[i] === built[i]) i++;
  console.error('build-bookmarklet: href in public/trace/index.html is out of date with public/trace/bookmarklet.src.js');
  console.error('  first difference at char ' + i + ':');
  console.error('  html : ' + JSON.stringify(current.slice(Math.max(0, i - 40), i + 40)));
  console.error('  build: ' + JSON.stringify(built.slice(Math.max(0, i - 40), i + 40)));
  console.error('  run: node scripts/build-bookmarklet.mjs');
  process.exit(1);
}
writeFileSync(htmlPath, html.slice(0, match.index) + match[1] + built + match[3] + html.slice(match.index + match[0].length));
console.log('build-bookmarklet: rewrote the #bookmarkletBtn href (' + built.length + ' chars)');
