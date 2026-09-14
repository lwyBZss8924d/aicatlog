import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AicatlogError, registrySchema, type Context, type Operation } from './types.ts';
import { expand, fingerprint, jsonFile, now, sha } from './io.ts';
import { makePlan, operation } from './plans.ts';
import profile from '../profiles/foundation/profile.json';

type Profile = { schema_version: string; id: string; files: { path: string; content: string; executable?: boolean }[] };
export async function bootstrap(ctx: Context, options: { repo: string; name?: string; profile?: string; adopt?: boolean }) {
  const root = expand(options.repo);
  const selected = options.profile ? await jsonFile<Profile>(expand(options.profile)) : profile as Profile;
  if (selected.schema_version !== 'aicatlog.profile.v1') throw new AicatlogError('INVALID_PROFILE', 'Unsupported foundation profile.');
  const variables = { repo_name: options.name ?? root.split(/[\\/]/).at(-1)! };
  const operations: Operation[] = [], conflicts: string[] = [], notes: string[] = [];
  const records: { path: string; sha256: string }[] = [];
  for (const file of selected.files) {
    const target = expand(file.path, root);
    let content = file.content.replace(/\{\{repo_name\}\}/g, variables.repo_name);
    const old = await readFile(target, 'utf8').catch(() => null);
    if (old === content) { records.push({ path: file.path, sha256: sha(content) }); continue; }
    if (old !== null && options.adopt && ['AGENTS.md', 'SPEC.md'].includes(file.path)) {
      if (file.path === 'SPEC.md') { notes.push('Preserved existing SPEC.md'); continue; }
      const block = '<!-- aicatlog:begin -->\nUse aicatlog with ./aicatlog-manifest.json for project resource navigation.\nValidate the selected scope with aicatlog harness check --repo .\n<!-- aicatlog:end -->';
      content = old.includes('<!-- aicatlog:begin -->') ? old.replace(/<!-- aicatlog:begin -->[\s\S]*?<!-- aicatlog:end -->/, block) : `${old.trimEnd()}\n\n${block}\n`;
    } else if (old !== null) {
      const installed = await jsonFile<{ files: { path: string; sha256: string }[] }>(join(root, 'workspace/harness-config/installation-manifest.json')).catch(() => null);
      if (!installed?.files.some(row => row.path === file.path && row.sha256 === sha(old))) {
        conflicts.push(`Preserve existing unmanaged file: ${target}`); continue;
      }
    }
    if (old !== content) operations.push(await operation('write', target, { content, executable: file.executable }));
    records.push({ path: file.path, sha256: sha(content) });
  }
  const installation = join(root, 'workspace/harness-config/installation-manifest.json');
  const content = JSON.stringify({ schema_version: 'aicatlog.foundation-installation.v1', profile: selected.id, files: records }, null, 2) + '\n';
  if (await readFile(installation, 'utf8').catch(() => '') !== content) operations.push(await operation('write', installation, { content }));
  return makePlan(ctx, 'harness.bootstrap', [root], operations, conflicts, notes);
}

export async function checkFoundation(repo: string) {
  const root = expand(repo);
  const installed = await jsonFile<{ files: { path: string; sha256: string }[] }>(join(root, 'workspace/harness-config/installation-manifest.json'));
  const issues: { path: string; code: string }[] = [];
  const modified: string[] = [];
  for (const file of installed.files) {
    const actual = await readFile(join(root, file.path)).catch(() => null);
    if (!actual) issues.push({ path: file.path, code: 'MISSING_FILE' });
    else if (sha(actual) !== file.sha256) modified.push(file.path);
  }
  try { registrySchema.parse(await jsonFile(join(root, 'aicatlog-manifest.json'))); }
  catch { issues.push({ path: 'aicatlog-manifest.json', code: 'INVALID_REGISTRY' }); }
  return { ok: !issues.length, repo: root, files: installed.files.length, modified_files: modified, issues };
}
