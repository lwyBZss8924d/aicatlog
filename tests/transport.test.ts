import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAicatlog, context, registrySchema } from '../src/index.ts';
import { saveJson } from '../src/io.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-transport-')); roots.push(root);
  const corpus = join(root, 'docs'); await mkdir(corpus);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache') });
  await saveJson(ctx.registryPath, registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [{ id: 'docs', root: corpus, kind: 'documents' }] }));
  for (const name of ['one', 'two', 'three']) await writeFile(join(corpus, name + '.txt'), JSON.stringify({ id: name }) + '\nneedle\n');
  return { root, ctx, api: createAicatlog(ctx) };
}
test('Fetch converts typed query values and rejects unknown or missing inputs consistently', async () => {
  const { api } = await fixture();
  const response = await api.fetch(new Request('http://test/list?limit=2'));
  expect(response.status).toBe(200); expect((await response.json() as any).data).toEqual(await api.call('list', { limit: 2 }));
  expect((await api.fetch(new Request('http://test/find/one?content=false'))).status).toBe(200);
  for (const route of ['/list?surprise=true', '/list?limit=oops', '/find/one?content=no', '/read']) expect((await api.fetch(new Request('http://test' + route))).status).toBe(400);
  await expect(api.call('list', { surprise: true })).rejects.toThrow();
  const spec = await (await api.fetch(new Request('http://test/openapi.json'))).json() as any;
  expect(spec.paths['/read'].get).toBeUndefined(); expect(spec.paths['/read/{id}'].get.parameters[0].required).toBe(true);
});
for (const mode of ['inline', 'file', 'stdin']) test(`--input ${mode} can supply a required option exclusively`, async () => {
  const f = await fixture(); const body = JSON.stringify({ file: f.ctx.registryPath });
  const inputPath = join(f.root, 'input.json'); await writeFile(inputPath, body);
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../src/bin.ts'), '--registry', f.ctx.registryPath, '--state', f.ctx.stateRoot, '--cache', f.ctx.cacheRoot,
    'registry', 'import', '--input', mode === 'inline' ? body : mode === 'file' ? '@' + inputPath : '-', '--json', '--full-output'],
    { stdin: mode === 'stdin' ? new Blob([body]) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(child.stdout).text(), err = await new Response(child.stderr).text();
  expect(await child.exited, err || text).toBe(0);
  expect(JSON.parse(text).data.purpose).toBe('registry.import');
});
test('CLI schema preserves required inputs despite deferred transport validation', async () => {
  const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../src/bin.ts'), 'apply', '--schema', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const spec = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(0);
  expect(spec.options.required).toContain('plan');
});
