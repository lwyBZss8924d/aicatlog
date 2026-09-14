import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { context, fingerprint, saveJson } from '../src/io.ts';
import { applyPlan } from '../src/plans.ts';
import { skillsPlan } from '../src/skills.ts';
import { registrySchema } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const skillBody = '---\nname: example\ndescription: Synthetic bridge fixture.\n---\nFixture body.\n';
async function skill(directory: string) {
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'SKILL.md'), skillBody);
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aicatlog-bridge-'))); roots.push(root);
  const sourceRoot = join(root, 'source skills'), source = join(sourceRoot, 'collection/example');
  const bridge = join(root, 'client bridge'), target = join(bridge, 'collection/example');
  await skill(source); await mkdir(bridge);
  const ctx = context({ registryPath: join(root, 'configuration/registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), sessionId: 'bridge-fixture' });
  await saveJson(ctx.registryPath, registrySchema.parse({ schema_version: 'aicatlog.registry.v1',
    scopes: [{ id: 'skills', root: sourceRoot, kind: 'skills' }], settings: { skills_root: sourceRoot },
    clients: [{ id: 'bridge', root: bridge, mode: 'bridge' }],
    skills: [{ id: 'owned:example', name: 'example', owner: 'external-owner', source: { kind: 'local', uri: source },
      target: source, clients: ['bridge'], metadata: { bridge_name: 'collection/example' } }] }));
  return { root, sourceRoot, source, bridge, target, ctx };
}

describe('global bridge sync source identity', () => {
  test.each(['absolute', 'relative'] as const)('preserves an existing %s link without rewriting it', async kind => {
    const f = await fixture(); await mkdir(dirname(f.target));
    const linkText = kind === 'absolute' ? f.source : relative(dirname(f.target), f.source);
    await symlink(linkText, f.target);
    const before = await lstat(f.target), registry = await readFile(f.ctx.registryPath, 'utf8');
    const plan = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toEqual([]);
    expect(plan.roots).toEqual([dirname(f.ctx.registryPath), f.bridge]);
    await applyPlan(f.ctx, plan);
    expect(await readlink(f.target)).toBe(linkText); expect((await lstat(f.target)).ino).toBe(before.ino);
    expect(await readFile(f.ctx.registryPath, 'utf8')).toBe(registry);
  });

  test('preserves an ancestor collection symlink when its child is the same source', async () => {
    const f = await fixture(), collection = dirname(f.target);
    const linkText = relative(f.bridge, dirname(f.source)); await symlink(linkText, collection);
    expect((await lstat(f.target)).isDirectory()).toBe(true);
    const before = await lstat(collection);
    const plan = await skillsPlan(f.ctx, 'sync', { id: 'owned:example' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toEqual([]);
    expect(plan.roots).toEqual([dirname(f.ctx.registryPath), f.bridge]);
    expect(plan.roots).not.toContain(f.sourceRoot);
    await applyPlan(f.ctx, plan);
    expect(await readlink(collection)).toBe(linkText); expect((await lstat(collection)).ino).toBe(before.ino);
    expect(await realpath(f.target)).toBe(await realpath(f.source));
    expect((await lstat(f.target)).isSymbolicLink()).toBe(false);
  });

  test.each(['directory', 'foreign-link'] as const)('rejects an equal-content distinct %s', async kind => {
    const f = await fixture(); await mkdir(dirname(f.target));
    if (kind === 'directory') {
      await skill(f.target); expect(await fingerprint(f.target)).toBe(await fingerprint(f.source));
    } else {
      const foreign = join(f.root, 'foreign example'); await skill(foreign); await symlink(foreign, f.target);
      expect(await fingerprint(foreign)).toBe(await fingerprint(f.source));
    }
    expect(await realpath(f.target)).not.toBe(await realpath(f.source));
    const before = await fingerprint(f.target);
    const plan = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(plan.operations).toEqual([]); expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain('Foreign or changed bridge');
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    expect(await fingerprint(f.target)).toBe(before);
  });

  test('rejects a dangling target alias without replacing it', async () => {
    const f = await fixture(); await mkdir(dirname(f.target)); await symlink('missing-target', f.target);
    const plan = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(plan.operations).toEqual([]); expect(plan.conflicts).toHaveLength(1);
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    expect(await readlink(f.target)).toBe('missing-target');
  });

  test('rejects matching link text when the source is a dangling alias', async () => {
    const f = await fixture(); await rm(f.source, { recursive: true });
    await symlink('missing-source', f.source); await mkdir(dirname(f.target)); await symlink(f.source, f.target);
    const plan = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(plan.operations).toEqual([]); expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain('Missing projection source');
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    expect(await readlink(f.source)).toBe('missing-source'); expect(await readlink(f.target)).toBe(f.source);
  });

  test('still plans and applies only the absent selected bridge', async () => {
    const f = await fixture();
    const plan = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ action: 'link', target: f.target, source: f.source, before: null });
    expect(plan.roots).toEqual([dirname(f.ctx.registryPath), f.bridge]);
    await applyPlan(f.ctx, plan);
    expect(await readlink(f.target)).toBe(f.source);
    const repeat = await skillsPlan(f.ctx, 'sync', { client: 'bridge' });
    expect(repeat.operations).toEqual([]); expect(repeat.conflicts).toEqual([]);
  });
});
