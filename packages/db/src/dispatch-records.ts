// STEELO Phase 1: dispatch_records のクエリ関数（手動入力）
import { jstNow } from './utils.js';

export interface DispatchRecordRow {
  id: string;
  driver_id: string;
  work_date: string;
  task_number: number | null;
  task_name: string | null;
  pickup_location: string | null;
  delivery_location: string | null;
  start_time: string | null;
  end_time: string | null;
  management_number: string | null;
  raw_message_id: string | null;
  confidence: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDispatchRecordInput {
  driverId: string;
  workDate: string;
  taskNumber?: number | null;
  taskName?: string | null;
  pickupLocation?: string | null;
  deliveryLocation?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  managementNumber?: string | null;
  rawMessageId?: string | null;
  status?: 'auto' | 'needs_review' | 'confirmed';
}

export type UpdateDispatchRecordInput = Partial<CreateDispatchRecordInput>;

export async function listDispatchRecords(
  db: D1Database,
  opts: { driverId?: string; from?: string; to?: string; limit?: number; offset?: number } = {}
): Promise<{ items: DispatchRecordRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.driverId) {
    where.push('driver_id = ?');
    vals.push(opts.driverId);
  }
  if (opts.from) {
    where.push('work_date >= ?');
    vals.push(opts.from);
  }
  if (opts.to) {
    where.push('work_date <= ?');
    vals.push(opts.to);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM dispatch_records ${w}`)
    .bind(...vals)
    .first<{ n: number }>();
  const r = await db
    .prepare(
      `SELECT * FROM dispatch_records ${w}
       ORDER BY work_date DESC, task_number ASC
       LIMIT ? OFFSET ?`
    )
    .bind(...vals, limit, offset)
    .all<DispatchRecordRow>();
  return { items: r.results, total: countRow?.n ?? 0 };
}

export async function getDispatchRecordById(
  db: D1Database,
  id: string
): Promise<DispatchRecordRow | null> {
  return db
    .prepare(`SELECT * FROM dispatch_records WHERE id = ?`)
    .bind(id)
    .first<DispatchRecordRow>();
}

export async function createDispatchRecord(
  db: D1Database,
  input: CreateDispatchRecordInput
): Promise<DispatchRecordRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO dispatch_records
       (id, driver_id, work_date, task_number, task_name,
        pickup_location, delivery_location, start_time, end_time,
        management_number, raw_message_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.driverId,
      input.workDate,
      input.taskNumber ?? null,
      input.taskName ?? null,
      input.pickupLocation ?? null,
      input.deliveryLocation ?? null,
      input.startTime ?? null,
      input.endTime ?? null,
      input.managementNumber ?? null,
      input.rawMessageId ?? null,
      input.status ?? 'confirmed',
      now,
      now
    )
    .run();
  return (await getDispatchRecordById(db, id))!;
}

export async function updateDispatchRecord(
  db: D1Database,
  id: string,
  updates: UpdateDispatchRecordInput
): Promise<DispatchRecordRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    driverId: 'driver_id',
    workDate: 'work_date',
    taskNumber: 'task_number',
    taskName: 'task_name',
    pickupLocation: 'pickup_location',
    deliveryLocation: 'delivery_location',
    startTime: 'start_time',
    endTime: 'end_time',
    managementNumber: 'management_number',
    rawMessageId: 'raw_message_id',
    status: 'status',
  };
  for (const [k, col] of Object.entries(map)) {
    const v = (updates as Record<string, unknown>)[k];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(v);
    }
  }
  if (sets.length === 0) return getDispatchRecordById(db, id);
  // 編集時は status='confirmed' に統一（Phase 1 仕様）
  if (!sets.some((s) => s.startsWith('status'))) {
    sets.push('status = ?');
    vals.push('confirmed');
  }
  sets.push('updated_at = ?');
  vals.push(jstNow());
  vals.push(id);
  await db.prepare(`UPDATE dispatch_records SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return getDispatchRecordById(db, id);
}
