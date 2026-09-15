import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { discover, readSkill } from '@aicatlog/skills-core';
import { registrySchema, resourceSchema, AicatlogError, type Registry, type Catalog, type Context, type Resource, type Scope } from './types.ts';
import { expand, inside, jsonFile, now, saveJson, sha } from './io.ts';
import { contextProfile, inspectContextSource, selectContextSection } from './context.ts';

export async function loadRegistry(ctx: Context): Promise<Registry> {
  return registrySchema.parse(await jsonFile(ctx.registryPath));
}
export const registryDigest = async (ctx: Context) => sha(await readFile(ctx.registryPath));
export const catalogPath = (ctx: Context) => join(ctx.cacheRoot, 'catalogs', `${sha(ctx.registryPath)}.json`);

function aliasIssues(registry: Registry, resources: Resource[]) {
  const aliases = registry.settings.resource_aliases ?? {};
  const issues: { code: string; id: string; message: string }[] = [];
  for (const [id, target] of Object.entries(aliases)) {
    const problem = (code: string, message: string) => issues.push({ code, id, message: `Resource alias ${JSON.stringify(id)}: ${message}` });
    if (resources.some(r => r.id === id)) { problem('ALIAS_SHADOWS_RESOURCE', 'cannot shadow a real resource ID.'); continue; }
    const matching = resources.filter(r => r.id === target);
    if (matching.length && /^[^:\s]+:.+$/.test(target)) {
      if (matching.length > 1) problem('ALIAS_AMBIGUOUS_TARGET', `target ${JSON.stringify(target)} has duplicate resource rows.`);
      continue;
    }
    const visited = new Set([id]); let cursor = target;
    while (Object.hasOwn(aliases, cursor) && !visited.has(cursor)) { visited.add(cursor); cursor = aliases[cursor]!; }
    if (visited.has(cursor)) { problem('ALIAS_CYCLE', 'cycle detected; map directly to a canonical qualified resource ID.'); continue; }
    if (Object.hasOwn(aliases, target)) { problem('ALIAS_TARGET_IS_ALIAS', 'alias chains are not supported; map directly to a canonical qualified resource ID.'); continue; }
    if (!/^[^:\s]+:.+$/.test(target)) { problem('ALIAS_TARGET_NOT_CANONICAL', 'target must be a qualified resource ID.'); continue; }
    problem('ALIAS_DANGLING', `target ${JSON.stringify(target)} is not registered.`);
  }
  return issues;
}

function skillResource(scope: Scope, skill: Awaited<ReturnType<typeof readSkill>>, registry: Registry, base: string): Resource {
  const path = expand(skill.path);
  const registration = registry.skills.find(s => s.target && inside(expand(s.target, base), path));
  const invocation = skill.metadata.metadata as Record<string, unknown> | undefined;
  return {
    id: `${scope.id}:${skill.relativePath.replaceAll('\\', '/')}`, name: skill.name, kind: 'skill', scope: scope.id,
    owner: registration?.owner ?? 'source', summary: skill.description, when: skill.description, path, children: [],
    activation: registration?.state === 'disabled' ? 'disabled' : registration?.activation ?? 'on_demand',
    source: { ...(registration?.source ?? {}), registration_id: registration?.id ?? null, metadata: invocation ?? {} },
  };
}

