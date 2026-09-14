import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AicatlogError, type Context, type Operation } from './types.ts';
import { assertContained, expand, fingerprint, inside, run } from './io.ts';
import { loadRegistry } from './registry.ts';
import { makePlan, operation } from './plans.ts';

export type ProjectProjectionInput = {
  project: string; scope: 'global_to_project' | 'project'; entry?: string; client?: string; worktrees?: boolean;
};

function exactEntry(entry: string): string {
  if (!entry || entry.startsWith('.') || /[/\\\0*?\[\]]/.test(entry))
    throw new AicatlogError('INVALID_ENTRY', 'Select one exact, non-hidden top-level Skill or collection name.');
  return entry;
}

async function gitRoot(directory: string): Promise<string> {
  const result = await run(['git', 'rev-parse', '--show-toplevel'], directory);
  if (result.exit_code || result.timed_out) throw new AicatlogError('PROJECT_UNAVAILABLE', `Not an available Git worktree: ${directory}`);
  return realpath(result.stdout.replace(/\r?\n$/, ''));
}

async function projectRoots(project: string, worktrees: boolean, notes: string[]): Promise<string[]> {
  const selected = await realpath(expand(project));
  const root = await gitRoot(selected);
  if (selected !== root) throw new AicatlogError('PROJECT_ROOT_REQUIRED', 'Select the exact Git worktree root.');
  if (!worktrees) return [root];
  const inventory = await run(['git', 'worktree', 'list', '--porcelain', '-z'], root);
  if (inventory.exit_code || inventory.timed_out) throw new AicatlogError('WORKTREE_INVENTORY_UNAVAILABLE', inventory.stderr);
  const roots = new Set<string>();
  for (const record of inventory.stdout.split('\0\0').filter(Boolean)) {
    const fields = record.split('\0'), path = fields.find(f => f.startsWith('worktree '))?.slice(9);
    if (!path) throw new AicatlogError('INVALID_WORKTREE_INVENTORY', 'Worktree inventory has no root.');
    if (fields.some(f => f === 'bare' || f.startsWith('prunable'))) { notes.push(`${path}: unavailable or prunable worktree; skipped`); continue; }
    try {
      const canonical = await realpath(path);
      if (await gitRoot(canonical) !== canonical) throw new Error('Not the registered worktree root');
      roots.add(canonical);
    } catch { notes.push(`${path}: unavailable worktree; skipped`); }
  }
  return [...roots];
}

async function ignoredUntrackedTarget(root: string, target: string): Promise<void> {
  await assertContained(root, target);
  let parent = dirname(target);
  while (!await stat(parent).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) parent = dirname(parent);
  if (await gitRoot(parent) !== root) throw new AicatlogError('FOREIGN_REPOSITORY', `Target belongs to another Git repository: ${target}`);
  const path = relative(root, target);
  const tracked = await run(['git', 'ls-files', '--cached', '-z', '--', `:(literal)${path}`], root);
  if (tracked.exit_code || tracked.timed_out) throw new AicatlogError('GIT_CHECK_UNAVAILABLE', `Cannot inspect tracked target: ${target}`);
  if (tracked.stdout) throw new AicatlogError('TRACKED_TARGET', `Projection target is tracked: ${target}`);
  const ignored = await run(['git', 'check-ignore', '--quiet', '--', path], root);
  if (ignored.exit_code !== 0 || ignored.timed_out) throw new AicatlogError('TARGET_NOT_IGNORED', `Projection target must be ignored by its Git worktree: ${target}`);
}

