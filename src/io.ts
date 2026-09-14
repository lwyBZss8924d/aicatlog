import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve, relative, isAbsolute, join, sep, basename } from 'node:path';
import { mkdir, readFile, writeFile, rename, lstat, readlink, readdir, realpath } from 'node:fs/promises';
import { AicatlogError, type Context } from './types.ts';

export const now = () => new Date().toISOString();
export const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function expand(value: string, base = process.cwd()): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (value.startsWith('$HOME/')) return join(homedir(), value.slice(6));
  return resolve(base, value);
}
export function context(options: Partial<Context> = {}): Context {
  return {
    registryPath: expand(options.registryPath ?? process.env.AICATLOG_REGISTRY ?? '~/.agents/aicatlog/registry-manifest.json'),
    stateRoot: expand(options.stateRoot ?? process.env.AICATLOG_STATE ?? '~/.local/state/aicatlog'),
    cacheRoot: expand(options.cacheRoot ?? process.env.AICATLOG_CACHE ?? '~/.cache/aicatlog'),
    sessionId: options.sessionId ?? process.env.AICATLOG_SESSION ?? process.env.CODEX_THREAD_ID ?? `process-${process.ppid}`,
    tgrep: options.tgrep ?? process.env.AICATLOG_TGREP,
  };
}
export function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export async function resolvedFuture(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path === dirname(path)) throw error;
    return join(await resolvedFuture(dirname(path)), basename(path));
  }
}
export async function assertContained(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new AicatlogError('OUTSIDE_SCOPE', `Path leaves scope: ${target}`);
  const canonicalRoot = await resolvedFuture(root);
  const actual = await resolvedFuture(dirname(target));
  if (target !== root && !inside(canonicalRoot, actual))
    throw new AicatlogError('OUTSIDE_SCOPE', `Parent link leaves scope: ${target}`);
}
export async function atomic(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode });
  await rename(temporary, path);
}
export async function jsonFile<T = unknown>(path: string): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { throw new AicatlogError('INVALID_OR_MISSING_JSON', `Cannot read JSON at ${path}`, { reason: String(error) }); }
}
export const saveJson = (path: string, value: unknown) => atomic(path, JSON.stringify(value, null, 2) + '\n');
export async function fingerprint(path: string, excludes: string[] = []): Promise<string | null> {
  const stat = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (stat.isFile()) return `file:${sha(await readFile(path))}`;
  if (!stat.isDirectory()) throw new AicatlogError('UNSUPPORTED_FILE', `Not a regular file or directory: ${path}`);
  const values: string[] = [];
  for (const entry of (await readdir(path)).sort()) if (!excludes.includes(entry)) values.push(`${entry}\0${await fingerprint(join(path, entry), excludes)}`);
  return `tree:${sha(values.join('\n'))}`;
}
export async function run(argv: string[], cwd?: string, timeout = 30000) {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { argv, exit_code: code, stdout, stderr, timed_out: timedOut };
}
export async function inputJson(value: string): Promise<unknown> {
  const body = value === '-' ? await Bun.stdin.text() : value.startsWith('@') ? await readFile(expand(value.slice(1)), 'utf8') : value;
  try { return JSON.parse(body); } catch { throw new AicatlogError('INVALID_INPUT', 'Expected JSON, @file or stdin.'); }
}