export async function refreshCatalog(ctx: Context): Promise<Catalog> {
  const registry = await loadRegistry(ctx);
  const resources: Resource[] = registry.resources.map(r => ({ ...r, children: [...r.children], ...(r.path ? { path: expand(r.path, dirname(ctx.registryPath)) } : {}) }));
  const errors: Catalog['errors'] = [];
  const manifestSeen = new Set<string>();
  const stampPaths = new Set<string>();
  async function manifest(path: string, scope: Scope, parent?: string): Promise<void> {
    const canonical = await realpath(path);
    const readRoots = await Promise.all([scope.root, ...scope.linked_roots].map(r => realpath(expand(r, dirname(ctx.registryPath)))));
    if (!readRoots.some(r => inside(r, canonical))) throw new AicatlogError('OUTSIDE_SCOPE', 'Manifest file leaves declared read roots.');
    if (manifestSeen.has(canonical)) return;
    manifestSeen.add(canonical);
    stampPaths.add(canonical);
    const data = await jsonFile<Record<string, unknown>>(path);
    const rows = (data.resources ?? data.topics ?? data.entries ?? []) as Record<string, unknown>[];
    if (!Array.isArray(rows)) throw new AicatlogError('INVALID_MANIFEST', `Manifest entries must be an array: ${path}`);
    for (const row of rows) {
      const root = expand(scope.root, dirname(ctx.registryPath));
      const entryPath = typeof row.path === 'string' ? expand(row.path, scope.manifest_base === 'root' ? root : dirname(path)) : undefined;
      if (entryPath && !inside(root, entryPath) && !scope.linked_roots.some(r => inside(expand(r, dirname(ctx.registryPath)), entryPath))) {
        errors.push({ code: 'OUTSIDE_SCOPE', path: entryPath, message: 'Manifest pointer leaves its declared corpus roots' }); continue;
      }
      const id = String(row.id ?? row.name ?? '');
      if (!id) { errors.push({ code: 'INVALID_MANIFEST', path, message: 'Entry lacks id' }); continue; }
      const qualified = id.includes(':') ? id : `${parent ?? scope.id}:${id}`;
      resources.push(resourceSchema.parse({ ...row, id: qualified, name: String(row.name ?? row.id),
        kind: row.kind ?? 'document', scope: scope.id, owner: row.owner ?? 'source', path: entryPath,
        summary: String(row.summary ?? row.when ?? ''), parent,
        topics: row.begin_marker && row.end_marker ? [{ id, begin: row.begin_marker, end: row.end_marker }] : row.topics,
        children: row.children ?? [] }));
    }
    for (const child of (data.manifests ?? []) as string[]) await manifest(expand(child, dirname(path)), scope, parent);
  }
  for (const scope of registry.scopes) {
    const root = expand(scope.root, dirname(ctx.registryPath));
    if (!await stat(root).catch(() => null)) { errors.push({ code: 'SOURCE_UNAVAILABLE', path: root, message: 'Registered root is unavailable' }); continue; }
    resources.push({ id: scope.id, name: scope.id, kind: 'collection', scope: scope.id, owner: 'registry',
      summary: `${scope.kind} resources`, path: root, children: [] });
    if (scope.kind === 'skills' || scope.kind === 'market' || scope.kind === 'repo') {
      const result = await discover(root, { excludes: scope.excludes, linkedRoots: scope.linked_roots.map(p => expand(p, dirname(ctx.registryPath))) });
      for (const path of result.directories) stampPaths.add(path);
      const selected = result.skills.map(skill => ({ ...skillResource(scope, skill, registry, dirname(ctx.registryPath)), parent: scope.id }));
      resources.push(...selected);
      for (const [index, skill] of result.skills.entries()) {
        const metadata = skill.metadata.metadata as Record<string, unknown> | undefined;
        if (typeof metadata?.aicatlog_manifest === 'string') {
          const path = expand(metadata.aicatlog_manifest, dirname(skill.path));
          try { await manifest(path, scope, selected[index]!.id); }
          catch (error) { errors.push({ code: 'MANIFEST_UNAVAILABLE', path, message: String(error) }); }
        }
      }
      errors.push(...result.errors.map(e => ({ code: 'SKILL_METADATA_INVALID', ...e })));
    }
    for (const entry of scope.manifests) {
      try { await manifest(expand(entry, root), scope, scope.id); }
      catch (error) { errors.push({ code: 'MANIFEST_UNAVAILABLE', path: entry, message: String(error) }); }
    }
    if ((scope.kind === 'documents' || scope.kind === 'repo') && scope.discovery === 'recursive') {
      const visited = new Set<string>();
      async function walk(directory: string): Promise<void> {
        const canonical = await realpath(directory);
        if (visited.has(canonical) || !inside(await realpath(root), canonical)) return;
        visited.add(canonical);
        stampPaths.add(canonical);
        for (const e of await readdir(directory, { withFileTypes: true })) {
          if (scope.excludes.includes(e.name) || e.name.startsWith('.env')) continue;
          const path = join(directory, e.name);
          if (e.isDirectory()) await walk(path);
          else if (e.isFile() && ['.txt', '.md'].includes(extname(path))) {
            const raw = await readFile(path, 'utf8');
            let meta: Record<string, unknown> = {};
            try { const parsed = JSON.parse(raw.split(/\r?\n/, 1)[0]!); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed; } catch { /* Legacy source remains a readable resource. */ }
            const rel = relative(root, path).replaceAll('\\', '/');
            const id = `${scope.id}:${String(meta.id ?? rel)}`;
            const topics = [...raw.matchAll(/^BEGIN_TOPIC (.+)$/gm)].map(m => ({ id: m[1]!, begin: m[0], end: `END_TOPIC ${m[1]}` }));
            if (!resources.some(r => r.path === path && r.scope === scope.id)) resources.push(resourceSchema.parse({
              ...meta, id, name: meta.name ?? basename(path), kind: meta.kind ?? (basename(path) === 'AGENTS.md' ? 'governance' : 'document'),
              scope: scope.id, owner: meta.owner ?? 'source', summary: meta.summary ?? meta.when ?? rel,
              path, parent: scope.id, children: [], topics,
            }));
          }
        }
      }
      try { await walk(root); } catch (error) { errors.push({ code: 'SOURCE_READ_ERROR', path: root, message: String(error) }); }
    }
  }
  const ids = new Set<string>();
  for (const resource of resources) {
    if (resource.path) resource.path = await realpath(resource.path).catch(() => resource.path!);
    if (resource.path) stampPaths.add(resource.path);
    if (ids.has(resource.id)) errors.push({ code: 'DUPLICATE_ID', path: resource.path, message: resource.id });
    ids.add(resource.id);
    if (resource.parent) resources.find(r => r.id === resource.parent)?.children.push(resource.id);
  }
  resources.sort((a, b) => a.id.localeCompare(b.id));
  errors.push(...aliasIssues(registry, resources).map(({ code, message }) => ({ code, message })));
  const source_stamps: Record<string, string> = {};
  for (const path of stampPaths) source_stamps[path] = await stamp(path);
  const catalog: Catalog = { schema_version: 'aicatlog.catalog.v1', generated_at: now(), registry_sha256: await registryDigest(ctx), resources, errors, source_stamps };
  await saveJson(catalogPath(ctx), catalog);
  return catalog;
}

