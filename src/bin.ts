#!/usr/bin/env bun
import { createAicatlog } from './cli.ts';
import { indexWorker } from './content-index.ts';

const argv = process.argv.slice(2);
if (argv[0] === '__index-worker') {
  if (!argv[1]) throw new Error('Worker configuration required.');
  await indexWorker(argv[1]);
} else {
  const end = argv.indexOf('--');
  const flags = end < 0 ? argv : argv.slice(0, end);
  if (flags.some(x => x === '--token-limit' || x === '--token-offset')) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'STRUCTURAL_PAGINATION_REQUIRED', message: 'Use --limit/--cursor for resources or --line/--limit for source reads. Text token slicing changes structured output.' } }) + '\n');
    process.exitCode = 2;
  } else await createAicatlog().serve(argv);
}
