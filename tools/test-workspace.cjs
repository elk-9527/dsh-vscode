'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const owned = new Set();
let registered = false;

/** Own temporary fixtures inside this checkout, including standalone test runs. */
function createFixture(label) {
  if (!/^[a-z][a-z0-9-]*$/.test(label)) throw new Error('Invalid fixture label');
  const build = path.join(ROOT, 'build');
  const parent = path.join(build, 'tests');
  for (const directory of [build, parent]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Fixture directory must not be a link');
    fs.mkdirSync(directory, { recursive: true });
  }
  const directory = fs.mkdtempSync(path.join(parent, `${label}-`));
  owned.add(directory);
  if (!registered) {
    registered = true;
    process.once('exit', () => {
      for (const item of owned) {
        try {
          if (path.dirname(item) !== parent) throw new Error('Fixture outside its parent');
          fs.rmSync(item, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
          console.error(`Fixture cleanup failed: ${error.message}`);
          process.exitCode = 1;
        }
      }
    });
  }
  return directory;
}

module.exports = { createFixture };
