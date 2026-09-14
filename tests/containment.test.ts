import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, registrySchema } from '../src/index.ts';
import { refreshCatalog } from '../src/registry.ts';
import { skillsPlan } from '../src/skills.ts';
import { run, saveJson } from '../src/io.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-containment-')); roots.push(root);
  const corpus = join(root, 'skills'); await mkdir(corpus);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache') });
  const registry = registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [{ id: 'skills', root: 'skills', kind: 'skills' }] });
  await saveJson(ctx.registryPath, registry); return { root, corpus, ctx, registry };
}
test('portable registration removal resolves against the registry in another caller directory', async () => {
  const f = await fixture(); await mkdir(join(f.corpus, 'pkg'));
  await writeFile(join(f.corpus, 'pkg', 'SKILL.md'), '---\nname: pkg\ndescription: fixture\n---\n');
  f.registry.skills.push({ id: 'pkg', name: 'pkg', source: { kind: 'local', uri: 'source' }, target: 'skills/pkg', owner: 'aicatlog', state: 'active', activation: 'native', clients: [], metadata: {} });
  await saveJson(f.ctx.registryPath, f.registry);
  const expected = await skillsPlan(f.ctx, 'remove', { id: 'pkg' });
  const other = join(f.root, 'other'); await mkdir(other);
  const script = join(f.root, 'plan.ts'); await writeFile(script, `import { skillsPlan } from ${JSON.stringify(join(import.meta.dir, '../src/skills.ts'))}; console.log(JSON.stringify(await skillsPlan(${JSON.stringify(f.ctx)}, 'remove', {id:'pkg'})));`);
  const replay = await run([process.execPath, '--no-env-file', script], other); expect(replay.exit_code).toBe(0);
  const actual = JSON.parse(replay.stdout);
  expect(actual.conflicts).toEqual([]); expect(actual.operations[0].target).toBe(join(f.corpus, 'pkg'));
  expect(actual.operations).toEqual(expected.operations);
});
test('Skill file symlinks and nested manifests cannot expose external metadata', async () => {
  const f = await fixture(); const linked = join(f.corpus, 'linked'); await mkdir(linked);
  const external = join(f.root, 'external.md');
  await writeFile(external, '---\nname: forbidden-secret-marker\ndescription: outside the declared scope\n---\n');
  await symlink(external, join(linked, 'SKILL.md'));
  const externalManifest = join(f.root, 'external.json');
  await saveJson(externalManifest, { resources: [{ id: 'forbidden-manifest-marker', path: external }] });
  await saveJson(join(f.corpus, 'manifest.json'), { manifests: ['../external.json'] });
  f.registry.scopes[0]!.manifests = ['manifest.json']; await saveJson(f.ctx.registryPath, f.registry);
  const catalog = await refreshCatalog(f.ctx);
  expect(catalog.resources.some(r => r.name.includes('forbidden'))).toBe(false);
  expect(catalog.errors.length).toBe(2);
  expect(catalog.errors.some(e => e.message.includes('Manifest file leaves'))).toBe(true);
});
test('ambiguous registration names cannot select a mutation owner implicitly', async () => {
  const f = await fixture();
  for (const id of ['one', 'two']) f.registry.skills.push({ id, name: 'duplicate', source: { kind: 'local', uri: 'source' }, target: 'skills/' + id, owner: 'aicatlog', state: 'active', activation: 'native', clients: [], metadata: {} });
  await saveJson(f.ctx.registryPath, f.registry);
  await expect(skillsPlan(f.ctx, 'remove', { id: 'duplicate' })).rejects.toMatchObject({ code: 'AMBIGUOUS_REGISTRATION' });
});
test('normalization refuses in-root parent aliases and recognizes registered ownership aliases', async () => {
  const f = await fixture(); const owner = join(f.corpus, 'owner'); await mkdir(join(owner, 'entry'), { recursive: true });
  await writeFile(join(owner, 'entry', 'SKILL.md'), 'owner content');
  await symlink(owner, join(f.corpus, 'alias'));
  f.registry.settings.skills_root = f.corpus;
  f.registry.skills.push({ id: 'external', name: 'external', owner: 'external-kit', source: { kind: 'local', uri: owner }, target: 'skills/owner/entry', state: 'active', activation: 'native', clients: [], metadata: {} });
  f.registry.normalization_rules = [{ source_relative: 'alias/entry', target_relative: 'normalized' }]; await saveJson(f.ctx.registryPath, f.registry);
  await expect(skillsPlan(f.ctx, 'normalize', {})).rejects.toMatchObject({ code: 'PARENT_ALIAS_REFUSED' });
  f.registry.skills[0]!.target = 'skills/alias/entry'; f.registry.normalization_rules[0]!.source_relative = 'owner/entry'; await saveJson(f.ctx.registryPath, f.registry);
  await expect(skillsPlan(f.ctx, 'normalize', {})).rejects.toMatchObject({ code: 'EXTERNAL_OWNER' });
  expect(await readFile(join(owner, 'entry', 'SKILL.md'), 'utf8')).toBe('owner content');
});
