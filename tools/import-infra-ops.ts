/** Optional legacy-format adapter. All workstation locations come from its explicit source config. */
import { parse } from 'smol-toml';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { registrySchema, registrationSchema, type Resource, type Registration } from '../src/types.ts';
import { expand, now, saveJson, sha } from '../src/io.ts';

export async function importInfraOps(sourceRoot: string) {
  const root = expand(sourceRoot);
  const raw = await readFile(join(root, 'config.toml'), 'utf8');
  const config = parse(raw) as Record<string, any>;
  const harness = config.skills_harness;
  if (!harness?.registry_files || !harness?.global_root) throw new Error('The selected source has no supported Skills registry.');
  const global = expand(harness.global_root), market = expand(harness.library_root);
  const sourceFiles: { path: string; sha256: string }[] = [{ path: join(root, 'config.toml'), sha256: sha(raw) }];
  const entries: Record<string, any>[] = [];
  for (const relativePath of harness.registry_files) {
    const path = expand(relativePath, root), text = await readFile(path, 'utf8');
    sourceFiles.push({ path, sha256: sha(text) }); entries.push(...((parse(text) as any).skill ?? []));
  }
  let lock: any = { skills: {} };
  if (harness.lock_file) {
    const path = expand(harness.lock_file), text = await readFile(path, 'utf8');
    lock = JSON.parse(text); sourceFiles.push({ path, sha256: sha(text) });
  }
  const ids = new Set<string>();
  const skills: Registration[] = [];
  const linkedRoots = new Set<string>();
  const clientRows = (config.skills_harness_user_targets ?? []) as Record<string, any>[];
  const clients = clientRows.map(c => ({ id: c.name, agent: c.agent, root: c.path,
    mode: c.sync_policy === 'native_no_sync' ? 'native' : 'bridge', policy: c }));
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate legacy registration: ${entry.id}`);
    ids.add(entry.id);
    const library = entry.install_state === 'library' || entry.source_type === 'library_git';
    const target = library ? undefined : expand(entry.target_relative, global);
    const npx = entry.source_type === 'npx_lock';
    const locked = (entry.lock_entries ?? []).map((id: string) => lock.skills?.[id]).find(Boolean);
    const cliSource = ['homebrew_cli_pointer', 'cli_runtime_pointer'].includes(entry.source_type);
    const source: Registration['source'] = { kind: npx ? 'git' : cliSource ? 'cli' : 'local', uri: String(entry.source),
      ...(entry.source_skill_path ? { entry: String(entry.source_skill_path).replace(/\/SKILL\.md$/, '') } : {}),
      ...(locked?.skillPath ? { entry: String(locked.skillPath).replace(/\/SKILL\.md$/, '') } : {}),
      ...(entry.source_commit ? { revision: entry.source_commit } : locked?.ref ? { revision: locked.ref } : {}) };
    const owner = entry.update_policy === 'self_goal_kit_managed' ? 'self-goal' : entry.current_cli === 'memcell' ? 'memcell' : 'aicatlog';
    let activation: 'native' | 'explicit' | 'on_demand' = library ? 'on_demand' : 'native';
    if (entry.explicit_only || /explicit.?only/.test(String(entry.projection_policy ?? ''))) activation = 'explicit';
    if (target) {
      const resolved = await realpath(target).catch(() => target);
      if (!resolved.startsWith(global + '/')) linkedRoots.add(resolved);
    }
    skills.push(registrationSchema.parse({ id: entry.id, name: entry.name, source, target, owner,
      state: library ? 'optional' : ['archived', 'archive', 'disabled'].includes(entry.install_state) ? entry.install_state === 'disabled' ? 'disabled' : 'archived' : entry.enabled === false ? 'disabled' : 'active',
      activation, clients: clients.filter(c => (entry.target_agents ?? []).includes(c.agent) || (c.id === 'codex-test' && (entry.target_agents ?? []).includes('codex-test'))).map(c => c.id),
      metadata: { scope: library ? 'market' : 'global-skills', legacy: entry, lock: locked ?? null, bridge_name: entry.target_relative,
        legacy_evidence_only: true } }));
  }
  const resources: Resource[] = [];
  for (const tool of config.ai_tools ?? []) {
    if (typeof tool.name !== 'string' || typeof tool.binary !== 'string') continue;
    resources.push({ id: `cli:${tool.name}`, name: tool.name, kind: 'cli', scope: 'tools', owner: 'runtime',
      summary: String(tool.description ?? `Inspect ${tool.name}`), command: [tool.binary], help: [tool.binary, '--help'], children: [],
      installed_path: tool.path ?? null, role: tool.role ?? null });
  }
  const registry = registrySchema.parse({ schema_version: 'aicatlog.registry.v1', skills, clients,
    project_clients: config.skills_harness_project_targets ?? [], normalization_rules: config.skills_harness_normalization_rules ?? [], resources,
    scopes: [
      { id: 'global-skills', root: global, kind: 'skills', linked_roots: [...linkedRoots] },
      { id: 'market', root: market, kind: 'market' },
      { id: 'infra-guidance', root, kind: 'documents', manifests: ['ops/agent-guidance-manifest.json'], manifest_base: 'root',
        excludes: ['.git', '.agents', '.codex', 'reports', 'workspace', 'node_modules', 'tools', 'backups', 'vendor', 'dist'] },
    ],
    settings: { default_skill_scope: 'global-skills', skills_root: global, library_root: market,
      native_overlay_sources: harness.codex_config_targets ?? [], archive_root: harness.archive_root,
      legacy_import_policy: harness },
    import_provenance: { adapter: 'infra-ops-v1', imported_at: now(), source_root: root, source_files: sourceFiles,
      input_registrations: entries.length, output_registrations: skills.length, legacy_records: 'metadata.legacy is immutable import evidence; canonical fields are active authority' },
  });
  const parity = skills.every((s, index) => JSON.stringify(s.metadata.legacy) === JSON.stringify(entries[index]));
  if (!parity) throw new Error('Lossless legacy evidence check failed.');
  return { registry, verification: { lossless_records: parity, input: entries.length, output: skills.length, source_files: sourceFiles.length } };
}
if (import.meta.main) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error('Usage: bun tools/import-infra-ops.ts <source-root> <registry-output>');
  const result = await importInfraOps(source); await saveJson(expand(output), result.registry);
  console.log(JSON.stringify({ output_file: expand(output), ...result.verification }));
}
