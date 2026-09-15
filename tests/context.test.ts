import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, contextInspectionSchema, createAicatlog, registrySchema, type ContextInspection } from '../src/index.ts';
import { run, saveJson, sha } from '../src/io.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(text = '# Context\n', filename = 'guide.llms.txt', declarations: Record<string, unknown> = { document_role: 'prompt_context', context_format: 'markdown' }) {
  const root = await mkdtemp(join(tmpdir(), 'aicatlog-context-')); roots.push(root);
  const corpus = join(root, 'corpus'); await mkdir(corpus);
  const source = join(corpus, filename); await writeFile(source, text);
  const ctx = context({ registryPath: join(root, 'registry.json'), stateRoot: join(root, 'state'), cacheRoot: join(root, 'cache'), sessionId: 'context-fixture' });
  const registry = registrySchema.parse({ schema_version: 'aicatlog.registry.v1', scopes: [{ id: 'docs', root: 'corpus', discovery: 'manifest', manifests: ['manifest.json'] }] });
  const manifest = { resources: [{ id: 'guide', path: filename, ...declarations }] };
  await saveJson(join(corpus, 'manifest.json'), manifest); await saveJson(ctx.registryPath, registry);
  const api = createAicatlog(ctx);
  const inspect = () => api.call('context inspect', { id: 'docs:guide' }) as Promise<ContextInspection>;
  return { root, corpus, source, ctx, registry, manifest, api, inspect };
}

