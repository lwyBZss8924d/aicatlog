/** Bun owns compilation, SDK packing and release assembly. Native backend inputs are explicit. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
const pkg = await Bun.file(join(root, 'package.json')).json();
const vendor = await Bun.file(join(root, 'vendor-manifest.json')).json();
const args = process.argv.slice(2);
const option = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const source = option('--tgrep-source');
const native = option('--tgrep-binary');
const dist = join(root, 'dist'); await mkdir(dist, { recursive: true });
async function checked(argv: string[], cwd = root, env = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited; if (code) throw new Error(`Build command failed (${code}): ${argv.join(' ')}`);
}
if (source) {
  await checked(['cargo', 'build', '--manifest-path', join(resolve(source), 'Cargo.toml'), '--locked', '--release', '-p', 'tgrep-cli'], root,
    { ...process.env, CARGO_TARGET_DIR: join(root, '.cache/native-build') });
}
const tgrep = native ? resolve(native) : source ? join(root, '.cache/native-build/release/tgrep') : undefined;
if (!tgrep) throw new Error('Supply --tgrep-binary or --tgrep-source to assemble the declared backend.');
const versionProcess = Bun.spawn([tgrep, '--version'], { stdout: 'pipe', stderr: 'pipe' });
const backendVersion = (await new Response(versionProcess.stdout).text()).trim();
if (await versionProcess.exited || backendVersion !== `tgrep ${vendor.sources.find((s: { id: string }) => s.id === 'tgrep').version}`) throw new Error('Backend version differs from the declared vendor version.');
await checked([process.execPath, 'build', '--compile', './src/bin.ts', '--outfile', 'dist/aicatlog']);
await checked([process.execPath, 'build', './src/index.ts', '--target', 'bun', '--external', 'zod', '--outdir', 'dist/sdk']);
await checked([process.execPath, 'build', './src/bin.ts', '--target', 'bun', '--external', 'zod', '--outdir', 'dist/sdk']);
await checked([process.execPath, 'x', '--no-install', 'tsc', '-p', 'tsconfig.build.json']);
const sdk = join(dist, 'sdk');
const zod = await Bun.file(join(root, 'node_modules/zod/package.json')).json();
await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'aicatlog', version: pkg.version, type: 'module', license: 'MIT',
  main: './index.js', types: './types/src/index.d.ts', exports: { '.': { types: './types/src/index.d.ts', default: './index.js' } },
  engines: { bun: '>=1.3.14' }, dependencies: { zod: zod.version }, files: ['index.js', 'bin.js', 'types', 'LICENSE', 'README.md'] }, null, 2) + '\n');
for (const name of ['README.md', 'LICENSE']) await cp(join(root, name), join(sdk, name));
await checked([process.execPath, 'pm', 'pack', '--ignore-scripts', '--filename', join(dist, 'aicatlog-sdk.tgz')], sdk);
const platform = `${process.platform}-${process.arch}`;
const release = join(dist, `aicatlog-${pkg.version}-${platform}`);
await mkdir(join(release, 'bin'), { recursive: true }); await mkdir(join(release, 'libexec'), { recursive: true });
await cp(join(dist, 'aicatlog'), join(release, 'bin/aicatlog'));
await cp(tgrep, join(release, 'libexec/tgrep'));
for (const item of ['LICENSE', 'README.md', 'vendor-manifest.json']) await cp(join(root, item), join(release, item));
await cp(join(root, 'docs'), join(release, 'docs'), { recursive: true });
await cp(join(root, 'profiles'), join(release, 'profiles'), { recursive: true });
await cp(join(root, 'skills'), join(release, 'skills'), { recursive: true });
const records = [];
for (const file of ['bin/aicatlog', 'libexec/tgrep']) {
  const bytes = await readFile(join(release, file)); records.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(release, 'release-manifest.json'), JSON.stringify({ schema_version: 'aicatlog.release.v1', version: pkg.version,
  platform, bun_version: Bun.version, source_revision: (await new Response(Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe' }).stdout).text()).trim(), backends: vendor.sources.filter((s: { id: string }) => s.id === 'tgrep'), files: records }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'built', release, sdk: join(dist, 'aicatlog-sdk.tgz'), files: records }));
