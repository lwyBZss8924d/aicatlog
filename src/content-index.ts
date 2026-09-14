import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AicatlogError, type Context, type Scope } from './types.ts';
import { expand, inside, jsonFile, now, run, saveJson, sha } from './io.ts';
import { getCatalog, loadRegistry } from './registry.ts';

type WorkerConfig = { schema_version: string; root: string; scope: Scope; indexDir: string; runtimeDir: string; tgrep: string };
type WorkerIdentity = { pid: number; child_pid: number; child_identity: string | null; token: string; root: string; tgrep: string; started_at: string };
type NativeStatus = { indexing?: boolean; hidden_complete?: boolean; watch_mode_active?: string; last_reconcile_at?: number; last_reconcile_error?: string | null; [key: string]: unknown };

async function configuration(ctx: Context, scopeId: string): Promise<WorkerConfig> {
  const registry = await loadRegistry(ctx);
  const scope = registry.scopes.find(s => s.id === scopeId);
  if (!scope) throw new AicatlogError('SCOPE_NOT_FOUND', `Unknown corpus ${scopeId}`);
  if (!scope.content_index) throw new AicatlogError('CONTENT_INDEX_DISABLED', `Content indexing is disabled for ${scopeId}`);
  const root = await realpath(expand(scope.root, dirname(ctx.registryPath)));
  const candidates = [ctx.tgrep, registry.settings.tgrep_binary as string | undefined,
    join(dirname(process.execPath), '..', 'libexec', 'tgrep'), join(dirname(process.execPath), 'libexec', 'tgrep'), Bun.which('tgrep') ?? undefined];
  let tgrep: string | undefined;
  for (const candidate of candidates) if (candidate && await access(expand(candidate)).then(() => true, () => false)) { tgrep = expand(candidate); break; }
  if (!tgrep) throw new AicatlogError('BACKEND_UNAVAILABLE', 'Configure the tgrep executable or install the release backend.', { backend: 'tgrep' });
  const key = sha(JSON.stringify({ root, excludes: scope.excludes, hidden: scope.hidden, max: scope.max_file_bytes, ignore: scope.no_require_git, backend: tgrep }));
  return { schema_version: 'aicatlog.index-worker.v1', root, scope, tgrep,
    indexDir: join(ctx.cacheRoot, 'tgrep', key), runtimeDir: join(ctx.stateRoot, 'index-workers', key) };
}

async function rpc(indexDir: string, method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<Record<string, unknown>> {
  const info = await jsonFile<{ pid: number; port: number }>(join(indexDir, 'serve.json'));
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new AicatlogError('INVALID_BACKEND_STATE', 'Invalid local backend port.');
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: info.port });
    const id = randomUUID(); let body = '', settled = false;
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new AicatlogError('BACKEND_TIMEOUT', `tgrep ${method} did not complete`, { outcome: 'unknown' }, true)), timeout);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'));
    socket.on('error', error => finish(new AicatlogError('BACKEND_UNAVAILABLE', String(error), undefined, true)));
    socket.on('end', () => { if (!settled) finish(new AicatlogError('BACKEND_PROTOCOL_ERROR', 'Connection ended without a complete response.')); });
    socket.on('data', chunk => {
      body += chunk;
      const end = body.indexOf('\n'); if (end < 0) return;
      try {
        const response = JSON.parse(body.slice(0, end));
        if (response.id !== id) throw new AicatlogError('BACKEND_PROTOCOL_ERROR', 'Response identity differs from request.');
        if (response.error) throw new AicatlogError('BACKEND_ERROR', String(response.error.message), response.error);
        if (!response.result || typeof response.result !== 'object') throw new AicatlogError('BACKEND_PROTOCOL_ERROR', 'Missing result.');
        finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
  });
}

