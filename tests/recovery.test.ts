import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { context, saveJson, fingerprint } from '../src/io.ts';
import { applyPlan, makePlan, operation } from '../src/plans.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-recovery-')); roots.push(root);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache') });
  await saveJson(ctx.registryPath, {});
  const target = join(root, 'target'); await writeFile(target, 'original');
  const plan = await makePlan(ctx, 'recover fixture', [root], [await operation('write', target, { content: 'replacement' })]);
  return { root, ctx, target, plan };
}
async function crash(f: Awaited<ReturnType<typeof fixture>>, event: string) {
  const script = join(f.root, 'crash.ts');
  await writeFile(script, `import { applyPlan } from ${JSON.stringify(join(import.meta.dir, '../src/plans.ts'))};\nawait applyPlan(${JSON.stringify(f.ctx)}, ${JSON.stringify(f.plan)}, false, async event => { if (event === ${JSON.stringify(event)}) process.kill(process.pid, 'SIGKILL'); });`);
  const child = Bun.spawn([process.execPath, '--no-env-file', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).not.toBe(0);
}
for (const event of ['staged', 'retired', 'published_before_journal', 'published', 'journal_applied']) test(`physical process interruption at ${event} recovers the prepared result`, async () => {
  const f = await fixture(); await crash(f, event);
  const result = await applyPlan(f.ctx, f.plan, true);
  expect(result.status).toBe('applied'); expect(await readFile(f.target, 'utf8')).toBe('replacement');
  expect((await applyPlan(f.ctx, f.plan)).already_applied).toBe(true);
});
test('concurrent edit during staging remains in place with no successful receipt', async () => {
  const f = await fixture();
  await expect(applyPlan(f.ctx, f.plan, false, async event => { if (event === 'staged') await writeFile(f.target, 'user edit'); })).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  expect(await readFile(f.target, 'utf8')).toBe('user edit');
  expect(await fingerprint(join(f.ctx.stateRoot, 'runs', f.plan.id, 'receipt.json'))).toBeNull();
});
test('a path created after retirement is preserved and explicit recovery restores the original', async () => {
  const f = await fixture();
  await expect(applyPlan(f.ctx, f.plan, false, async event => { if (event === 'retired') await writeFile(f.target, 'new user file'); })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(f.target, 'utf8')).toBe('new user file');
  await expect(applyPlan(f.ctx, f.plan, true)).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
  await rm(f.target); // User resolves the explicit conflict; the tool did not delete it.
  expect((await applyPlan(f.ctx, f.plan, true)).status).toBe('applied');
  expect(await readFile(f.target, 'utf8')).toBe('replacement');
});
test('a newly published file is rolled back after a crash before its journal transition', async () => {
  const f = await fixture(); await rm(f.target);
  const other = join(f.root, 'other'); await writeFile(other, 'unchanged');
  f.plan = await makePlan(f.ctx, 'two targets', [f.root], [await operation('write', f.target, { content: 'new' }), await operation('write', other, { content: 'second' })]);
  await crash(f, 'published_before_journal'); await writeFile(other, 'user edit');
  await expect(applyPlan(f.ctx, f.plan, true)).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
  expect(await fingerprint(f.target)).toBeNull(); expect(await readFile(other, 'utf8')).toBe('user edit');
});
test('an earlier target drifting during a later operation prevents a successful batch receipt', async () => {
  const f = await fixture(); const later = join(f.root, 'later');
  const plan = await makePlan(f.ctx, 'batch drift', [f.root], [await operation('write', f.target, { content: 'candidate' }), await operation('write', later, { content: 'later' })]);
  await expect(applyPlan(f.ctx, plan, false, async (event, row) => {
    if (event === 'published' && row?.operation.target === later) await writeFile(f.target, 'concurrent edit');
  })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(f.target, 'utf8')).toBe('concurrent edit');
  expect(await fingerprint(later)).toBeNull();
  expect(await fingerprint(join(f.ctx.stateRoot, 'runs', plan.id, 'receipt.json'))).toBeNull();
});
test('a Git projection plan refuses an ignore-policy change before apply', async () => {
  const f = await fixture();
  const git = Bun.spawn(['git', 'init', '-q', f.root], { stdout: 'pipe', stderr: 'pipe' }); expect(await git.exited).toBe(0);
  const target = join(f.root, 'projected'); await writeFile(join(f.root, '.gitignore'), 'projected\n');
  const plan = await makePlan(f.ctx, 'git projection', [f.root], [await operation('link', target, { source: f.target, git_root: f.root })]);
  await writeFile(join(f.root, '.gitignore'), 'different\n');
  await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'GIT_PROJECTION_CONFLICT' });
  expect(await fingerprint(target)).toBeNull(); expect(await readFile(f.target, 'utf8')).toBe('original');
});
test('a nested Git repository introduced after planning is not a projection target', async () => {
  const f = await fixture();
  const git = async (...args: string[]) => { const p = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' }); expect(await p.exited).toBe(0); };
  await git('init', '-q', f.root); await writeFile(join(f.root, '.gitignore'), 'nested/\n');
  const nested = join(f.root, 'nested'); await mkdir(nested);
  const target = join(nested, 'entry');
  const plan = await makePlan(f.ctx, 'nested scope drift', [f.root], [await operation('link', target, { source: f.target, git_root: f.root })]);
  await git('init', '-q', nested);
  await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'GIT_PROJECTION_CONFLICT' });
  expect(await fingerprint(target)).toBeNull();
});
for (const change of ['nonignored', 'tracked', 'nested']) test(`Git ${change} drift cannot become success through recovery or receipt reuse`, async () => {
  const f = await fixture();
  const git = async (cwd: string, ...args: string[]) => { const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' }); expect(await p.exited).toBe(0); };
  await git(f.root, 'init', '-q'); await writeFile(join(f.root, '.gitignore'), 'links/\n');
  const parent = join(f.root, 'links'); await mkdir(parent);
  const target = join(parent, 'selected');
  const plan = await makePlan(f.ctx, 'projection completion', [f.root], [await operation('link', target, { source: f.target, git_root: f.root })]);
  const mutate = async () => {
    if (change === 'nonignored') await writeFile(join(f.root, '.gitignore'), 'different/\n');
    else if (change === 'tracked') await git(f.root, 'add', '-f', '--', 'links/selected');
    else await git(parent, 'init', '-q');
  };
  await expect(applyPlan(f.ctx, plan, false, async event => { if (event === 'published') await mutate(); })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(applyPlan(f.ctx, plan, true)).rejects.toMatchObject({ code: 'GIT_PROJECTION_CONFLICT' });
  expect(await fingerprint(join(f.ctx.stateRoot, 'runs', plan.id, 'receipt.json'))).toBeNull();
  if (change === 'nonignored') await writeFile(join(f.root, '.gitignore'), 'links/\n');
  else if (change === 'tracked') await git(f.root, 'rm', '--cached', '-f', '--', 'links/selected');
  else await rm(join(parent, '.git'), { recursive: true });
  expect((await applyPlan(f.ctx, plan, true)).status).toBe('applied');
  expect((await applyPlan(f.ctx, plan)).already_applied).toBe(true);
  await mutate();
  await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'GIT_PROJECTION_CONFLICT' });
});
test('receipt reuse cannot validate a projection after registry authority changes', async () => {
  const f = await fixture(); await applyPlan(f.ctx, f.plan);
  await saveJson(f.ctx.registryPath, { authority: 'changed' });
  await expect(applyPlan(f.ctx, f.plan)).rejects.toMatchObject({ code: 'POST_APPLY_DRIFT' });
});
