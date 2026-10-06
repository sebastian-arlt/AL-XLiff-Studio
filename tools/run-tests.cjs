'use strict';
// Explicit files work across Node versions and keep generated artifacts/tools out
// of automatic test discovery, including third-party *-test.js build commands.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync(path.join(__dirname, '../test'))
    .filter(file => file.endsWith('.test.js'))
    .sort()
    .map(file => path.join(__dirname, '../test', file));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status == null ? 1 : result.status;
