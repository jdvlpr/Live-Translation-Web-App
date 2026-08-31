'use strict';
// Runs every suite in tests/ and exits non-zero if any of them fail.
//
//   node tests/run.js            all suites
//   node tests/run.js speaker    only suites whose name contains "speaker"
//
// No dependencies and no package.json on purpose: the app itself has no build step, and a
// test suite that needed `npm install` before it would run would be the only thing in the
// repo that did.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const suites = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => f.includes(filter))
  .sort();

if (suites.length === 0) {
  console.error(filter ? `No suite matches "${filter}".` : 'No suites found.');
  process.exit(1);
}

const failed = [];
for (const suite of suites) {
  console.log(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}`);
  try {
    // Inherited stdio so a failing assertion shows its own message in place, and cwd is
    // irrelevant because each suite resolves index.html/app.js against its own __dirname.
    execFileSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  } catch {
    failed.push(suite);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`All ${suites.length} suites passed.`);
