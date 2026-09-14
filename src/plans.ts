import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AicatlogError, planSchema, type Context, type Operation, type Plan } from './types.ts';
import { assertContained, atomic, expand, fingerprint, inside, jsonFile, now, saveJson, sha } from './io.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function planDigest(plan: Omit<Plan, 'plan_sha256'> | Plan): string {
  const { plan_sha256: ignored, ...body } = plan as Plan;
  return sha(canonical(body));
}
export async function operation(action: Operation['action'], target: string, extra: Partial<Operation> = {}): Promise<Operation> {
  target = expand(target);
  const source = extra.source ? expand(extra.source) : undefined;
  return { ...extra, action, target, before: await fingerprint(target),
    ...(source ? { source, source_digest: (await fingerprint(source, extra.excludes)) ?? undefined } : {}) };
}
export async function makePlan(ctx: Context, purpose: string, roots: string[], operations: Operation[], conflicts: string[] = [], notes: string[] = []) {
  const registryBytes = await readFile(ctx.registryPath).catch(() => null);
  const body = { schema_version: 'aicatlog.plan.v1' as const, id: randomUUID(), created_at: now(), purpose,
    roots: roots.map(r => expand(r)), ...(registryBytes ? { registry_sha256: sha(registryBytes) } : {}), operations, conflicts, notes };
  const plan: Plan = { ...body, plan_sha256: planDigest(body) };
  const planPath = join(ctx.stateRoot, 'plans', `${plan.id}.json`);
  await saveJson(planPath, plan);
  return { ...plan, plan_path: planPath };
}

type JournalRow = { operation: Operation; backup: string; expected_after: string | null; state: 'prepared' | 'done' };
type Journal = { schema_version: string; plan_id: string; status: string; rows: JournalRow[] };
export type Receipt = { schema_version: string; plan_id: string; plan_sha256: string; status: 'applied'; completed_at: string;
  operations: number; session_id: string; journal: string; already_applied: boolean };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

async function after(op: Operation): Promise<string | null> {
  if (op.action === 'remove') return null;
  if (op.action === 'write') return `file:${sha(op.content ?? '')}`;
  if (op.action === 'link') return `link:${op.source}`;
  return op.source_digest ?? null;
}
async function restore(journal: Journal) {
  for (const row of [...journal.rows].reverse()) {
    const current = await fingerprint(row.operation.target);
    if (current === row.operation.before) continue;
    if (current !== row.expected_after) throw new AicatlogError('RECOVERY_CONFLICT', `Target changed outside this operation: ${row.operation.target}`);
    await rm(row.operation.target, { force: true, recursive: true });
    if (row.operation.before !== null) {
      await mkdir(dirname(row.operation.target), { recursive: true });
      await cp(row.backup, row.operation.target, { recursive: true, dereference: false, verbatimSymlinks: true });
    }
  }
}

