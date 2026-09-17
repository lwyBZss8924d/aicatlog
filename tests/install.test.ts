import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { context, fingerprint, saveJson, sha } from '../src/io.ts';
import { applyPlan } from '../src/plans.ts';
import type { Plan } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-install-')); roots.push(root);
  const release = join(root, 'release'), prefix = join(root, 'prefix'), bin = join(root, 'bin');
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache') });
  await mkdir(bin);
  const files = [];
  for (const artifact of ['bin/aicatlog', 'libexec/tgrep']) {
    const content = `#!/bin/sh\nprintf '%s\\n' '${artifact} fixture'\n`;
    const target = join(release, artifact);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, { mode: 0o755 });
    files.push({ path: artifact, sha256: sha(content) });
  }
  const manifest = { version: '1.0.0', platform: 'test-platform', files };
  await saveJson(join(release, 'release-manifest.json'), manifest);
  return { root, release, prefix, bin, ctx, manifest };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function install(f: Fixture, apply = false) {
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../tools/install.ts'),
    '--release', f.release, '--prefix', f.prefix, '--bin', f.bin, '--state', f.ctx.stateRoot, ...(apply ? ['--apply'] : [])],
  { env: { ...process.env, AICATLOG_REGISTRY: f.ctx.registryPath }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function plan(f: Fixture): Promise<Plan> {
  const result = await install(f);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

test('reviewed installation exposes both commands, supports an old installation and is idempotent', async () => {
  const f = await fixture();
  const destination = join(f.prefix, 'releases', '1.0.0-test-platform');
  const prepared = await plan(f);
  expect(prepared.conflicts).toEqual([]);
  expect(prepared.operations.map(op => [op.action, op.target])).toEqual([
    ['copy', destination], ['link', join(f.bin, 'aicatlog')], ['link', join(f.bin, 'tgrep')],
  ]);
  expect(await fingerprint(f.prefix)).toBeNull();
  expect(await fingerprint(join(f.bin, 'tgrep'))).toBeNull();
  expect((await applyPlan(f.ctx, prepared)).status).toBe('applied');
  for (const [name, artifact] of [['aicatlog', 'bin/aicatlog'], ['tgrep', 'libexec/tgrep']])
    expect(await readlink(join(f.bin, name!))).toBe(join(destination, artifact!));
  const child = Bun.spawn(['tgrep', '--version'], { env: { ...process.env, PATH: f.bin }, stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(child.stdout).text()).toBe('libexec/tgrep fixture\n');
  expect(await child.exited).toBe(0);
  expect((await plan(f)).operations).toEqual([]);
  // Existing releases installed before standalone tgrep was exposed need only its link.
  await rm(join(f.bin, 'tgrep'));
  const repair = await plan(f);
  expect(repair.operations.map(op => [op.action, op.target])).toEqual([['link', join(f.bin, 'tgrep')]]);
  expect((await applyPlan(f.ctx, repair)).status).toBe('applied');
  f.manifest.version = '1.1.0';
  await saveJson(join(f.release, 'release-manifest.json'), f.manifest);
  // Relative owned links also remain eligible for updates.
  await rm(join(f.bin, 'tgrep'));
  await symlink(relative(f.bin, join(destination, 'libexec/tgrep')), join(f.bin, 'tgrep'));
  const updated = await plan(f);
  expect(updated.conflicts).toEqual([]);
  expect((await applyPlan(f.ctx, updated)).status).toBe('applied');
  expect(await readlink(join(f.bin, 'tgrep'))).toBe(join(f.prefix, 'releases', '1.1.0-test-platform', 'libexec/tgrep'));
  expect(await fingerprint(destination)).not.toBeNull();
  expect((await plan(f)).operations).toEqual([]);
});

for (const name of ['aicatlog', 'tgrep']) for (const kind of ['file', 'foreign-link', 'prefix-link'])
  test(`installation preserves a foreign ${name} ${kind}`, async () => {
    const f = await fixture(), target = join(f.bin, name);
    if (kind === 'file') await writeFile(target, 'user executable');
    else await symlink(join(kind === 'prefix-link' ? f.prefix : f.root, 'foreign-executable'), target);
    const original = await fingerprint(target), prepared = await plan(f);
    expect(prepared.conflicts).toEqual([`Existing executable is not owned by this prefix: ${target}`]);
    await expect(applyPlan(f.ctx, prepared)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    expect((await install(f, true)).code).not.toBe(0);
    expect(await fingerprint(target)).toBe(original);
    expect(await fingerprint(join(f.prefix, 'releases'))).toBeNull();
  });

for (const artifact of ['bin/aicatlog', 'libexec/tgrep']) for (const defect of ['unlisted', 'missing', 'hash', 'not-executable', 'symlink'])
  test(`installation refuses ${artifact} when ${defect}`, async () => {
    const f = await fixture(), target = join(f.release, artifact);
    if (defect === 'unlisted') {
      f.manifest.files = f.manifest.files.filter(file => file.path !== artifact);
      await saveJson(join(f.release, 'release-manifest.json'), f.manifest);
    } else if (defect === 'missing') await rm(target);
    else if (defect === 'hash') await writeFile(target, 'corrupt executable');
    else if (defect === 'not-executable') await chmod(target, 0o644);
    else {
      const content = await readFile(target);
      await writeFile(join(f.root, 'external'), content, { mode: 0o755 });
      await rm(target); await symlink(join(f.root, 'external'), target);
    }
    const result = await install(f);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('release');
    expect(result.stdout).toBe('');
    expect(await fingerprint(join(f.ctx.stateRoot, 'plans'))).toBeNull();
    expect(await fingerprint(f.prefix)).toBeNull();
  });
