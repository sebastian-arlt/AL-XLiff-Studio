'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = ['extension.js'];
for (const directory of ['src', 'test', 'tools']) {
    function collect(root) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const file = path.join(root, entry.name);
            if (entry.isDirectory()) collect(file);
            else if (/\.(js|cjs)$/.test(file)) files.push(file);
        }
    }
    collect(directory);
}
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