export async function projectProjectionPlan(ctx: Context, input: ProjectProjectionInput) {
  if (!['global_to_project', 'project'].includes(input.scope)) throw new AicatlogError('INVALID_SCOPE', 'Select global_to_project or project.');
  if (input.scope === 'global_to_project' && !input.entry) throw new AicatlogError('SELECTION_REQUIRED', 'global_to_project requires one exact --entry.');
  if (input.entry !== undefined) exactEntry(input.entry);
  if (input.scope === 'global_to_project' && input.client) throw new AicatlogError('INVALID_CLIENT_SCOPE', 'Select clients only for project bridge projection.');
  const registry = await loadRegistry(ctx), registryBase = dirname(ctx.registryPath);
  const operations: Operation[] = [], conflicts: string[] = [], notes: string[] = [];
  const roots = await projectRoots(input.project, input.worktrees ?? false, notes);
  const clients = input.scope === 'project' ? registry.project_clients.filter(c => !input.client || (c.id ?? c.name) === input.client) : [];
  if (input.client && clients.length !== 1) throw new AicatlogError('CLIENT_NOT_FOUND', `Unknown or ambiguous project client ${input.client}`);

  async function link(root: string, scope: string, source: string, target: string) {
    try {
      if (!inside(scope, target) || scope === target) throw new AicatlogError('OUTSIDE_SCOPE', `Target leaves its fixed projection scope: ${target}`);
      await ignoredUntrackedTarget(root, target);
      if (!(await stat(source)).isDirectory()) throw new AicatlogError('SOURCE_UNAVAILABLE', `Not a Skill or collection directory: ${source}`);
      const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing?.isSymbolicLink() && (await fingerprint(target) === `link:${source}` || await realpath(target).catch(() => null) === await realpath(source))) {
        notes.push(`${target}: equivalent link; unchanged`); return;
      }
      if (existing) throw new AicatlogError('FOREIGN_TARGET', `Foreign or changed projection target: ${target}`);
      if (inside(source, target) || inside(target, source)) throw new AicatlogError('OVERLAPPING_PATHS', `Projection overlaps its source: ${target}`);
      operations.push(await operation('link', target, { source, git_root: root, excludes: ['.git', 'node_modules', '__pycache__', '.env', 'auth.json'] }));
    } catch (error) { conflicts.push(error instanceof AicatlogError ? `${error.code}: ${error.message}` : `PROJECTION_UNAVAILABLE: ${target}: ${String(error)}`); }
  }

  if (input.scope === 'global_to_project') {
    if (typeof registry.settings.skills_root !== 'string' || !registry.settings.skills_root)
      throw new AicatlogError('SCOPE_REQUIRED', 'Registry settings.skills_root must name the shared Skills source.');
    const source = join(expand(registry.settings.skills_root, registryBase), input.entry!);
    const registrations = registry.skills.filter(s => s.target && expand(s.target, registryBase) === source);
    if (registrations.length && !registrations.some(s => s.state === 'active'))
      throw new AicatlogError('INACTIVE_RESOURCE', `Selected Skill is not active: ${input.entry}`);
    for (const root of roots) {
      const scope = join(root, '.agents', 'skills');
      await link(root, scope, source, join(scope, input.entry!));
    }
  } else {
    for (const root of roots) {
      const sourceRoot = join(root, '.agents', 'skills');
      const bridges = new Set<string>();
      for (const client of clients) {
        const name = String(client.id ?? client.name ?? 'unnamed');
        if (client.sync_policy === 'native_no_sync' || client.mode === 'native') { notes.push(`${root}: ${name}: native shared discovery; no mirror`); continue; }
        const path = client.relative_path;
        if (client.sync_policy !== 'project_bridge' || typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[/\\]/).some(p => p === '..' || p === '.git') ||
            (client.source_relative_path !== undefined && client.source_relative_path !== '.agents/skills')) {
          conflicts.push(`INVALID_PROJECT_CLIENT: ${name}: expected a registered project_bridge with a relative target and .agents/skills source`); continue;
        }
        const destinationRoot = resolve(root, path);
        if (!inside(root, destinationRoot) || inside(destinationRoot, sourceRoot) || inside(sourceRoot, destinationRoot)) {
          conflicts.push(`OUTSIDE_SCOPE: ${name}: client target must be a separate project projection scope`); continue;
        }
        bridges.add(destinationRoot);
      }
      if (!bridges.size) continue;
      let entries: string[];
      try {
        await assertContained(root, join(sourceRoot, '_scope_check'));
        entries = input.entry ? [input.entry] : (await readdir(sourceRoot, { withFileTypes: true }))
          .filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map(e => e.name).sort();
      } catch (error) { conflicts.push(`PROJECT_SOURCE_UNAVAILABLE: ${sourceRoot}: ${String(error)}`); continue; }
      if (!entries.length) notes.push(`${sourceRoot}: no project Skill entries to bridge`);
      for (const bridge of bridges) for (const entry of entries) await link(root, bridge, join(sourceRoot, entry), join(bridge, entry));
    }
  }
  return makePlan(ctx, `skills.sync.${input.scope}`, roots, operations, conflicts, notes);
}
