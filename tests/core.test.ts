import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createAicatlog, context, registrySchema } from '../src/index.ts';
import { makePlan, operation, applyPlan } from '../src/plans.ts';
import { refreshCatalog, readResource, selectResource } from '../src/registry.ts';
import { run, saveJson } from '../src/io.ts';
import { skillsPlan } from '../src/skills.ts';
import { bootstrap, checkFoundation } from '../src/foundation.ts';
import type { Context } from '../src/types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function file(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function fixture(kind: 'documents' | 'skills' = 'documents') {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-')); roots.push(root);
  const corpus = join(root, 'corpus'); await mkdir(corpus);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), sessionId: 'fixture-session' });
  await saveJson(ctx.registryPath, registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [{ id: 'fixture', root: corpus, kind }], settings: { skills_root: corpus, default_skill_scope: 'fixture' } }));
  return { root, corpus, ctx, api: createAicatlog(ctx) };
}

describe('progressive resource access', () => {
  test('metadata discovery keeps bodies out; topic reads use current source and digests', async () => {
    const f = await fixture(); const path = join(f.corpus, 'guide.txt');
    await file(path, '{"id":"guide","when":"recover a task"}\nBEGIN_TOPIC resume\nold state\nEND_TOPIC resume\n');
    const list = await f.api.call('find', { query: 'recover' }) as any;
    expect(list.items).toHaveLength(1); expect(list.items[0].text).toBeUndefined();
    const old = await readResource(f.ctx, 'fixture:guide', { section: 'resume' });
    await file(path, '{"id":"guide","when":"recover a task"}\nBEGIN_TOPIC resume\ncurrent state\nEND_TOPIC resume\n');
    const fresh = await readResource(f.ctx, 'fixture:guide', { section: 'resume' });
    expect(fresh.text).toContain('current state'); expect(fresh.source.sha256).not.toBe(old.source.sha256);
  });
  test('duplicate skill names retain qualified identity', async () => {
    const f = await fixture('skills');
    for (const name of ['alpha', 'beta']) await file(join(f.corpus, name, 'SKILL.md'), '---\nname: shared\ndescription: |\n  Find an exact thing.\n---\nbody\n');
    const catalog = await refreshCatalog(f.ctx);
    expect(catalog.resources.filter(r => r.name === 'shared')).toHaveLength(2);
    await expect(selectResource(f.ctx, 'shared')).rejects.toMatchObject({ code: 'AMBIGUOUS_RESOURCE' });
  });
  test('malformed metadata is unavailable rather than a successful empty source', async () => {
    const f = await fixture('skills'); await file(join(f.corpus, 'bad', 'SKILL.md'), '---\nname: bad\ndescription: missing delimiter');
    expect((await refreshCatalog(f.ctx)).errors.length).toBe(1);
  });
  test('topic pagination advances within the selected section', async () => {
    const f = await fixture(); await file(join(f.corpus, 'long.txt'), '{"id":"long"}\nBEGIN_TOPIC body\none\ntwo\nthree\nEND_TOPIC body\n');
    const first = await readResource(f.ctx, 'fixture:long', { section: 'body', limit: 2 });
    const next = await readResource(f.ctx, 'fixture:long', { section: 'body', line: first.next_line!, limit: 2 });
    expect(next.text).toBe('two\nthree');
  });
  test('a manifest cannot route a read outside its registered corpus', async () => {
    const f = await fixture(); await file(join(f.root, 'outside.txt'), 'outside data');
    await saveJson(join(f.corpus, 'manifest.json'), { resources: [{ id: 'escape', path: '../outside.txt' }] });
    const registry = JSON.parse(await readFile(f.ctx.registryPath, 'utf8')); registry.scopes[0].manifests = ['manifest.json']; await saveJson(f.ctx.registryPath, registry);
    const catalog = await refreshCatalog(f.ctx); expect(catalog.errors.some(e => e.code === 'OUTSIDE_SCOPE')).toBe(true);
    await expect(selectResource(f.ctx, 'fixture:escape')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('one command contract across interfaces', () => {
  test('CLI structured input works without positional duplication', async () => {
    const f = await fixture(); await file(join(f.corpus, 'a.txt'), '{"id":"a"}\nhello source\n');
    const result = await run([process.execPath, join(import.meta.dir, '../src/bin.ts'), '--registry', f.ctx.registryPath, '--state', f.ctx.stateRoot, '--cache', f.ctx.cacheRoot,
      'read', '--input', '{"id":"fixture:a"}', '--json', '--full-output']);
    expect(result.exit_code).toBe(0); expect(JSON.parse(result.stdout).data.text).toContain('hello source');
  });
  test('SDK and Fetch return the same selected resource', async () => {
    const f = await fixture(); await file(join(f.corpus, 'a.txt'), '{"id":"a"}\nhello\n');
    const sdk = await f.api.call('get', { id: 'fixture:a' });
    const response = await f.api.fetch(new Request('http://local/get/fixture%3Aa'));
    const data = await response.json() as any;
    if (response.status !== 200) throw new Error(JSON.stringify(data));
    expect(data.data).toEqual(sdk);
  });
  test('MCP is absent from help and transport; OpenAPI describes real reads', async () => {
    const f = await fixture();
    const help = await run([process.execPath, join(import.meta.dir, '../src/bin.ts'), '--help']); expect(help.stdout).not.toContain('--mcp');
    const rejected = await run([process.execPath, join(import.meta.dir, '../src/bin.ts'), '--mcp', '--json']); expect(rejected.exit_code).not.toBe(0);
    expect((await f.api.fetch(new Request('http://local/mcp', { method: 'POST' }))).status).toBe(404);
    const spec = await (await f.api.fetch(new Request('http://local/openapi.json'))).json() as any;
    expect(spec.paths['/read/{id}'].post ?? spec.paths['/read/{id}'].get).toBeDefined();
  });
  test('source-writing Fetch routes reject GET, including extra path segments', async () => {
    const f = await fixture();
    for (const path of ['/apply', '/apply/extra']) expect((await f.api.fetch(new Request(`http://local${path}`))).status).toBe(405);
  });
});

describe('prepared operations and foundation', () => {
  test('preflight prevents changing a destination that drifted after planning', async () => {
    const f = await fixture(); const path = join(f.corpus, 'owned.txt'); await file(path, 'before');
    const plan = await makePlan(f.ctx, 'fixture', [f.corpus], [await operation('write', path, { content: 'candidate' })]);
    await file(path, 'user change');
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'TARGET_CHANGED' }); expect(await readFile(path, 'utf8')).toBe('user change');
  });
  test('a successful plan is repeatable without applying twice', async () => {
    const f = await fixture(); const path = join(f.corpus, 'new.txt');
    const plan = await makePlan(f.ctx, 'fixture', [f.corpus], [await operation('write', path, { content: 'useful' })]);
    expect((await applyPlan(f.ctx, plan)).status).toBe('applied');
    expect((await applyPlan(f.ctx, plan)).already_applied).toBe(true);
  });
  test('source changes invalidate an installation plan', async () => {
    const f = await fixture('skills'); const source = join(f.root, 'source');
    await file(join(source, 'SKILL.md'), '---\nname: example\ndescription: Use for one exact task.\n---\nbody\n');
    const plan = await skillsPlan(f.ctx, 'install', { source, scope: 'fixture' });
    await file(join(source, 'new.txt'), 'new version');
    await expect(applyPlan(f.ctx, plan)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
  test('bootstrap preserves existing project instructions and validates its own files', async () => {
    const f = await fixture(); const repo = join(f.root, 'project'); await file(join(repo, 'AGENTS.md'), '# Project\nExisting product instruction.\n');
    const plan = await bootstrap(f.ctx, { repo, adopt: true }); expect(plan.conflicts).toHaveLength(0);
    await applyPlan(f.ctx, plan); expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toContain('Existing product instruction.');
    expect((await checkFoundation(repo)).ok).toBe(true);
    const repeat = await bootstrap(f.ctx, { repo, adopt: true }); expect(repeat.operations).toHaveLength(0);
  });
  test('external source owners are not replaced by the generic installer', async () => {
    const f = await fixture('skills'); const registry = JSON.parse(await readFile(f.ctx.registryPath, 'utf8'));
    registry.skills.push({ id: 'external', name: 'external', owner: 'external-kit', source: { kind: 'local', uri: f.corpus }, target: join(f.corpus, 'external') });
    await saveJson(f.ctx.registryPath, registry);
    await expect(skillsPlan(f.ctx, 'update', { id: 'external' })).rejects.toMatchObject({ code: 'EXTERNAL_OWNER' });
  });
  test('real install, update and removal preserve the selected package and omit repository metadata', async () => {
    const f = await fixture('skills'), source = join(f.root, 'source');
    await file(join(source, 'SKILL.md'), '---\nname: example\ndescription: One useful task.\n---\nversion one\n');
    await file(join(source, '.git/description'), 'repository metadata');
    const install = await skillsPlan(f.ctx, 'install', { source, scope: 'fixture' }); await applyPlan(f.ctx, install);
    expect(await Bun.file(join(f.corpus, 'example/SKILL.md')).exists()).toBe(true);
    expect(await Bun.file(join(f.corpus, 'example/.git/description')).exists()).toBe(false);
    await file(join(source, 'SKILL.md'), '---\nname: example\ndescription: One useful task.\n---\nversion two\n');
    await applyPlan(f.ctx, await skillsPlan(f.ctx, 'update', { id: 'fixture:example' }));
    expect(await readFile(join(f.corpus, 'example/SKILL.md'), 'utf8')).toContain('version two');
    await applyPlan(f.ctx, await skillsPlan(f.ctx, 'remove', { id: 'fixture:example' }));
    expect(await Bun.file(join(f.corpus, 'example/SKILL.md')).exists()).toBe(false);
  });
  test('resource metadata refreshes after a source edit and after a new document appears', async () => {
    const f = await fixture(); await file(join(f.corpus, 'a.txt'), '{"id":"a","when":"old-keyword"}\nbody\n');
    await f.api.call('catalog');
    await file(join(f.corpus, 'a.txt'), '{"id":"a","when":"new-keyword"}\nbody\n');
    expect((await f.api.call('find', { query: 'new-keyword' }) as any).total).toBe(1);
    await file(join(f.corpus, 'b.txt'), '{"id":"b","kind":"checkpoint","when":"new-keyword"}\nbody\n');
    expect((await f.api.call('find', { query: 'new-keyword' }) as any).total).toBe(2);
  });
});
test('external-owner sync remains possible but explicit or bulk normalization is refused', async () => {
  const f = await fixture('skills'); const source = join(f.corpus, 'owned'); await file(join(source, 'SKILL.md'), '---\nname: owned\ndescription: Owner fixture\n---\n');
  const registry = JSON.parse(await readFile(f.ctx.registryPath, 'utf8'));
  registry.skills = [{ id: 'owned', name: 'owned', owner: 'external-kit', target: source, source: { kind: 'local', uri: source } }];
  registry.clients = [{ id: 'bridge', root: join(f.root, 'bridge'), mode: 'bridge' }];
  registry.normalization_rules = [{ source_relative: 'owned', target_relative: 'normalized' }];
  await saveJson(f.ctx.registryPath, registry);
  const sync = await skillsPlan(f.ctx, 'sync', { id: 'owned' }); expect(sync.operations).toHaveLength(1); expect(sync.operations[0]?.action).toBe('link');
  await expect(skillsPlan(f.ctx, 'normalize', { id: 'owned' })).rejects.toMatchObject({ code: 'EXTERNAL_OWNER' });
  await expect(skillsPlan(f.ctx, 'normalize', {})).rejects.toMatchObject({ code: 'EXTERNAL_OWNER' });
});
