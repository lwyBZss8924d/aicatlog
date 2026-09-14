import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { renameExclusive } from './atomic-fs.ts';
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

type JournalRow = { operation: Operation; backup: string; staging: string; expected_after: string | null; state: 'preparing' | 'staged' | 'retired' | 'published' };
type Journal = { schema_version: string; plan_id: string; status: string; rows: JournalRow[] };
export type Receipt = { schema_version: string; plan_id: string; plan_sha256: string; status: 'applied'; completed_at: string;
  operations: number; session_id: string; journal: string; already_applied: boolean; recovered?: boolean };
export type ApplyObserver = (event: 'staged' | 'retired' | 'published_before_journal' | 'published' | 'journal_applied', row?: JournalRow) => Promise<void>;
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
    const original = await fingerprint(row.backup);
    if (original !== null) {
      if (current !== null) {
        if (current !== row.expected_after) throw new AicatlogError('RECOVERY_CONFLICT', `Preserved conflicting target and original: ${row.operation.target}`);
        renameExclusive(row.operation.target, `${row.staging}.rejected-${randomUUID()}`);
      }
      renameExclusive(row.backup, row.operation.target);
    } else if (row.operation.before === null && (row.state === 'published' ||
      row.state === 'staged' && await fingerprint(row.staging) === null)) {
      if (current === row.expected_after && current !== null) renameExclusive(row.operation.target, `${row.staging}.rejected-${randomUUID()}`);
      else if (current !== null) throw new AicatlogError('RECOVERY_CONFLICT', `New target changed: ${row.operation.target}`);
    }
    // A row with no retired original and no publication did not touch its target.
    // Preserve any user edit that caused the pre-publication check to fail.
  }
}

