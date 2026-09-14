import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { context, run, saveJson } from '../src/io.ts';
import { applyPlan } from '../src/plans.ts';
import { projectProjectionPlan } from '../src/project-projection.ts';
import { registrySchema } from '../src/types.ts';

const fixtures: string[] = [];
afterEach(async () => { for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true }); });
async function file(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function git(root: string, ...args: string[]) {
  const result = await run(['git', ...args], root);
  if (result.exit_code) throw new Error(result.stderr);
  return result.stdout;
}
async function fixture(ignore = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aicatlog-project-'))); fixtures.push(root);
  const project = join(root, 'main project'), sourceRoot = join(root, 'shared skills');
  await mkdir(project); await git(project, 'init', '-q');
  await file(join(project, '.gitignore'), ignore ? '.agents/skills/\n.claude/skills/\n.codex/skills/\n.gemini/skills/\n' : '');
  await git(project, 'add', '.gitignore');
  await git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  await file(join(sourceRoot, 'selected', 'SKILL.md'), '---\nname: selected\ndescription: Fixture Skill.\n---\nUseful fixture\n');
  await file(join(sourceRoot, 'unselected', 'SKILL.md'), 'Unselected fixture\n');
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), sessionId: 'fixture' });
  const registry = registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [], settings: { skills_root: sourceRoot },
    skills: [{ id: 'owned:selected', name: 'selected', owner: 'external-owner', source: { kind: 'local', uri: join(sourceRoot, 'selected') }, target: join(sourceRoot, 'selected') }],
    project_clients: [
      { name: 'project-claude', relative_path: '.claude/skills', source_relative_path: '.agents/skills', sync_policy: 'project_bridge' },
      { name: 'project-codex', relative_path: '.codex/skills', sync_policy: 'native_no_sync' },
      { name: 'project-gemini', relative_path: '.gemini/skills', sync_policy: 'native_no_sync' },
    ] });
  await saveJson(ctx.registryPath, registry);
  return { root, project, sourceRoot, ctx, registry };
}

