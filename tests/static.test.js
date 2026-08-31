'use strict';
// Checks that don't need to run the app: does app.js parse, is index.html balanced, do the
// two halves of the cache-buster still agree, and does every id app.js reaches for actually
// exist in the markup.
//
// The version check is the one that earns its keep. index.html and app.js are cached
// independently by iOS Safari, so shipping is a paired edit: BUILD_STAMP in app.js and the
// ?v=N on its <script> tag have to move together. Bump one and forget the other and the app
// still works perfectly on a desktop while the phone silently runs yesterday's code — which
// is indistinguishable, from the phone, from the change simply not working.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => {
  if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' :: ' + x); }
};

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

console.log('1. app.js is syntactically valid');
let parseErr = null;
try {
  new vm.Script(appSrc, { filename: 'app.js' });
} catch (e) {
  parseErr = e.message;
}
check('parses', parseErr === null, parseErr || '');

console.log('\n2. index.html tags are balanced');
// Comments are stripped first. An earlier version of this check did not, and a code sample
// written inside an HTML comment ("Rejoin <id>") produced a cascade of bogus mismatch
// errors pointing at perfectly good markup several elements away.
const stripped = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<!doctype[^>]*>/gi, '')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
const stack = [];
const errors = [];
const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
let m;
while ((m = tagRe.exec(stripped))) {
  const [, closing, rawTag, , selfClose] = m;
  const tag = rawTag.toLowerCase();
  if (VOID_TAGS.has(tag) || selfClose) continue;
  if (closing) {
    const open = stack.pop();
    if (open !== tag) errors.push(`</${tag}> closed <${open || 'nothing'}>`);
  } else {
    stack.push(tag);
  }
}
check('no mismatched close tags', errors.length === 0, errors.slice(0, 5).join('; '));
check('no unclosed tags', stack.length === 0, stack.join(','));

console.log('\n3. the cache-buster halves agree');
const stampMatch = appSrc.match(/BUILD_STAMP\s*=\s*'([^']*)'/);
const srcMatch = html.match(/<script\s+src="app\.js\?v=(\d+)"/);
check('BUILD_STAMP is present', !!stampMatch, 'no BUILD_STAMP in app.js');
check('app.js is loaded with a ?v=', !!srcMatch, 'no versioned <script src="app.js?v=N">');
if (stampMatch && srcMatch) {
  const stampVersion = (stampMatch[1].match(/v(\d+)\s*$/) || [])[1];
  check('BUILD_STAMP ends in vN', !!stampVersion, stampMatch[1]);
  check(
    `BUILD_STAMP v${stampVersion} matches script ?v=${srcMatch[1]}`,
    stampVersion === srcMatch[1],
    `stamp="${stampMatch[1]}" script ?v=${srcMatch[1]} — bump both or the phone runs stale code`,
  );
}

console.log('\n4. every id app.js reaches for exists in the markup');
const markupIds = new Set((html.match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1)));
// Ids app.js looks up but index.html no longer declares, on purpose. Each is read behind an
// `if (el)` guard so a device holding a cached older index.html against a newer app.js
// degrades quietly instead of throwing.
const INTENTIONALLY_ABSENT = new Set(['btn-rejoin-last']);
const referenced = [...appSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((x) => x[1]);
const missing = [...new Set(referenced)].filter((id) => !markupIds.has(id) && !INTENTIONALLY_ABSENT.has(id));
check('no dangling getElementById targets', missing.length === 0, missing.join(', '));
// If a guard's id comes back into the markup, the allowlist entry is now a lie.
const staleAllowlist = [...INTENTIONALLY_ABSENT].filter((id) => markupIds.has(id));
check('allowlisted ids really are absent', staleAllowlist.length === 0, staleAllowlist.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
