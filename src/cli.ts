import { Cli } from 'incur';
import { z } from 'zod';
import { context, expand, inputJson, jsonFile, run } from './io.ts';
import { AicatlogError, registrySchema, resourceSchema, planSchema, listOutputSchema, readOutputSchema, type Context } from './types.ts';
import { catalogPath, checkRegistry, getCatalog, listResources, loadRegistry, readResource, refreshCatalog, selectResource } from './registry.ts';
import { contentFind, indexStart, indexStatus, indexStop, refreshContent } from './content-index.ts';
import { applyPlan, makePlan, operation } from './plans.ts';
import { skillsPlan, skillsStatus } from './skills.ts';
import { bootstrap, checkFoundation } from './foundation.ts';
import { dirname } from 'node:path';

const globals = z.object({
  registry: z.string().optional().describe('Explicit user or repository registry JSON'),
  state: z.string().optional().describe('Runtime receipts and worker ownership root'),
  cache: z.string().optional().describe('Rebuildable catalog and content index root'),
  session: z.string().optional().describe('Caller session lease identity'),
  tgrep: z.string().optional().describe('Configured tgrep executable'),
});
const inputOption = z.string().optional().describe('Command input as a flat JSON object, @file or - for stdin; overrides corresponding positional/options');
const paging = { limit: z.number().int().positive().default(20), cursor: z.number().int().nonnegative().default(0) };
export type Extension = { namespace: string; commands: Record<string, Definition> };
export type Aicatlog = {
  serve: (argv?: string[], io?: { stdout?: (text: string) => void; exit?: (code: number) => void }) => Promise<void>;
  call: (name: string, input?: Record<string, unknown>) => Promise<unknown>;
  fetch: (request: Request) => Promise<Response>;
};
type Definition = { description: string; args?: z.ZodObject<any>; options?: z.ZodObject<any>; output?: z.ZodType;
  sourceWrite?: boolean; run: (ctx: Context, input: any) => Promise<unknown> };

