import { cp, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { cloneRepo, discover, parseSource } from '@aicatlog/skills-core';
import { AicatlogError, registrationSchema, type Context, type Registration, type Operation } from './types.ts';
import { expand, fingerprint, inside, now, run, sha } from './io.ts';
import { loadRegistry } from './registry.ts';
import { makePlan, operation } from './plans.ts';

async function materialize(ctx: Context, source: Registration['source']) {
  if (source.kind === 'cli') throw new AicatlogError('EXTERNAL_OWNER', 'CLI-served Skills must be obtained through their registered owner.', source);
  if (source.kind === 'local') return expand(source.uri, dirname(ctx.registryPath));
  const parsed = parseSource(source.uri);
  const directory = await cloneRepo(parsed.url, source.revision ?? parsed.ref);
  const revision = await run(['git', 'rev-parse', 'HEAD'], directory);
  if (revision.exit_code) throw new AicatlogError('SOURCE_UNAVAILABLE', revision.stderr);
  const cache = join(ctx.cacheRoot, 'sources', sha(`${parsed.url}:${revision.stdout.trim()}`));
  if (!await fingerprint(cache)) { await mkdir(dirname(cache), { recursive: true }); await cp(directory, cache, { recursive: true }); }
  return cache;
}

export async function skillsPlan(ctx: Context, action: string, input: { id?: string; source?: string; skill?: string; scope?: string; target?: string; client?: string }) {
  const registry = await loadRegistry(ctx);
  const roots: string[] = [dirname(ctx.registryPath)];
  const operations: Operation[] = [];
  const conflicts: string[] = [];
  const notes: string[] = [];
  let selected = input.id ? registry.skills.find(s => s.id === input.id || s.name === input.id) : undefined;
  if (input.id && !selected) throw new AicatlogError('REGISTRATION_NOT_FOUND', `No registered Skill ${input.id}`);
  if (['update', 'remove'].includes(action) && !selected) throw new AicatlogError('SELECTION_REQUIRED', 'Select one registered Skill.');
  if (selected && selected.owner !== 'aicatlog') throw new AicatlogError('EXTERNAL_OWNER', `Use ${selected.owner} to modify this projection.`, { registration: selected.id, source: selected.source, metadata: selected.metadata });
  if (action === 'install' || action === 'update') {
    if (!selected && !input.source) throw new AicatlogError('SOURCE_REQUIRED', 'Supply a registered id or explicit source.');
    const source: Registration['source'] = selected?.source ?? (() => {
      const parsed = parseSource(input.source!);
      return { kind: parsed.type === 'local' ? 'local' as const : 'git' as const, uri: parsed.localPath ?? parsed.url, ...(parsed.ref ? { revision: parsed.ref } : {}) };
    })();
    const materialized = await materialize(ctx, source);
    const base = source.entry ? expand(source.entry, materialized) : materialized;
    const discovered = await discover(base);
    const choices = discovered.skills.filter(s => !input.skill || s.name === input.skill || s.relativePath === input.skill);
    if (choices.length !== 1) throw new AicatlogError('SKILL_SELECTION_REQUIRED', 'Choose one exact Skill from the source.', { skills: choices.map(s => ({ name: s.name, path: s.relativePath })), errors: discovered.errors });
    const skill = choices[0]!;
    const scope = registry.scopes.find(s => s.id === (input.scope ?? selected?.metadata.scope ?? registry.settings.default_skill_scope));
    if (!scope && !selected?.target) throw new AicatlogError('SCOPE_REQUIRED', 'Select a registered installation scope.');
    const scopeRoot = scope ? expand(scope.root, dirname(ctx.registryPath)) : expand(String(registry.settings.skills_root));
    const target = expand(input.target ?? selected?.target ?? join(scopeRoot, skill.name.replace(/[^a-zA-Z0-9._-]/g, '-')));
    if (!inside(scopeRoot, target)) throw new AicatlogError('OUTSIDE_SCOPE', 'Installation target is outside its registered scope.');
    roots.push(scopeRoot);
    const sourceDirectory = dirname(skill.path);
    if (sourceDirectory === target || inside(sourceDirectory, target) || inside(target, sourceDirectory)) throw new AicatlogError('OVERLAPPING_PATHS', 'Installation must not replace the source tree.');
    const before = await fingerprint(target);
    if (before && action === 'install') conflicts.push(`Installation target already exists: ${target}; use the registered update operation.`);
    operations.push(await operation('copy', target, { source: sourceDirectory, excludes: ['.git', 'node_modules', '__pycache__', '.env', 'auth.json'] }));
    const entry = selected ?? registrationSchema.parse({ id: `${scope!.id}:${skill.name}`, name: skill.name, source, target,
      metadata: { scope: scope!.id, description: skill.description } });
    entry.state = 'active'; entry.target = target;
    if (!selected) registry.skills.push(entry);
    const observedRevision = source.kind === 'git' ? (await run(['git', 'rev-parse', 'HEAD'], materialized)).stdout.trim() : undefined;
    entry.metadata.installed_source = sourceDirectory; entry.metadata.installed_revision = observedRevision ?? null;
    entry.metadata.installed_at = now();
    notes.push('Source content and installation target are bound by the prepared fingerprints.');
  } else if (action === 'remove') {
    if (!selected!.target) throw new AicatlogError('NO_INSTALLATION', 'Registration has no target.');
    roots.push(dirname(expand(selected!.target!)));
    operations.push(await operation('remove', selected!.target!)); selected!.state = 'archived';
    notes.push('Original content is retained in the apply receipt backup.');
  } else if (action === 'sync') {
    const clients = registry.clients.filter(c => !input.client || c.id === input.client);
    if (input.client && clients.length !== 1) throw new AicatlogError('CLIENT_NOT_FOUND', `Unknown client ${input.client}`);
    for (const client of clients) {
      if (client.mode === 'native') { notes.push(`${client.id}: native shared discovery; no mirror`); continue; }
      const root = expand(String(client.root)); roots.push(root);
      for (const skill of registry.skills.filter(s => s.state === 'active' && s.target && (!selected || s.id === selected.id))) {
        if (skill.clients.length && !skill.clients.includes(String(client.id))) continue;
        const target = join(root, String(skill.metadata.bridge_name ?? basename(expand(skill.target!))));
        const source = expand(skill.target!);
        if (!await fingerprint(source)) { conflicts.push(`Missing projection source: ${source}`); continue; }
        const existing = await fingerprint(target);
        if (existing === `link:${source}`) continue;
        if (existing !== null) { conflicts.push(`Foreign or changed bridge: ${target}`); continue; }
        operations.push(await operation('link', target, { source }));
      }
    }
  } else if (action === 'normalize') {
    const root = expand(String(registry.settings.skills_root)); roots.push(root);
    for (const rule of registry.normalization_rules) {
      const source = join(root, String(rule.source_relative)), target = join(root, String(rule.target_relative));
      if (!await fingerprint(source)) continue;
      if (await fingerprint(target)) { conflicts.push(`Normalization target exists: ${target}`); continue; }
      operations.push(await operation('copy', target, { source }), await operation('remove', source));
    }
  } else throw new AicatlogError('UNKNOWN_OPERATION', action);
  if (['install', 'update', 'remove'].includes(action)) operations.push(await operation('write', ctx.registryPath, { content: JSON.stringify(registry, null, 2) + '\n' }));
  return makePlan(ctx, `skills.${action}`, roots, operations, conflicts, notes);
}

export async function skillsStatus(ctx: Context) {
  const registry = await loadRegistry(ctx);
  const items = await Promise.all(registry.skills.map(async skill => ({ id: skill.id, name: skill.name, owner: skill.owner,
    state: skill.state, activation: skill.activation, target: skill.target ?? null,
    observed: skill.target ? (await fingerprint(expand(skill.target))) !== null ? 'present' : 'missing' : 'not_installed' })));
  return { items, issues: items.filter(x => x.state === 'active' && x.target && x.observed === 'missing'), total: items.length };
}
