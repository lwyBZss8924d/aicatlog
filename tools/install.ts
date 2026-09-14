/** Preview-first, versioned local installation of a Bun-built release. */
import { readFile, readlink, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
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
for (const file of manifest.files) {
  const path = resolve(release, file.path);
  if (!inside(release, path) || sha(await readFile(path)) !== file.sha256) throw new Error(`Invalid release artifact: ${file.path}`);
}
const destination = join(prefix, 'releases', `${manifest.version}-${manifest.platform}`);
const link = join(bin, 'aicatlog');
const conflicts: string[] = [];
const currentLink = await readlink(link).catch(() => null);
if (await fingerprint(link) && (!currentLink || !inside(prefix, resolve(dirname(link), currentLink)))) conflicts.push(`Existing executable is not owned by this prefix: ${link}`);
const operations = [];
if (await fingerprint(destination) !== await fingerprint(release)) operations.push(await operation('copy', destination, { source: release }));
if (currentLink !== join(destination, 'bin/aicatlog')) operations.push(await operation('link', link, { source: join(destination, 'bin/aicatlog') }));
const plan = await makePlan(ctx, 'installation', [prefix, bin], operations, conflicts);
console.log(JSON.stringify(args.includes('--apply') ? await applyPlan(ctx, plan) : plan, null, 2));
