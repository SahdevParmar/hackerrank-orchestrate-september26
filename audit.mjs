// audit.mjs — find forecast() calls missing `request`
import { readFileSync } from 'node:fs';

const files = [
    'code/engine/safeAmount.js',
    'code/engine/plans.js',
    'code/engine/spending.js',
    'code/engine/rank.js',
];

let found = 0;

for (const f of files) {
    let src;
    try {
        src = readFileSync(f, 'utf8');
    } catch {
        console.log(`SKIP ${f} (not found)`);
        continue;
    }

    const lines = src.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Find any call to forecast with a ctx first arg
        if (!/forecast\s*\(\s*ctx\s*,/.test(line)) continue;

        // Grab the next 8 lines to inspect the options object
        const window = lines.slice(i, i + 8).join('\n');

        // If `request` (as a bare key) appears in the options object, it's fine
        if (/\brequest\s*,/.test(window) || /\brequest\s*:/.test(window)) continue;

        found++;
        console.log(`${f}:${i + 1}  MISSING request`);
        console.log(`   ${line.trim()}`);
    }
}

console.log(found === 0
    ? 'OK — all forecast() calls include request'
    : `FOUND ${found} call(s) missing request`);