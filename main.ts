import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Match the house baseline: turn V8 incremental marking off before the
// solver loads, so GC pauses do not inflate the measured CPU time. The
// solver must be imported dynamically, after this call — a static import
// would be hoisted and load it first.
setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const answers = [];
for (const c of cases) answers.push(run(c.input));
mkdirSync('/output', { recursive: true });
writeFileSync('/output/answers.json', JSON.stringify(answers));
