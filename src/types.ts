import { z } from 'zod';

export const scopeSchema = z.object({
  id: z.string().min(1), root: z.string().min(1),
  kind: z.enum(['skills', 'market', 'documents', 'repo']).default('documents'),
  content_index: z.boolean().default(true),
  hidden: z.boolean().default(true),
  excludes: z.array(z.string()).default(['.git', 'node_modules', 'target', 'dist', 'build', '__pycache__', '.env']),
  no_require_git: z.boolean().default(true),
  max_file_bytes: z.number().int().positive().default(67108864),
  idle_seconds: z.number().int().positive().default(900),
  manifests: z.array(z.string()).default([]),
  manifest_base: z.enum(['file', 'root']).default('file'),
  linked_roots: z.array(z.string()).default([]),
  discovery: z.enum(['recursive', 'manifest']).default('recursive'),
});
export type Scope = z.infer<typeof scopeSchema>;

export const resourceSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  kind: z.string().min(1),
  scope: z.string(), owner: z.string(), summary: z.string(),
  path: z.string().optional(), when: z.string().optional(), parent: z.string().optional(),
  children: z.array(z.string()).default([]), command: z.array(z.string()).optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  activation: z.string().optional(), topics: z.array(z.object({ id: z.string(), begin: z.string(), end: z.string() })).optional(),
}).passthrough();
export type Resource = z.infer<typeof resourceSchema>;

export const registrationSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  source: z.object({ kind: z.enum(['local', 'git', 'cli']), uri: z.string(), entry: z.string().optional(), revision: z.string().optional() }),
  target: z.string().optional(), owner: z.string().default('aicatlog'),
  state: z.enum(['active', 'optional', 'disabled', 'archived']).default('active'),
  activation: z.enum(['native', 'explicit', 'on_demand']).default('native'),
  clients: z.array(z.string()).default([]), metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Registration = z.infer<typeof registrationSchema>;

export const registrySchema = z.object({
  schema_version: z.literal('aicatlog.registry.v1'),
  scopes: z.array(scopeSchema), skills: z.array(registrationSchema).default([]),
  clients: z.array(z.record(z.string(), z.unknown())).default([]),
  project_clients: z.array(z.record(z.string(), z.unknown())).default([]),
  normalization_rules: z.array(z.record(z.string(), z.unknown())).default([]),
  resources: z.array(resourceSchema).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  import_provenance: z.record(z.string(), z.unknown()).optional(),
});
export type Registry = z.infer<typeof registrySchema>;
export type Context = { registryPath: string; stateRoot: string; cacheRoot: string; sessionId: string; tgrep?: string };
export type Diagnostic = { code: string; path?: string; message: string };
export type Catalog = { schema_version: 'aicatlog.catalog.v1'; generated_at: string; registry_sha256: string; resources: Resource[]; errors: Diagnostic[];
  source_stamps?: Record<string, string> };

export const diagnosticSchema = z.object({ code: z.string(), path: z.string().optional(), message: z.string() });
export const listOutputSchema = z.object({ items: z.array(resourceSchema), total: z.number(), next_cursor: z.number().nullable(), catalog_generated_at: z.string(), diagnostics: z.array(diagnosticSchema) });
export const readOutputSchema = z.object({ id: z.string(), source: z.object({ path: z.string(), sha256: z.string(), start_line: z.number(), end_line: z.number(), current_read_at: z.string() }), text: z.string(), next_line: z.number().nullable() });

export class AicatlogError extends Error {
  constructor(public code: string, message: string, public details?: unknown, public retryable = false) { super(message); }
}

export const operationSchema = z.object({
  action: z.enum(['write', 'copy', 'link', 'remove']), target: z.string(),
  source: z.string().optional(), content: z.string().optional(), executable: z.boolean().optional(),
  before: z.string().nullable(), source_digest: z.string().optional(),
  excludes: z.array(z.string()).optional(),
  git_root: z.string().optional(),
});
export const planSchema = z.object({
  schema_version: z.literal('aicatlog.plan.v1'), id: z.string(), created_at: z.string(),
  purpose: z.string(), roots: z.array(z.string()), registry_sha256: z.string().optional(),
  operations: z.array(operationSchema), conflicts: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]), plan_sha256: z.string(),
});
export type Plan = z.infer<typeof planSchema>;
export type Operation = z.infer<typeof operationSchema>;
