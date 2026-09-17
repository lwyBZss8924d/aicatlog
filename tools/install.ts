/** Preview-first, versioned local installation of a Bun-built release. */
import { readFile, readlink, lstat } from 'node:fs/promises';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { context, expand, fingerprint, inside, jsonFile, sha } from '../src/io.ts';
import { makePlan, operation, applyPlan } from '../src/plans.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const releaseArg = option('--release');
if (!releaseArg) throw new Error('Usage: bun tools/install.ts --release <directory> [--prefix <root>] [--bin <directory>] [--apply]');
const release = expand(releaseArg);
const prefix = expand(option('--prefix', '~/.local/share/aicatlog')!);
const bin = expand(option('--bin', '~/.local/bin')!);
const ctx = context({ ...(option('--state') ? { stateRoot: option('--state')! } : {}) });
const manifest = await jsonFile<{ version: string; platform: string; files: { path: string; sha256: string }[] }>(join(release, 'release-manifest.json'));
const entries = [{ name: 'aicatlog', artifact: 'bin/aicatlog' }, { name: 'tgrep', artifact: 'libexec/tgrep' }];
for (const { artifact } of entries) {
  const stat = await lstat(join(release, artifact)).catch(() => null);
  if (!manifest.files.some(file => file.path === artifact) || !stat?.isFile() || !(stat.mode & 0o111))
    throw new Error(`Required release executable is missing or invalid: ${artifact}`);
}
for (const file of manifest.files) {
  const path = resolve(release, file.path);
  if (!inside(release, path) || sha(await readFile(path)) !== file.sha256) throw new Error(`Invalid release artifact: ${file.path}`);
}
const destination = join(prefix, 'releases', `${manifest.version}-${manifest.platform}`);
const conflicts: string[] = [];
const operations = [];
if (await fingerprint(destination) !== await fingerprint(release)) operations.push(await operation('copy', destination, { source: release }));
for (const { name, artifact } of entries) {
  const link = join(bin, name);
  const currentLink = await readlink(link).catch(() => null);
  const releases = join(prefix, 'releases');
  const currentSource = currentLink ? resolve(dirname(link), currentLink) : undefined;
  const owned = currentSource && inside(releases, currentSource) &&
    relative(releases, currentSource).split(sep).slice(1).join('/') === artifact;
  if (await fingerprint(link) && !owned) conflicts.push(`Existing executable is not owned by this prefix: ${link}`);
  if (currentLink !== join(destination, artifact)) operations.push(await operation('link', link, { source: join(destination, artifact) }));
}
const plan = await makePlan(ctx, 'installation', [prefix, bin], operations, conflicts);
console.log(JSON.stringify(args.includes('--apply') ? await applyPlan(ctx, plan) : plan, null, 2));