describe('portable project Skills projections', () => {
  test('applies only the exact selected link and preserves its external owner', async () => {
    const f = await fixture(), original = await readFile(f.ctx.registryPath, 'utf8');
    const ownedSource = join(f.root, 'owner managed source');
    await rename(join(f.sourceRoot, 'selected'), ownedSource); await symlink(ownedSource, join(f.sourceRoot, 'selected'));
    const originalSource = await readFile(join(ownedSource, 'SKILL.md'), 'utf8');
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(1); expect(plan.roots).toEqual([f.project]);
    expect(plan.operations[0]!.action).toBe('link');
    await applyPlan(f.ctx, plan);
    expect(await readlink(join(f.project, '.agents/skills/selected'))).toBe(join(f.sourceRoot, 'selected'));
    expect(await lstat(join(f.project, '.agents/skills/unselected')).catch(() => null)).toBeNull();
    expect(await readFile(f.ctx.registryPath, 'utf8')).toBe(original);
    expect(await readFile(join(ownedSource, 'SKILL.md'), 'utf8')).toBe(originalSource);
    expect(await git(f.project, 'status', '--porcelain')).toBe('');
  });

  test('requires explicit global selection and accepts an exact unregistered collection', async () => {
    const f = await fixture();
    await expect(projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project' })).rejects.toMatchObject({ code: 'SELECTION_REQUIRED' });
    for (const entry of ['../escape', '*', 'selected/child'])
      await expect(projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry })).rejects.toMatchObject({ code: 'INVALID_ENTRY' });
    await file(join(f.sourceRoot, 'collection', 'child', 'SKILL.md'), 'collection member');
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'collection' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(1);
    await applyPlan(f.ctx, plan);
    expect(await readFile(join(f.project, '.agents/skills/collection/child/SKILL.md'), 'utf8')).toBe('collection member');
    f.registry.skills[0]!.state = 'disabled'; await saveJson(f.ctx.registryPath, f.registry);
    await expect(projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' })).rejects.toMatchObject({ code: 'INACTIVE_RESOURCE' });
  });

  test('bridges project entries only to registered bridge clients and leaves native clients without mirrors', async () => {
    const f = await fixture();
    await file(join(f.project, '.agents/skills/local/SKILL.md'), 'project-owned source');
    await file(join(f.project, '.agents/skills/other/SKILL.md'), 'unselected source');
    await file(join(f.project, '.claude/skills/unknown/SKILL.md'), 'preserved foreign resource');
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'project', entry: 'local' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(1);
    expect(plan.notes.filter(n => n.includes('no mirror'))).toHaveLength(2);
    await applyPlan(f.ctx, plan);
    expect(await readlink(join(f.project, '.claude/skills/local'))).toBe(join(f.project, '.agents/skills/local'));
    for (const path of ['.codex', '.gemini', '.claude/skills/other']) expect(await lstat(join(f.project, path)).catch(() => null)).toBeNull();
    expect(await readFile(join(f.project, '.claude/skills/unknown/SKILL.md'), 'utf8')).toBe('preserved foreign resource');
    const native = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'project', client: 'project-codex' });
    expect(native.operations).toEqual([]); expect(native.conflicts).toEqual([]);
  });

  test('recognizes an equivalent relative symlink without rewriting it', async () => {
    const f = await fixture(), target = join(f.project, '.agents/skills/selected');
    await mkdir(dirname(target), { recursive: true });
    const original = relative(dirname(target), join(f.sourceRoot, 'selected'));
    await symlink(original, target);
    const before = await lstat(target);
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toEqual([]);
    await applyPlan(f.ctx, plan);
    expect(await readlink(target)).toBe(original); expect((await lstat(target)).ino).toBe(before.ino);
  });

  test('bridges immediate project entries once for duplicate client roots and preserves unrelated files', async () => {
    const f = await fixture();
    for (const entry of ['local', 'collection/child']) await file(join(f.project, '.agents/skills', entry, 'SKILL.md'), 'project entry');
    await file(join(f.project, '.agents/skills/SKILL.md'), 'root index');
    f.registry.project_clients.push({ name: 'same-bridge', relative_path: '.claude/skills', sync_policy: 'project_bridge' });
    await saveJson(f.ctx.registryPath, f.registry);
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'project' });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(2);
    await applyPlan(f.ctx, plan);
    for (const entry of ['local', 'collection']) expect(await readlink(join(f.project, '.claude/skills', entry))).toBe(join(f.project, '.agents/skills', entry));
    expect(await lstat(join(f.project, '.claude/skills/SKILL.md')).catch(() => null)).toBeNull();
  });

  test('rejects a destination owned by a nested Git repository', async () => {
    const f = await fixture();
    await file(join(f.project, '.agents/skills/local/SKILL.md'), 'project-owned source');
    const nested = join(f.project, '.claude'); await mkdir(nested); await git(nested, 'init', '-q');
    await file(join(nested, '.gitignore'), 'skills/\n');
    const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'project', entry: 'local' });
    expect(plan.operations).toEqual([]); expect(plan.conflicts.join('\n')).toContain('FOREIGN_REPOSITORY');
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
  });

  test('rejects nonignored and tracked targets without changing them', async () => {
    const f = await fixture(false);
    const rejected = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(rejected.operations).toEqual([]); expect(rejected.conflicts.join('\n')).toContain('TARGET_NOT_IGNORED');
    await expect(applyPlan(f.ctx, rejected)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
    await file(join(f.project, '.gitignore'), '.agents/skills/\n');
    const target = join(f.project, '.agents/skills/selected');
    await file(join(target, 'SKILL.md'), 'tracked project source');
    await git(f.project, 'add', '-f', '.agents/skills/selected/SKILL.md');
    const tracked = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(tracked.operations).toEqual([]); expect(tracked.conflicts.join('\n')).toContain('TRACKED_TARGET');
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('tracked project source');
  });

  test('rejects foreign targets and parent link escapes, including a parent changed after planning', async () => {
    const f = await fixture(), target = join(f.project, '.agents/skills/selected'), outside = join(f.root, 'outside');
    await mkdir(dirname(target), { recursive: true }); await symlink(join(f.sourceRoot, 'unselected'), target);
    const foreign = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(foreign.operations).toEqual([]); expect(foreign.conflicts.join('\n')).toContain('FOREIGN_TARGET');
    await rm(join(f.project, '.agents'), { recursive: true }); await mkdir(outside);
    const prepared = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(prepared.conflicts).toEqual([]);
    await symlink(outside, join(f.project, '.agents'));
    const escaped = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'selected' });
    expect(escaped.operations).toEqual([]); expect(escaped.conflicts.join('\n')).toContain('OUTSIDE_SCOPE');
    await expect(applyPlan(f.ctx, prepared)).rejects.toMatchObject({ code: 'OUTSIDE_SCOPE' });
    expect(await lstat(join(outside, 'skills/selected')).catch(() => null)).toBeNull();
  });

  test('does not authorize a client path outside the project or inside its source scope', async () => {
    const f = await fixture(); await file(join(f.project, '.agents/skills/local/SKILL.md'), 'local');
    for (const relative_path of ['../outside/skills', '.agents/skills/nested', '.git/skills']) {
      f.registry.project_clients = [{ name: 'bad', sync_policy: 'project_bridge', relative_path }];
      await saveJson(f.ctx.registryPath, f.registry);
      const plan = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'project' });
      expect(plan.operations).toEqual([]); expect(plan.conflicts.length).toBeGreaterThan(0); expect(plan.roots).toEqual([f.project]);
    }
  });

  test('plans both live worktrees with spaces independently and reports prunable roots', async () => {
    const f = await fixture(), second = join(f.root, 'second worktree'), missing = join(f.root, 'missing worktree');
    await git(f.project, 'worktree', 'add', '-q', '-b', 'second', second);
    await git(f.project, 'worktree', 'add', '-q', '-b', 'missing', missing); await rm(missing, { recursive: true });
    const plan = await projectProjectionPlan(f.ctx, { project: second, scope: 'global_to_project', entry: 'selected', worktrees: true });
    expect(plan.conflicts).toEqual([]); expect(plan.operations).toHaveLength(2); expect(plan.roots.sort()).toEqual([f.project, second].sort());
    expect(plan.notes.some(n => n.includes(missing) && n.includes('prunable'))).toBe(true);
    await applyPlan(f.ctx, plan);
    for (const project of [f.project, second]) {
      expect(await readlink(join(project, '.agents/skills/selected'))).toBe(join(f.sourceRoot, 'selected'));
      expect(await git(project, 'status', '--porcelain')).toBe('');
    }
    await file(join(second, '.gitignore'), '');
    const drift = await projectProjectionPlan(f.ctx, { project: f.project, scope: 'global_to_project', entry: 'unselected', worktrees: true });
    expect(drift.conflicts.join('\n')).toContain(`${second}/.agents/skills/unselected`);
    await expect(applyPlan(f.ctx, drift)).rejects.toMatchObject({ code: 'PLAN_CONFLICT' });
  });
});