describe('declared context inspection', () => {
  for (const text of ['# Only title', '\uFEFF# Only title\n', '\uFEFF# Only title\r\n> Summary\r\n']) test(`v2 H1-only and BOM source ${JSON.stringify(text)}`, async () => {
    const f = await fixture(text, 'llms.txt', {}), result = await f.inspect();
    expect(result.valid).toBe(true); expect(result.title).toBe('Only title');
    expect(result.document_role).toBe('context_index'); expect(result.context_format).toBe('llms-txt-v2');
    expect(result.classification).toBe('filename'); expect(result.source.sha256).toBe(sha(text));
    expect(result.sections[0]).toMatchObject({ selector: 'heading:1', start_line: 1, end_line: text.split(/\r?\n/).length });
    expect(contextInspectionSchema.parse(result)).toEqual(result);
  });

  test('an H1-only leaf has no invented summary and a blockquote summary is returned', async () => {
    const f = await fixture('# Leaf\n> A concise summary.\n> Continued.\n\n## Steps\n1. Do this.\n');
    const result = await f.inspect();
    expect(result.summary).toBe('A concise summary.\nContinued.'); expect(result.valid).toBe(true);
    expect(result.document_role).toBe('prompt_context'); expect(result.classification).toBe('declared');
  });

  test('declarations override filenames without reclassifying templates or undeclared leaves', async () => {
    const f = await fixture('# Workflow\n## Steps\nProcedural prose.\n', 'llms.txt');
    expect((await f.inspect()).valid).toBe(true); expect((await f.inspect()).context_format).toBe('markdown');
    const undeclared = await fixture('# Leaf\n', 'workflow.llms.txt', {});
    await expect(undeclared.inspect()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTEXT_RESOURCE' });
    const template = await fixture('# Output\n', 'llms.txt', { document_role: 'output_template', context_format: 'markdown' });
    await expect(template.inspect()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTEXT_RESOURCE' });
    const conflict = await fixture('# Index\n', 'llms.txt', { document_role: 'context_index', context_format: 'markdown' });
    await expect(conflict.inspect()).rejects.toMatchObject({ code: 'CONTEXT_DECLARATION_CONFLICT' });
  });

  test('v2 index accepts common Markdown lists and treats Optional as ordinary links', async () => {
    const text = '# Index\n> Summary\n\nA scope paragraph.\n\n## Files\n* [Leaf](./leaf.llms.txt): Notes\n  continued notes\n1. [Balanced](./a_(b).md)\n+ [Escaped](./a\\(b\\).md)\n\n## Optional\n- [Extra](./extra.md) : Extra detail\n';
    const f = await fixture(text, 'llms.txt', {}), result = await f.inspect();
    expect(result.valid).toBe(true); expect(result.summary).toBe('Summary');
    expect(result.references.map(r => r.target)).toEqual(['./leaf.llms.txt', './a_(b).md', './a(b).md', './extra.md']);
    expect(result.sections.map(s => s.label)).toEqual(['Index', 'Files', 'Optional']);
  });

  for (const [name, text, code] of [
    ['frontmatter', '---\nname: example\n---\n# Index\n', 'INDEX_TITLE_REQUIRED'],
    ['plain content', '# Index\n## Files\nUnlisted content\n', 'INVALID_INDEX_ITEM'],
    ['extra headings', '# Index\n## Files\n### Detail\n- [A](a.md)\n', 'INVALID_INDEX_HEADING'],
    ['fenced file list', '# Index\n## Files\n```\n- [A](a.md)\n```\n', 'INVALID_INDEX_ITEM'],
    ['unlinked list', '# Index\n## Files\n- No link\n', 'INVALID_INDEX_ITEM'],
    ['extra prefix', '# Index\n## Files\n- intro [A](a.md)\n', 'INVALID_INDEX_ITEM'],
  ]) test(`malformed index reports ${name} without throwing away source sections`, async () => {
    const f = await fixture(text!, 'llms.txt', {}), result = await f.inspect();
    expect(result.valid).toBe(false); expect(result.diagnostics.some(d => d.code === code && d.severity === 'error')).toBe(true);
    expect(result.source.sha256).toBe(sha(text!));
  });

  test('duplicate index sections remain separate and cannot silently choose a heading', async () => {
    const f = await fixture('# Index\n## Files\n- [A](a.md)\n## Files\n- [B](b.md)\n', 'llms.txt', {});
    const result = await f.inspect();
    expect(result.valid).toBe(false); expect(result.sections.filter(s => s.label === 'Files')).toHaveLength(2);
    expect(result.references.map(r => r.target)).toEqual(['a.md', 'b.md']);
    expect(result.diagnostics.some(d => d.code === 'DUPLICATE_INDEX_SECTION')).toBe(true);
    await expect(f.api.call('read', { id: 'docs:guide', section: 'files' })).rejects.toMatchObject({ code: 'AMBIGUOUS_SECTION' });
  });

  test('fenced and indented pseudoheadings and links are content, not navigation', async () => {
    const f = await fixture('# Workflow\n\n## Steps\n```markdown\n## Fake\n[Hidden](https://example.invalid/fake)\n````\n~~~\n# Also fake\n~~~\n    ## Indented\n\n### Detail\n`[Inline](hidden.md)`\n[Visible](detail.md)\n');
    const result = await f.inspect();
    expect(result.valid).toBe(true); expect(result.sections.map(s => s.label)).toEqual(['Workflow', 'Steps', 'Detail']);
    expect(result.references.map(r => r.target)).toEqual(['detail.md']);
    const selected = await f.api.call('read', { id: 'docs:guide', section: 'steps' }) as any;
    expect(selected.text).toContain('## Fake'); expect(selected.text).toContain('### Detail');
  });

  test('relative, fragment and remote references stay inert and preserve source line provenance', async () => {
    const f = await fixture('# Context\n[Sibling](./missing.md)\n[Parent](../outside.md)\n[Remote](https://example.invalid/file)\n[Fragment](#steps)\n[Absolute](/unavailable.md)\n');
    const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { throw new Error('Inspection must not fetch'); }, { preconnect: fetch.preconnect }));
    try {
      const result = await f.inspect();
      expect(result.references.map(r => r.kind)).toEqual(['relative', 'relative', 'uri', 'fragment', 'absolute']);
      expect(result.references[1]).toMatchObject({ target: '../outside.md', start_line: 3, end_line: 3 });
      expect(result.valid).toBe(true); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  test('inspection and heading reads reflect current source and digest', async () => {
    const f = await fixture('# Context\n## Old\nold text\n'), before = await f.inspect();
    const text = '# Context\n## New title\nnew text\n'; await writeFile(f.source, text);
    const after = await f.inspect();
    expect(after.source.sha256).toBe(sha(text)); expect(after.source.sha256).not.toBe(before.source.sha256);
    const selected = await f.api.call('read', { id: 'docs:guide', section: 'new-title' }) as any;
    expect(selected.text).toBe('## New title\nnew text\n'); expect(selected.source.sha256).toBe(after.source.sha256);
    await expect(f.api.call('read', { id: 'docs:guide', section: 'old' })).rejects.toMatchObject({ code: 'SECTION_NOT_FOUND' });
  });
});

describe('context section reads and containment', () => {
  test('unique heading labels/slugs select bounded hierarchy ranges and paginate', async () => {
    const f = await fixture('# Context\n## First section\none\n### Details\ntwo\n## Next\nthree\n');
    const result = await f.inspect();
    expect(result.sections[1]).toMatchObject({ selector: 'heading:2', slug: 'first-section', start_line: 2, end_line: 5 });
    const first = await f.api.call('read', { id: 'docs:guide', section: 'First section', limit: 2 }) as any;
    expect(first.text).toBe('## First section\none'); expect(first.next_line).toBe(4);
    const next = await f.api.call('read', { id: 'docs:guide', section: 'first-section', line: first.next_line }) as any;
    expect(next.text).toBe('### Details\ntwo'); expect(next.next_line).toBeNull();
  });

  test('repeated headings and colliding slugs require explicit current line selectors', async () => {
    const f = await fixture('# Context\n## Repeat\none\n## Repeat\ntwo\n## Case!\nthree\n## Case\nfour\n');
    const result = await f.inspect(); expect(result.valid).toBe(true);
    for (const section of ['Repeat', 'repeat', 'case']) {
      await expect(f.api.call('read', { id: 'docs:guide', section })).rejects.toMatchObject({ code: 'AMBIGUOUS_SECTION' });
    }
    try { await f.api.call('read', { id: 'docs:guide', section: 'Repeat' }); }
    catch (error: any) { expect(error.details.choices.map((c: any) => c.selector)).toEqual(['heading:2', 'heading:4']); }
    const exact = await f.api.call('read', { id: 'docs:guide', section: 'heading:4' }) as any;
    expect(exact.text).toBe('## Repeat\ntwo'); expect(exact.source.start_line).toBe(4);
  });

  test('Setext headings and BOM retain actual source ranges', async () => {
    const f = await fixture('\uFEFFContext\n=======\n\nSteps\n-----\nDo this.\n');
    const result = await f.inspect(); expect(result.title).toBe('Context');
    expect(result.sections.map(s => s.start_line)).toEqual([1, 4]);
    expect((await f.api.call('read', { id: 'docs:guide', section: 'steps' }) as any).text).toBe('Steps\n-----\nDo this.\n');
  });

  test('explicit topic mappings and existing BEGIN_TOPIC markers retain priority', async () => {
    const f = await fixture('# Context\n## Steps\nheading content\nSTART_CUSTOM\ncustom topic\nSTOP_CUSTOM\nBEGIN_TOPIC legacy\nlegacy topic\nEND_TOPIC legacy\n', 'guide.llms.txt', {
      document_role: 'prompt_context', context_format: 'markdown', topics: [{ id: 'steps', begin: 'START_CUSTOM', end: 'STOP_CUSTOM' }],
    });
    expect((await f.api.call('read', { id: 'docs:guide', section: 'steps' }) as any).text).toBe('START_CUSTOM\ncustom topic\nSTOP_CUSTOM');
    expect((await f.api.call('read', { id: 'docs:guide', section: 'legacy' }) as any).text).toBe('BEGIN_TOPIC legacy\nlegacy topic\nEND_TOPIC legacy');
    await writeFile(f.source, '# Context\n## Steps\nheading content\n');
    await expect(f.api.call('read', { id: 'docs:guide', section: 'steps' })).rejects.toMatchObject({ code: 'SECTION_NOT_FOUND' });
  });

  test('inspection shares read containment for source symlinks outside the scope', async () => {
    const f = await fixture(); const external = join(f.root, 'outside'); await mkdir(external);
    await writeFile(join(external, 'leaf.llms.txt'), '# Outside\n'); await symlink(external, join(f.corpus, 'link'));
    f.manifest.resources[0]!.path = 'link/leaf.llms.txt'; await saveJson(join(f.corpus, 'manifest.json'), f.manifest);
    await expect(f.inspect()).rejects.toMatchObject({ code: 'OUTSIDE_SCOPE' });
    await expect(f.api.call('read', { id: 'docs:guide', section: 'outside' })).rejects.toMatchObject({ code: 'OUTSIDE_SCOPE' });
  });
});

describe('direct registry resource aliases', () => {
  test('aliases preserve canonical IDs and metadata rows without native Skill duplication', async () => {
    const f = await fixture(); await mkdir(join(f.corpus, 'skill'));
    await writeFile(join(f.corpus, 'skill', 'SKILL.md'), '---\nname: skill\ndescription: One task.\n---\n# Task\n');
    f.registry.scopes[0]!.kind = 'skills';
    f.registry.settings.resource_aliases = { 'retired:guide': 'docs:guide', 'old-skill': 'docs:skill/SKILL.md' }; await saveJson(f.ctx.registryPath, f.registry);
    const beforeFiles = await readdir(f.corpus), before = await f.api.call('list') as any;
    const resource = await f.api.call('get', { id: 'retired:guide' }) as any;
    expect(resource.id).toBe('docs:guide'); expect(resource.resolution).toEqual({ requested_id: 'retired:guide', canonical_id: 'docs:guide', via: 'alias' });
    expect((await f.api.call('context inspect', { id: 'retired:guide' }) as any).resolution).toEqual(resource.resolution);
    expect((await f.api.call('read', { id: 'retired:guide' }) as any).id).toBe('docs:guide');
    expect((await f.api.call('get', { id: 'old-skill' }) as any).id).toBe('docs:skill/SKILL.md');
    const after = await f.api.call('list') as any;
    expect(after.items).toEqual(before.items); expect(after.items.filter((r: any) => r.kind === 'skill')).toHaveLength(1);
    expect(await readdir(f.corpus)).toEqual(beforeFiles); expect((await f.api.call('registry check') as any).ok).toBe(true);
  });

  test('a real resource ID wins over a rejected shadowing alias', async () => {
    const f = await fixture(); f.registry.settings.resource_aliases = { 'docs:guide': 'docs:missing' }; await saveJson(f.ctx.registryPath, f.registry);
    const resource = await f.api.call('get', { id: 'docs:guide' }) as any;
    expect(resource.id).toBe('docs:guide'); expect(resource.resolution).toBeUndefined();
    const check = await f.api.call('registry check') as any;
    expect(check.ok).toBe(false); expect(check.issues).toContainEqual(expect.objectContaining({ code: 'ALIAS_SHADOWS_RESOURCE', id: 'docs:guide' }));
  });

  for (const [aliases, id, code] of [
    [{ old: 'docs:missing' }, 'old', 'ALIAS_DANGLING'],
    [{ old: 'guide' }, 'old', 'ALIAS_TARGET_NOT_CANONICAL'],
    [{ old: 'middle', middle: 'docs:guide' }, 'old', 'ALIAS_TARGET_IS_ALIAS'],
    [{ old: 'middle', middle: 'old' }, 'old', 'ALIAS_CYCLE'],
  ] as const) test(`invalid alias ${code} is diagnosed and refused`, async () => {
    const f = await fixture(); f.registry.settings.resource_aliases = { ...aliases }; await saveJson(f.ctx.registryPath, f.registry);
    await expect(f.api.call('get', { id })).rejects.toMatchObject({ code });
    expect((await f.api.call('registry check') as any).issues.some((issue: any) => issue.id === id && issue.code === code)).toBe(true);
    expect((await f.api.call('index check') as any).diagnostics.some((issue: any) => issue.code === code)).toBe(true);
  });

  test('aliases cannot target duplicated rows and schema rejects non-string aliases', async () => {
    const f = await fixture(); f.manifest.resources.push({ ...f.manifest.resources[0]! }); await saveJson(join(f.corpus, 'manifest.json'), f.manifest);
    f.registry.settings.resource_aliases = { old: 'docs:guide' }; await saveJson(f.ctx.registryPath, f.registry);
    await expect(f.api.call('get', { id: 'old' })).rejects.toMatchObject({ code: 'ALIAS_AMBIGUOUS_TARGET' });
    expect(registrySchema.safeParse({ ...f.registry, settings: { resource_aliases: { old: 1 } } }).success).toBe(false);
  });
});

test('context operation shares SDK, Fetch, CLI and output schemas', async () => {
  const f = await fixture('# Context\n## Steps\nDo this.\n'); const sdk = await f.inspect();
  const response = await f.api.fetch(new Request('http://local/context/inspect/docs%3Aguide'));
  expect(response.status).toBe(200); const fetched = (await response.json() as any).data;
  expect({ ...fetched, source: { ...fetched.source, current_read_at: sdk.source.current_read_at } }).toEqual(sdk);
  const spec = await (await f.api.fetch(new Request('http://local/openapi.json'))).json() as any;
  expect(spec.paths['/context/inspect/{id}'].get.parameters[0]).toMatchObject({ name: 'id', required: true });
  expect(spec.paths['/context/inspect'].post.requestBody.content['application/json'].schema.required).toContain('id');
  expect(spec.paths['/context/inspect/{id}'].get.responses['200'].content['application/json'].schema.properties.data.properties.sections).toBeDefined();
  expect((await f.api.fetch(new Request('http://local/context/inspect/docs%3Aguide?expand=true'))).status).toBe(400);
  const argv = [process.execPath, '--no-env-file', join(import.meta.dir, '../src/bin.ts')];
  const cli = await run([...argv, '--registry', f.ctx.registryPath, '--cache', f.ctx.cacheRoot, '--state', f.ctx.stateRoot, 'context', 'inspect', '--input', '{"id":"docs:guide"}', '--json', '--full-output']);
  expect(cli.exit_code, cli.stderr || cli.stdout).toBe(0);
  expect(contextInspectionSchema.parse(JSON.parse(cli.stdout).data).source.sha256).toBe(sdk.source.sha256);
  const schema = await run([...argv, 'context', 'inspect', '--schema', '--json']);
  expect(schema.exit_code).toBe(0); expect(JSON.parse(schema.stdout).args.required).toContain('id');
  expect(JSON.parse(schema.stdout).output.properties.references).toBeDefined();
  expect(await readFile(f.source, 'utf8')).toBe('# Context\n## Steps\nDo this.\n');
});