const leasePath = (cfg: WorkerConfig, session: string) => join(cfg.runtimeDir, 'leases', `${sha(session)}.json`);
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function processIdentity(pid: number): Promise<string | null> {
  const result = await run(['ps', '-p', String(pid), '-o', 'lstart=', '-o', 'command=']).catch(() => null);
  return result?.exit_code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
async function trackedRpc(cfg: WorkerConfig, method: string, params: Record<string, unknown> = {}, timeout = 30000) {
  const path = join(cfg.runtimeDir, 'requests', `${randomUUID()}.json`);
  await saveJson(path, { expires_at: Date.now() + timeout + 5000, method });
  try { return await rpc(cfg.indexDir, method, params, timeout); }
  finally { await rm(path, { force: true }); }
}
async function renew(cfg: WorkerConfig, ctx: Context) {
  await saveJson(leasePath(cfg, ctx.sessionId), { session_id: ctx.sessionId, expires_at: Date.now() + cfg.scope.idle_seconds * 1000 });
}

export async function indexStatus(ctx: Context, scopeId: string) {
  const cfg = await configuration(ctx, scopeId);
  const identity = await jsonFile<WorkerIdentity>(join(cfg.runtimeDir, 'worker.json')).catch(() => null);
  const native = await rpc(cfg.indexDir, 'status').catch(() => null);
  return { scope: scopeId, running: !!native, worker: identity, index_path: cfg.indexDir,
    managed: !!identity && processAlive(identity.pid), consistency: 'eventual', native, current_filesystem_guarantee: false };
}

export async function indexStart(ctx: Context, scopeId: string) {
  const cfg = await configuration(ctx, scopeId);
  await mkdir(cfg.runtimeDir, { recursive: true });
  await renew(cfg, ctx);
  let status = await rpc(cfg.indexDir, 'status').catch(() => null);
  if (status) {
    const previous = await jsonFile<WorkerIdentity>(join(cfg.runtimeDir, 'worker.json')).catch(() => null);
    if (previous && !processAlive(previous.pid)) {
      const native = await jsonFile<{ pid: number }>(join(cfg.indexDir, 'serve.json'));
      if (native.pid !== previous.child_pid || !previous.child_identity || await processIdentity(previous.child_pid) !== previous.child_identity)
        throw new AicatlogError('WORKER_RECOVERY_REQUIRED', 'Orphan identity cannot be verified; the process was left untouched.');
      process.kill(previous.child_pid, 'SIGINT');
      for (let i = 0; i < 50 && status; i++) { await Bun.sleep(100); status = await rpc(cfg.indexDir, 'status').catch(() => null); }
      if (status) throw new AicatlogError('WORKER_RECOVERY_REQUIRED', 'Verified orphan did not exit.');
    }
  }
  if (!status) {
    const configPath = join(cfg.runtimeDir, 'config.json'); await saveJson(configPath, cfg);
    const executable = process.execPath;
    const sourceEntry = fileURLToPath(new URL('./bin.ts', import.meta.url));
    const packedEntry = fileURLToPath(new URL('./bin.js', import.meta.url));
    const sourceAvailable = await access(sourceEntry).then(() => true, () => false);
    const prefix = /^bun(?:\.exe)?$/.test(basename(executable)) ? [executable, sourceAvailable ? sourceEntry : packedEntry] : [executable];
    const log = await open(join(cfg.runtimeDir, 'worker.log'), 'a', 0o600);
    const worker = spawn(prefix[0]!, [...prefix.slice(1), '__index-worker', configPath], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    worker.unref(); await log.close();
    const deadline = Date.now() + 15000;
    while (!status && Date.now() < deadline) { await Bun.sleep(100); status = await rpc(cfg.indexDir, 'status').catch(() => null); }
    if (!status) throw new AicatlogError('BACKEND_START_FAILED', 'tgrep did not start. Inspect the bounded worker log.', { log: join(cfg.runtimeDir, 'worker.log') });
  }
  return { scope: scopeId, status: status.indexing ? 'warming' : 'running', consistency: 'eventual', lease: ctx.sessionId, native: status };
}

export async function indexStop(ctx: Context, scopeId: string) {
  const cfg = await configuration(ctx, scopeId);
  await rm(leasePath(cfg, ctx.sessionId), { force: true });
  return { scope: scopeId, status: 'lease_released', session_id: ctx.sessionId, process_stop: 'after remaining leases and requests expire' };
}
export async function refreshContent(ctx: Context, scopeId: string) {
  await indexStart(ctx, scopeId);
  const cfg = await configuration(ctx, scopeId);
  const result = await trackedRpc(cfg, 'reload', {}, 300000);
  return { scope: scopeId, status: 'refreshed', consistency: 'eventual', result };
}

/** The worker owns its child process handle; callers never signal an arbitrary PID from a file. */
export async function indexWorker(configPath: string): Promise<void> {
  const cfg = await jsonFile<WorkerConfig>(configPath);
  const lockPath = join(cfg.runtimeDir, 'owner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch {
    const old = await jsonFile<{ pid: number }>(lockPath).catch(() => null);
    if (!old) return;
    try { process.kill(old.pid, 0); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
    await rm(lockPath);
    try { lock = await open(lockPath, 'wx', 0o600); } catch { return; }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  const args = ['serve', cfg.root, '--index-path', cfg.indexDir, '--max-filesize', String(cfg.scope.max_file_bytes)];
  if (cfg.scope.no_require_git) args.push('--no-require-git');
  for (const dir of cfg.scope.excludes) args.push('--exclude', dir);
  const child = spawn(cfg.tgrep, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const token = randomUUID();
  await saveJson(join(cfg.runtimeDir, 'worker.json'), { pid: process.pid, child_pid: child.pid, child_identity: child.pid ? await processIdentity(child.pid) : null, token, root: cfg.root, tgrep: cfg.tgrep, started_at: now() });
  let exited = false, stopping = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  const stop = () => { stopping = true; if (!exited) child.kill('SIGINT'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (!exited) {
      let active = false;
      for (const directory of ['leases', 'requests']) for (const file of await readdir(join(cfg.runtimeDir, directory)).catch(() => [])) {
          const path = join(cfg.runtimeDir, directory, file);
          const lease = await jsonFile<{ expires_at: number }>(path).catch(() => null);
          if (lease && lease.expires_at > Date.now()) active = true;
          else await rm(path, { force: true });
        }
      if (!active || stopping) {
        stop();
        for (let attempt = 0; !exited && attempt < 50; attempt++) await Bun.sleep(100);
        if (!exited) child.kill('SIGKILL');
        break;
      }
      await Bun.sleep(1000);
    }
  } finally {
    stop(); await lock.close();
    await rm(lockPath, { force: true });
    await rm(join(cfg.runtimeDir, 'worker.json'), { force: true });
  }
}

export async function contentFind(ctx: Context, query: string, options: { scope: string; fresh?: boolean; regex?: boolean; limit?: number; cursor?: number }) {
  const cfg = await configuration(ctx, options.scope);
  const catalog = await getCatalog(ctx);
  let matches: { path: string; line: number | null; text: string }[] = [];
  let backend = 'tgrep_live_scan', reason: string | null = null, native: Record<string, unknown> | null = null;
  if (!options.fresh) {
    try {
      await indexStart(ctx, options.scope); native = await rpc(cfg.indexDir, 'status');
      if (native.hidden_complete !== true || native.indexing) reason = 'index_warming';
      else {
        const result = await trackedRpc(cfg, 'search', { pattern: query, fixed_string: !options.regex, hidden: cfg.scope.hidden,
          max_filesize: cfg.scope.max_file_bytes, detail: false, positions: true, stats: true,
          glob: cfg.scope.excludes.map(x => `!**/${x}/**`) });
        if (result.hidden_complete !== true) throw new AicatlogError('COVERAGE_UNAVAILABLE', 'Search did not establish index coverage.');
        if (!Array.isArray(result.matches)) throw new AicatlogError('BACKEND_PROTOCOL_ERROR', 'Search did not return matches.');
        matches = result.matches.filter((m: Record<string, unknown>) => !m.type || m.type === 'match')
          .map((m: Record<string, unknown>) => ({ path: expand(String(m.file), cfg.root),
          line: typeof m.line === 'number' ? m.line : null, text: String(m.content ?? '') }));
        backend = 'tgrep_server';
      }
    } catch (error) {
      if (error instanceof AicatlogError && ['BACKEND_ERROR', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)) throw error;
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (backend === 'tgrep_live_scan') {
    const args = [cfg.tgrep, '--json', '--no-index', '--index-path', cfg.indexDir, '--max-filesize', String(cfg.scope.max_file_bytes)];
    if (cfg.scope.hidden) args.push('--hidden');
    if (cfg.scope.no_require_git) args.push('--no-require-git');
    if (!options.regex) args.push('-F');
    for (const dir of cfg.scope.excludes) args.push('-g', `!**/${dir}`, '-g', `!**/${dir}/**`);
    args.push('--', query, cfg.root);
    const result = await run(args, cfg.root, 300000);
    if (result.exit_code > 1 || result.timed_out) throw new AicatlogError('SEARCH_FAILED', result.stderr, { exit_code: result.exit_code });
    matches = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'match')
      .map(row => ({ path: expand(row.data.path.text, cfg.root), line: row.data.line_number, text: row.data.lines.text }));
  }
  const hits = matches.filter(m => inside(cfg.root, m.path)).map(m => ({ ...m,
    resource_ids: catalog.resources.filter(r => r.path === m.path).map(r => r.id) })).sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  const offset = options.cursor ?? 0, limit = options.limit ?? 20;
  return { items: hits.slice(offset, offset + limit), total: hits.length, next_cursor: offset + limit < hits.length ? offset + limit : null,
    backend, fallback_reason: reason, consistency: backend === 'tgrep_server' ? 'eventual' : 'live_scan',
    current_filesystem_guarantee: backend !== 'tgrep_server', indexed_no_match_is_current_absence: false,
    scope: options.scope, index_state: native, queried_at: now() };
}
