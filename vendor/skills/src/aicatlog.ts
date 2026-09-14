/** Programmatic source/discovery entrypoint for the aicatlog fork. No CLI UI or installer is invoked. */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';
export { parseSource } from './source-parser.ts';
export { cloneRepo, cleanupTempDir } from './git.ts';

export type DiscoveredSkill = {
  name: string;
  description: string;
  path: string;
  relativePath: string;
  metadata: Record<string, unknown>;
};

/** Parse the upstream YAML format, preserving all supported metadata and actionable errors. */
export async function readSkill(path: string): Promise<DiscoveredSkill> {
  const raw = await readFile(path, 'utf8');
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(raw))
    throw new Error(`Invalid or incomplete Skill frontmatter: ${path}`);
  const { data } = parseFrontmatter(raw);
  if (typeof data.name !== 'string' || !data.name.trim() || typeof data.description !== 'string' || !data.description.trim())
    throw new Error(`Skill requires string name and description: ${path}`);
  return { name: data.name, description: data.description.replace(/\s+/g, ' ').trim(), path, relativePath: 'SKILL.md', metadata: data };
}

/** Full-depth local discovery; distinct source paths retain duplicate names. */
export async function discover(root: string, options: { excludes?: string[]; linkedRoots?: string[] } = {}): Promise<{ skills: DiscoveredSkill[]; errors: { path: string; message: string }[]; directories: string[] }> {
  const skills: DiscoveredSkill[] = [];
  const errors: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '__pycache__', '.cache']);
  for (const name of options.excludes ?? []) skip.add(name);
  const allowed = await Promise.all([root, ...(options.linkedRoots ?? [])].map(p => realpath(p)));
  async function walk(directory: string): Promise<void> {
    let resolved: string;
    try { resolved = await realpath(directory); } catch (error) {
      errors.push({ path: directory, message: String(error) }); return;
    }
    if (seen.has(resolved)) return;
    if (!allowed.some(base => { const rel = relative(base, resolved); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); })) {
      errors.push({ path: directory, message: 'Directory link leaves declared discovery roots' }); return;
    }
    seen.add(resolved);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      errors.push({ path: directory, message: String(error) }); return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const actual = entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry;
      if (entry.name === 'SKILL.md' && actual?.isFile()) {
        try { const skill = await readSkill(path); skills.push({ ...skill, relativePath: relative(root, path) }); }
        catch (error) { errors.push({ path, message: String(error) }); }
      } else if (actual?.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return { skills, errors, directories: [...seen] };
}