export function createAicatlog(defaults: Partial<Context> = {}, extensions: Extension[] = []): Aicatlog {
  const cli = Cli.create('aicatlog', { version: '0.1.0', description: 'Discover environment and harness resources, inspect contracts, retrieve focused context and apply prepared changes.',
    globals, sync: false, update: false });
  const groups = new Map<string, ReturnType<typeof Cli.create>>();
  const definitions = new Map<string, { definition: Definition; schema: z.ZodObject<any> }>();
  function ctxFor(values: Record<string, unknown> = {}): Context {
    return context({ ...defaults,
      ...(typeof values.registry === 'string' ? { registryPath: values.registry } : {}),
      ...(typeof values.state === 'string' ? { stateRoot: values.state } : {}),
      ...(typeof values.cache === 'string' ? { cacheRoot: values.cache } : {}),
      ...(typeof values.session === 'string' ? { sessionId: values.session } : {}),
      ...(typeof values.tgrep === 'string' ? { tgrep: values.tgrep } : {}),
    });
  }
  function add(name: string, definition: Definition) {
    const segments = name.split(' '), leaf = segments.pop()!;
    let parent = cli;
    if (segments.length) {
      const key = segments.join(' ');
      if (!groups.has(key)) {
        const group = Cli.create(key, { description: ({ skills: 'Inspect Skills or prepare selected installation and projection changes.', index: 'Check structural indexes or manage scoped content workers.',
          harness: 'Bootstrap and validate a portable repository foundation.', registry: 'Import and validate desired-state configuration.', env: 'Inspect available tools and their exact help entrypoints.' } as Record<string, string>)[key] ?? key, sync: false, update: false });
        groups.set(key, group); cli.command(group);
      }
      parent = groups.get(key)! as typeof cli;
    }
    const schema = z.object({ ...(definition.args?.shape ?? {}), ...(definition.options?.shape ?? {}) }).strict();
    definitions.set(name, { definition, schema });
    parent.command(leaf, {
      description: definition.description, args: definition.args?.partial(),
      options: z.object({ ...(definition.options?.shape ?? {}), input: inputOption }),
      output: definition.output ?? z.unknown(),
      run: async c => {
        try {
          const request = (c as unknown as { request?: Request }).request;
          if (definition.sourceWrite && request && request.method !== 'POST') throw new AicatlogError('METHOD_NOT_ALLOWED', 'Source changes require POST.');
          const { input, ...options } = c.options;
          const payload = input ? { ...c.args, ...options, ...await inputJson(String(input)) as object } : { ...c.args, ...options };
          const data = await definition.run(ctxFor(c.globals), schema.parse(payload));
          return c.ok(data);
        } catch (error) {
          return c.error({ code: error instanceof AicatlogError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: error instanceof AicatlogError ? error.retryable : false, exitCode: error instanceof z.ZodError ? 2 : 1 });
        }
      },
    });
  }
  add('catalog', { description: 'Start here: show resource scopes and the next useful discovery operations.', run: async ctx => {
    const registry = await loadRegistry(ctx); const catalog = await getCatalog(ctx);
    return { scopes: registry.scopes.map(s => ({ id: s.id, kind: s.kind, content_index: s.content_index })), resources: catalog.resources.length,
      capabilities: ['list: select metadata', 'find: search metadata; --content searches one corpus', 'get: inspect a qualified resource', 'read: read one current source topic', 'apply: execute a prepared source change'], diagnostics: catalog.errors };
  } });
  add('list', { description: 'List compact resource metadata; use kind/scope and pagination before reading bodies.', options: z.object({ kind: z.string().optional(), scope: z.string().optional(), ...paging }), output: listOutputSchema, run: listResources });
  add('find', { description: 'Find applicable resources; --content searches a selected corpus and --fresh reads current files.', args: z.object({ query: z.string().min(1) }),
    options: z.object({ kind: z.string().optional(), scope: z.string().optional(), content: z.boolean().default(false), fresh: z.boolean().default(false), regex: z.boolean().default(false), ...paging }),
    run: async (ctx, input) => {
      if (!input.content) return listResources(ctx, input);
      if (!input.scope) throw new AicatlogError('SCOPE_REQUIRED', 'Content search requires an explicit registered scope.');
      return contentFind(ctx, input.query, input);
    } });
  add('get', { description: 'Get one resource contract and navigation pointers without loading its body.', args: z.object({ id: z.string() }), output: resourceSchema, run: (ctx, { id }) => selectResource(ctx, id) });
  add('read', { description: 'Read one actual source document or selected topic with line and digest provenance.', args: z.object({ id: z.string() }),
    options: z.object({ section: z.string().optional(), line: z.number().int().positive().default(1), limit: z.number().int().positive().default(200) }),
    output: readOutputSchema,
    run: (ctx, input) => readResource(ctx, input.id, input) });
  add('registry check', { description: 'Validate the configured registry and its resource ownership declarations.', run: checkRegistry });
  add('registry import', { description: 'Prepare importing a complete portable registry JSON; no source change until apply.',
    options: z.object({ file: z.string() }), run: async (ctx, input) => {
      const registry = registrySchema.parse(await jsonFile(expand(input.file)));
      return makePlan(ctx, 'registry.import', [dirname(ctx.registryPath)], [await operation('write', ctx.registryPath, { content: JSON.stringify(registry, null, 2) + '\n' })]);
    } });
  for (const action of ['start', 'status', 'stop'] as const) add(`index ${action}`, {
    description: ({ start: 'Acquire a session lease and warm a registered content index.', status: 'Inspect the actual local worker and freshness signals without renewing a lease.', stop: 'Release this session lease; other sessions retain their worker.' })[action],
    args: z.object({ scope: z.string() }), run: (ctx, { scope }) => ({ start: indexStart, status: indexStatus, stop: indexStop })[action](ctx, scope),
  });
  add('index refresh', { description: 'Refresh structural navigation, or explicitly reload one content index with --content.', args: z.object({ scope: z.string().optional() }),
    options: z.object({ content: z.boolean().default(false) }), run: async (ctx, input) => {
      if (input.content) return refreshContent(ctx, input.scope ?? '');
      const c = await refreshCatalog(ctx); return { resources: c.resources.length, diagnostics: c.errors, generated_at: c.generated_at, catalog_path: catalogPath(ctx) };
    } });
  add('index check', { description: 'Check structural index diagnostics and its declared source roots.', run: async ctx => { const c = await getCatalog(ctx); return { ok: !c.errors.length, generated_at: c.generated_at, resources: c.resources.length, diagnostics: c.errors }; } });
  add('skills status', { description: 'Inspect desired and observed installation state without updating any resources.', run: skillsStatus });
  for (const action of ['install', 'update', 'remove', 'sync', 'normalize']) add(`skills ${action}`, {
    description: `Prepare ${action} for selected Skills; inspect the returned plan before apply.`, args: z.object({ id: z.string().optional() }),
    options: z.object({ source: z.string().optional(), skill: z.string().optional(), scope: z.string().optional(), target: z.string().optional(), client: z.string().optional() }),
    output: planSchema.extend({ plan_path: z.string() }),
    run: (ctx, input) => skillsPlan(ctx, action, input),
  });
  add('apply', { description: 'Apply the exact prepared plan, verifying source/target versions and preserving recovery data.', sourceWrite: true,
    options: z.object({ plan: z.string(), recover: z.boolean().default(false) }), run: async (ctx, input) => applyPlan(ctx, await jsonFile(expand(input.plan)), input.recover) });
  add('harness bootstrap', { description: 'Prepare a language-neutral foundation or adopt existing root contracts without replacing their content.',
    options: z.object({ repo: z.string(), name: z.string().optional(), profile: z.string().optional(), adopt: z.boolean().default(false) }), run: bootstrap });
  add('harness check', { description: 'Check the installed foundation against its file and profile manifest.', options: z.object({ repo: z.string().default('.') }), run: (_, input) => checkFoundation(input.repo) });
  add('harness manifests', { description: 'Refresh registered project resource navigation from current source documents.', run: async ctx => { const c = await refreshCatalog(ctx); return { resources: c.resources.length, diagnostics: c.errors, catalog_path: catalogPath(ctx) }; } });
  add('env inspect', { description: 'List registered CLI capabilities and actual executable availability.', args: z.object({ id: z.string().optional() }), run: async (ctx, input) => {
    const registry = await loadRegistry(ctx);
    return { tools: registry.resources.filter(r => r.kind === 'cli' && (!input.id || r.id === input.id || r.name === input.id)).map(r => ({ id: r.id, name: r.name, command: r.command,
      executable: r.command?.[0] ? Bun.which(r.command[0]) : null, summary: r.summary, help: r.help ?? null })) };
  } });
  add('env help', { description: 'Run one explicitly registered help command; preserve its stdout, stderr and exit status.', args: z.object({ id: z.string() }), run: async (ctx, input) => {
    const registry = await loadRegistry(ctx);
    const resource = registry.resources.find(r => r.kind === 'cli' && (r.id === input.id || r.name === input.id));
    const help = resource?.help as string[] | undefined;
    if (!help?.length) throw new AicatlogError('HELP_NOT_REGISTERED', 'Declare the exact help argv in the trusted registry.');
    return run(help);
  } });
  for (const extension of extensions) for (const [name, definition] of Object.entries(extension.commands)) add(`${extension.namespace} ${name}`, definition);
  return {
    serve: (argv, io) => cli.serve(argv, io),
    async call(name: string, input: Record<string, unknown> = {}) {
      const entry = definitions.get(name); if (!entry) throw new AicatlogError('COMMAND_NOT_FOUND', name);
      return entry.definition.run(context(defaults), entry.schema.parse(input));
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'No MCP endpoint.' } }, { status: 404 });
      let name: string;
      try { name = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join(' '); }
      catch { return Response.json({ ok: false, error: { code: 'INVALID_PATH', message: 'Malformed URL path encoding.' } }, { status: 400 }); }
      const route = [...definitions.keys()].sort((a, b) => b.length - a.length).find(key => name === key || name.startsWith(`${key} `));
      if (route && definitions.get(route)?.definition.sourceWrite && request.method !== 'POST') return Response.json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Source changes require POST.' } }, { status: 405 });
      return cli.fetch(request);
    },
  };
}