export async function getCatalog(ctx: Context): Promise<Catalog> {
  let result: Catalog;
  try { result = await jsonFile<Catalog>(catalogPath(ctx)); } catch { return refreshCatalog(ctx); }
  if (result.registry_sha256 !== await registryDigest(ctx) || !result.source_stamps) return refreshCatalog(ctx);
  const changed = await Promise.all(Object.entries(result.source_stamps).map(async ([path, before]) => await stamp(path) !== before));
  return changed.some(Boolean) ? refreshCatalog(ctx) : result;
}
async function stamp(path: string): Promise<string> {
  const value = await stat(path).catch(() => null);
  return value ? `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}` : 'missing';
}

export async function selectResource(ctx: Context, id: string): Promise<Resource> {
  const catalog = await getCatalog(ctx);
  const exact = catalog.resources.find(r => r.id === id);
  if (exact) return exact;
  const registry = await loadRegistry(ctx);
  const aliases = registry.settings.resource_aliases ?? {};
  if (Object.hasOwn(aliases, id)) {
    const issue = aliasIssues(registry, catalog.resources).find(issue => issue.id === id);
    if (issue) throw new AicatlogError(issue.code, issue.message);
    const canonical = catalog.resources.find(r => r.id === aliases[id])!;
    return { ...canonical, resolution: { requested_id: id, canonical_id: canonical.id, via: 'alias' } };
  }
  const matching = catalog.resources.filter(r => r.name === id);
  if (matching.length === 1) return matching[0]!;
  if (matching.length) throw new AicatlogError('AMBIGUOUS_RESOURCE', `Use a qualified id for ${id}`, { candidates: matching.map(r => r.id) });
  throw new AicatlogError('RESOURCE_NOT_FOUND', `No registered resource matches ${id}`, { next: 'aicatlog find <query>' });
}