export async function applyPlan(ctx: Context, input: unknown, recover = false, observe?: ApplyObserver): Promise<Receipt> {
  const plan = planSchema.parse(input);
  if (planDigest(plan) !== plan.plan_sha256) throw new AicatlogError('PLAN_CHANGED', 'Plan digest does not match its contents.');
  const stored = await jsonFile<Plan>(join(ctx.stateRoot, 'plans', `${plan.id}.json`));
  if (canonical(stored) !== canonical(plan)) throw new AicatlogError('PLAN_NOT_PREPARED', 'Use the exact plan produced by this installation.');
  if (plan.conflicts.length) throw new AicatlogError('PLAN_CONFLICT', 'Resolve conflicts and prepare a new plan.', plan.conflicts);
  const runRoot = join(ctx.stateRoot, 'runs', plan.id), journalPath = join(runRoot, 'journal.json'), receiptPath = join(runRoot, 'receipt.json');
  const complete = async () => {
    for (const op of plan.operations) if (await fingerprint(op.target) !== await after(op)) return false;
    return true;
  };
  const receipt = await jsonFile<Receipt>(receiptPath).catch(() => null);
  if (receipt?.status === 'applied') {
    if (receipt.plan_id !== plan.id || receipt.plan_sha256 !== plan.plan_sha256) throw new AicatlogError('RECEIPT_MISMATCH', 'Receipt does not belong to this plan.');
    if (!await complete()) throw new AicatlogError('POST_APPLY_DRIFT', 'Previously applied targets changed.');
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
  catch { throw new AicatlogError('LOCK_HELD', 'Another apply or interrupted operation owns the writer lock.'); }
  await lock.writeFile(JSON.stringify({ pid: process.pid, plan_id: plan.id, session_id: ctx.sessionId }));
  let journal: Journal = { schema_version: 'aicatlog.journal.v2', plan_id: plan.id, status: 'applying', rows: [] };
  const finish = async (recovered = false): Promise<Receipt> => {
    const result: Receipt = { schema_version: 'aicatlog.receipt.v1', plan_id: plan.id, plan_sha256: plan.plan_sha256,
      status: 'applied', completed_at: now(), operations: plan.operations.length, session_id: ctx.sessionId,
      journal: journalPath, already_applied: false, recovered };
    await saveJson(receiptPath, result); return result;
  };
  try {
    const previous = await jsonFile<Journal>(journalPath).catch(() => null);
    if (previous && ['applying', 'recovery_required', 'applied'].includes(previous.status)) {
      if (!recover) throw new AicatlogError('RECOVERY_REQUIRED', 'An unfinished journal exists; use explicit recovery.');
      if (previous.rows.length === plan.operations.length && await complete()) return finish(true);
      await restore(previous);
    }
    if (plan.registry_sha256 && sha(await readFile(ctx.registryPath)) !== plan.registry_sha256)
      throw new AicatlogError('REGISTRY_CHANGED', 'Registry changed since planning.');
    for (const op of plan.operations) {
      const root = plan.roots.find(r => inside(r, op.target));
      if (!root) throw new AicatlogError('OUTSIDE_SCOPE', `Target outside prepared roots: ${op.target}`);
      await assertContained(root, op.target);
      if (await fingerprint(op.target) !== op.before) throw new AicatlogError('TARGET_CHANGED', `Target changed since planning: ${op.target}`);
      if (op.source && op.action !== 'link' && await fingerprint(op.source, op.excludes) !== op.source_digest)
        throw new AicatlogError('SOURCE_CHANGED', `Source changed since planning: ${op.source}`);
    }
    await mkdir(runRoot, { recursive: true });
    await saveJson(journalPath, journal);
    for (const [index, op] of plan.operations.entries()) {
      const backup = join(runRoot, 'originals', String(index)), staging = join(runRoot, 'staging', `${index}-${randomUUID()}`);
      await mkdir(dirname(backup), { recursive: true }); await mkdir(dirname(staging), { recursive: true });
      const row: JournalRow = { operation: op, backup, staging, expected_after: await after(op), state: 'preparing' };
      journal.rows.push(row); await saveJson(journalPath, journal);
      if (op.action === 'write') await atomic(staging, op.content ?? '', op.executable ? 0o755 : 0o644);
      else if (op.action !== 'remove') {
        if (!op.source) throw new AicatlogError('SOURCE_REQUIRED', 'Copy/link requires a source.');
        if (inside(op.source, op.target) || inside(op.target, op.source)) throw new AicatlogError('OVERLAPPING_PATHS', 'Source and target must not overlap.');
        if (op.action === 'link') {
          if (!await fingerprint(op.source)) throw new AicatlogError('SOURCE_UNAVAILABLE', `Link source unavailable: ${op.source}`);
          await symlink(op.source, staging);
        } else await cp(op.source, staging, { recursive: true, dereference: false, verbatimSymlinks: true, filter: path => !op.excludes?.includes(basename(path)) });
      }
      if (op.action !== 'remove' && await fingerprint(staging) !== row.expected_after) throw new AicatlogError('SOURCE_CHANGED', 'Staged contents differ from the prepared version.');
      row.state = 'staged'; await saveJson(journalPath, journal); await observe?.('staged', row);
      await mkdir(dirname(op.target), { recursive: true });
      if (await fingerprint(op.target) !== op.before) throw new AicatlogError('TARGET_CHANGED', `Target changed while staging: ${op.target}`);
      if (op.before !== null) {
        renameExclusive(op.target, backup);
        row.state = 'retired'; await saveJson(journalPath, journal); await observe?.('retired', row);
        if (await fingerprint(backup) !== op.before) throw new AicatlogError('TARGET_CHANGED', 'Original changed at the publication boundary; retained for recovery.');
      }
      if (op.action !== 'remove') renameExclusive(staging, op.target);
      await observe?.('published_before_journal', row);
      row.state = 'published'; await saveJson(journalPath, journal); await observe?.('published', row);
      if (await fingerprint(op.target) !== row.expected_after) throw new AicatlogError('POSTCONDITION_FAILED', `Target does not match plan: ${op.target}`);
    }
    journal.status = 'applied'; await saveJson(journalPath, journal); await observe?.('journal_applied');
    return await finish();
  } catch (error) {
    if (journal.rows.length) {
      try { await restore(journal); journal.status = 'rolled_back'; }
      catch (recovery) { journal.status = 'recovery_required'; await saveJson(journalPath, journal); throw new AicatlogError('RECOVERY_REQUIRED', String(recovery)); }
      await saveJson(journalPath, journal);
    }
    throw error;
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