export async function applyPlan(ctx: Context, input: unknown, recover = false): Promise<Receipt> {
  const plan = planSchema.parse(input);
  if (planDigest(plan) !== plan.plan_sha256) throw new AicatlogError('PLAN_CHANGED', 'Plan digest does not match its contents.');
  const stored = await jsonFile<Plan>(join(ctx.stateRoot, 'plans', `${plan.id}.json`));
  if (canonical(stored) !== canonical(plan)) throw new AicatlogError('PLAN_NOT_PREPARED', 'Use the exact plan produced by this installation.');
  if (plan.conflicts.length) throw new AicatlogError('PLAN_CONFLICT', 'Resolve the reported conflicts and prepare a new plan.', plan.conflicts);
  const runRoot = join(ctx.stateRoot, 'runs', plan.id), journalPath = join(runRoot, 'journal.json'), receiptPath = join(runRoot, 'receipt.json');
  const receipt = await jsonFile<Receipt>(receiptPath).catch(() => null);
  if (receipt?.status === 'applied') {
    if (receipt.plan_id !== plan.id || receipt.plan_sha256 !== plan.plan_sha256) throw new AicatlogError('RECEIPT_MISMATCH', 'Receipt does not belong to this plan.');
    for (const op of plan.operations) if (await fingerprint(op.target) !== await after(op))
      throw new AicatlogError('POST_APPLY_DRIFT', `Previously applied target changed: ${op.target}`);
    return { ...receipt, already_applied: true };
  }
  await mkdir(ctx.stateRoot, { recursive: true });
  const lockPath = join(ctx.stateRoot, 'apply.lock');
  if (recover) {
    const lock = await jsonFile<{ pid: number; plan_id: string }>(lockPath).catch(() => null);
    if (lock && (lock.plan_id !== plan.id || alive(lock.pid))) throw new AicatlogError('LOCK_HELD', 'Recovery requires this plan and an exited owner.');
    if (lock) await rm(lockPath);
  }
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new AicatlogError('LOCK_HELD', 'Another apply or interrupted operation owns the writer lock. Inspect its receipt before recovery.'); }
  await lock.writeFile(JSON.stringify({ pid: process.pid, plan_id: plan.id, session_id: ctx.sessionId }));
  let journal: Journal = { schema_version: 'aicatlog.journal.v1', plan_id: plan.id, status: 'applying', rows: [] };
  try {
    const previous = await jsonFile<Journal>(journalPath).catch(() => null);
    if (previous && previous.status === 'applying') {
      if (!recover) throw new AicatlogError('RECOVERY_REQUIRED', 'An interrupted journal exists; use explicit recovery.');
      await restore(previous);
    }
    if (plan.registry_sha256 && sha(await readFile(ctx.registryPath)) !== plan.registry_sha256)
      throw new AicatlogError('REGISTRY_CHANGED', 'Registry changed since planning.');
    for (const op of plan.operations) {
      const root = plan.roots.find(r => inside(r, op.target));
      if (!root) throw new AicatlogError('OUTSIDE_SCOPE', `Target is not in the prepared roots: ${op.target}`);
      await assertContained(root, op.target);
      if (await fingerprint(op.target) !== op.before) throw new AicatlogError('TARGET_CHANGED', `Target changed since planning: ${op.target}`);
      if (op.source && op.action !== 'link' && await fingerprint(op.source, op.excludes) !== op.source_digest) throw new AicatlogError('SOURCE_CHANGED', `Source changed since planning: ${op.source}`);
    }
    await mkdir(runRoot, { recursive: true });
    await saveJson(journalPath, journal);
    for (const [index, op] of plan.operations.entries()) {
      const backup = join(runRoot, 'backups', String(index));
      if (op.before !== null) {
        await mkdir(dirname(backup), { recursive: true });
        await cp(op.target, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      const row: JournalRow = { operation: op, backup, expected_after: await after(op), state: 'prepared' };
      journal.rows.push(row); await saveJson(journalPath, journal);
      await mkdir(dirname(op.target), { recursive: true });
      if (op.action === 'write') await atomic(op.target, op.content ?? '', op.executable ? 0o755 : 0o644);
      else if (op.action === 'remove') await rm(op.target, { recursive: true, force: true });
      else {
        if (!op.source) throw new AicatlogError('SOURCE_REQUIRED', 'Copy/link requires a source.');
        if (inside(op.source, op.target) || inside(op.target, op.source)) throw new AicatlogError('OVERLAPPING_PATHS', 'Source and target must not overlap.');
        const temporary = `${op.target}.${plan.id}.staging`;
        if (op.action === 'link') {
          if (!await fingerprint(op.source)) throw new AicatlogError('SOURCE_UNAVAILABLE', `Link source is unavailable: ${op.source}`);
          await symlink(op.source, temporary);
        }
        else await cp(op.source, temporary, { recursive: true, dereference: false, verbatimSymlinks: true, filter: source => !op.excludes?.includes(basename(source)) });
        await rm(op.target, { recursive: true, force: true });
        await rename(temporary, op.target);
      }
      if (await fingerprint(op.target) !== row.expected_after) throw new AicatlogError('POSTCONDITION_FAILED', `Written target does not match plan: ${op.target}`);
      row.state = 'done'; await saveJson(journalPath, journal);
    }
    journal.status = 'applied'; await saveJson(journalPath, journal);
    const result: Receipt = { schema_version: 'aicatlog.receipt.v1', plan_id: plan.id, plan_sha256: plan.plan_sha256, status: 'applied',
      completed_at: now(), operations: plan.operations.length, session_id: ctx.sessionId, journal: journalPath, already_applied: false };
    await saveJson(receiptPath, result); return result;
  } catch (error) {
    if (journal.rows.length) {
      try { await restore(journal); journal.status = 'rolled_back'; }
      catch (recovery) { journal.status = 'recovery_required'; await saveJson(journalPath, journal); throw new AicatlogError('RECOVERY_REQUIRED', String(recovery)); }
      await saveJson(journalPath, journal);
    }
    throw error;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