export async function listResources(ctx: Context, options: { query?: string; kind?: string; scope?: string; limit?: number; cursor?: number } = {}) {
  const catalog = await getCatalog(ctx);
  const terms = (options.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = catalog.resources.filter(r => (!options.kind || r.kind === options.kind) && (!options.scope || r.scope === options.scope))
    .filter(r => terms.every(term => `${r.id} ${r.name} ${r.summary} ${r.when ?? ''}`.toLocaleLowerCase().includes(term)));
  const start = options.cursor ?? 0, limit = options.limit ?? 20;
  return { items: matching.slice(start, start + limit), total: matching.length,
    next_cursor: start + limit < matching.length ? start + limit : null,
    catalog_generated_at: catalog.generated_at, diagnostics: catalog.errors };
}

async function resourceSource(ctx: Context, id: string) {
  const resource = await selectResource(ctx, id);
  if (!resource.path) throw new AicatlogError('NO_DOCUMENT', `Resource ${id} has no source document`);
  const registry = await loadRegistry(ctx);
  const scope = registry.scopes.find(s => s.id === resource.scope);
  const resolved = await realpath(resource.path).catch(() => resource.path!);
  const roots = await Promise.all((scope ? [scope.root, ...scope.linked_roots] : []).map(r => realpath(expand(r, dirname(ctx.registryPath))).catch(() => expand(r, dirname(ctx.registryPath)))));
  if (!roots.some(r => inside(r, resolved))) throw new AicatlogError('OUTSIDE_SCOPE', 'Source is outside registered read roots.');
  const bytes = await readFile(resolved).catch(error => { throw new AicatlogError('SOURCE_UNAVAILABLE', `Cannot read ${resolved}`, { reason: String(error) }); });
  const lines = bytes.toString('utf8').split(/\r?\n/);
  return { resource, bytes, lines, resolved };
}

export async function inspectContext(ctx: Context, id: string) {
  const { resource, bytes, lines, resolved } = await resourceSource(ctx, id);
  const profile = contextProfile(resource);
  if (!profile) throw new AicatlogError('UNSUPPORTED_CONTEXT_RESOURCE', `Resource ${resource.id} is not declared as context; declare document_role and context_format in its manifest.`);
  return { schema_version: 'aicatlog.context.v1' as const, id: resource.id, ...(resource.resolution ? { resolution: resource.resolution } : {}), ...profile,
    source: { path: resolved, sha256: sha(bytes), start_line: 1, end_line: lines.length, current_read_at: now() }, ...inspectContextSource(lines, profile) };
}

export async function readResource(ctx: Context, id: string, options: { section?: string; line?: number; limit?: number } = {}) {
  const { resource, bytes, lines, resolved } = await resourceSource(ctx, id);
  let start = Math.max(0, (options.line ?? 1) - 1), end = lines.length;
  if (options.section) {
    const topic = resource.topics?.find(t => t.id === options.section);
    const begin = topic?.begin ?? `BEGIN_TOPIC ${options.section}`, finish = topic?.end ?? `END_TOPIC ${options.section}`;
    start = lines.indexOf(begin); end = lines.indexOf(finish, start + 1) + 1;
    if (topic || start >= 0) {
      if (start < 0 || end <= start) throw new AicatlogError('SECTION_NOT_FOUND', `Missing topic ${options.section} in current source`);
    } else {
      const profile = contextProfile(resource);
      if (!profile) throw new AicatlogError('SECTION_NOT_FOUND', `Missing topic ${options.section} in current source`);
      const section = selectContextSection(inspectContextSource(lines, profile).sections, options.section);
      start = section.start_line - 1; end = section.end_line;
    }
    start = Math.max(start, (options.line ?? 1) - 1);
  }
  const actualEnd = Math.min(end, start + (options.limit ?? 200));
  return { id: resource.id, ...(resource.resolution ? { resolution: resource.resolution } : {}), source: { path: resolved, sha256: sha(bytes), start_line: start + 1, end_line: actualEnd, current_read_at: now() },
    text: lines.slice(start, actualEnd).join('\n'), next_line: actualEnd < end ? actualEnd + 1 : null };
}

export async function checkRegistry(ctx: Context) {
  const registry = await loadRegistry(ctx);
  const issues: { code: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const entry of [...registry.scopes, ...registry.skills]) {
    if (seen.has(entry.id)) issues.push({ code: 'DUPLICATE_ID', id: entry.id });
    seen.add(entry.id);
  }
  for (const entry of registry.skills) if (entry.target && !registry.scopes.some(s => inside(expand(s.root, dirname(ctx.registryPath)), expand(entry.target!, dirname(ctx.registryPath)))))
    issues.push({ code: 'TARGET_OUTSIDE_SCOPES', id: entry.id });
  if (registry.settings.resource_aliases) issues.push(...aliasIssues(registry, (await getCatalog(ctx)).resources));
  return { ok: !issues.length, schema_version: registry.schema_version, registrations: registry.skills.length,
    scopes: registry.scopes.length, issues };
}
