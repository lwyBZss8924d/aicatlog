import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, registrySchema } from '../src/index.ts';
import { saveJson, run } from '../src/io.ts';
import { contentFind, indexStart, indexStatus, indexStop, refreshContent } from '../src/content-index.ts';

const tgrep = process.env.AICATLOG_TEST_TGREP ?? join(import.meta.dir, '../.cache/tgrep-build/release/tgrep');
test('managed tgrep finds real text, serves shared leases and honors live scans', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aicatlog-tgrep-'));
  const root = await realpath(temporary); const corpus = join(root, 'corpus'); await mkdir(corpus);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), sessionId: 'first', tgrep });
  const second = { ...ctx, sessionId: 'second' };
  const isolated = { ...ctx, stateRoot: join(root, 'other-state'), sessionId: 'isolated' };
  try {
    await run(['git', 'init', '-q', corpus]);
    await writeFile(join(corpus, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(corpus, 'guide.txt'), '{"id":"guide"}\nneedle active guidance\n');
    await writeFile(join(corpus, '.hidden.txt'), 'needle hidden guidance\n');
    await writeFile(join(corpus, 'ignored.txt'), 'needle ignored\n');
    await saveJson(ctx.registryPath, registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [{ id: 'docs', root: corpus, kind: 'documents', idle_seconds: 10 }] }));
    await indexStart(ctx, 'docs'); await indexStart(second, 'docs'); await refreshContent(ctx, 'docs');
    await indexStart(isolated, 'docs');
    expect((await indexStatus(isolated, 'docs')).worker?.pid).not.toBe((await indexStatus(ctx, 'docs')).worker?.pid);
    const indexed = await contentFind(ctx, 'needle', { scope: 'docs' });
    expect(indexed.backend).toBe('tgrep_server'); expect(indexed.items).toHaveLength(2);
    expect(indexed.items.find(x => x.path.endsWith('guide.txt'))).toMatchObject({ line: 2, text: 'needle active guidance' });
    expect(indexed.items.find(x => x.path.endsWith('guide.txt'))?.resource_ids).toContain('docs:guide');
    await writeFile(join(corpus, 'new.txt'), 'brand-new-current-value\n');
    const live = await contentFind(ctx, 'brand-new-current-value', { scope: 'docs', fresh: true });
    expect(live.backend).toBe('tgrep_live_scan'); expect(live.items).toHaveLength(1);
    const noMatch = await contentFind(ctx, 'unmatched-literal', { scope: 'docs', fresh: true });
    expect(noMatch.total).toBe(0);
    await indexStop(ctx, 'docs'); expect((await indexStatus(second, 'docs')).running).toBe(true);
    const old = (await indexStatus(second, 'docs')).worker!;
    expect(old.child_identity).toBeString();
    process.kill(old.pid, 'SIGKILL');
    await Bun.sleep(200);
    await indexStart(second, 'docs');
    const restored = await indexStatus(second, 'docs');
    expect(restored.managed).toBe(true); expect(restored.worker?.pid).not.toBe(old.pid);
    await indexStop(second, 'docs');
    let running = true;
    for (let i = 0; i < 50 && running; i++) { await Bun.sleep(100); running = (await indexStatus(ctx, 'docs')).running; }
    expect(running).toBe(false);
    expect((await indexStatus(isolated, 'docs')).running).toBe(true);
    expect((await contentFind(isolated, 'needle', { scope: 'docs' })).total).toBe(2);
  } finally {
    await indexStop(ctx, 'docs').catch(() => {}); await indexStop(second, 'docs').catch(() => {}); await indexStop(isolated, 'docs').catch(() => {});
    let running = true;
    for (let i = 0; i < 100 && running; i++) { await Bun.sleep(100); running = (await indexStatus(ctx, 'docs').catch(() => ({ running: false }))).running || (await indexStatus(isolated, 'docs').catch(() => ({ running: false }))).running; }
    if (running) throw new Error(`Owned worker did not stop; retained ${root}`);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
