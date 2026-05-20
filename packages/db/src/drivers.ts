// STEELO Phase 1: drivers / driver_aliases のクエリ関数
import { jstNow } from './utils.js';

export interface DriverRow {
  id: string;
  name: string;
  name_kana: string | null;
  line_group_id: string | null;
  line_group_name: string | null;
  has_invoice: number;
  is_active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriverAliasRow {
  id: string;
  driver_id: string;
  alias_name: string;
  created_at: string;
}

export interface CreateDriverInput {
  name: string;
  nameKana?: string | null;
  lineGroupId?: string | null;
  lineGroupName?: string | null;
  hasInvoice?: boolean;
  isActive?: boolean;
  notes?: string | null;
}

export type UpdateDriverInput = Partial<CreateDriverInput>;

export class DriverDuplicateGroupIdError extends Error {
  constructor(public lineGroupId: string) {
    super(`line_group_id already exists: ${lineGroupId}`);
    this.name = 'DriverDuplicateGroupIdError';
  }
}

export class DriverAliasDuplicateError extends Error {
  constructor(public aliasName: string) {
    super(`alias_name already exists: ${aliasName}`);
    this.name = 'DriverAliasDuplicateError';
  }
}

// =============================================================================
// drivers
// =============================================================================

export async function listDrivers(
  db: D1Database,
  opts: { activeOnly?: boolean } = {}
): Promise<DriverRow[]> {
  const sql = opts.activeOnly
    ? `SELECT * FROM drivers WHERE is_active = 1 ORDER BY name ASC`
    : `SELECT * FROM drivers ORDER BY is_active DESC, name ASC`;
  const r = await db.prepare(sql).all<DriverRow>();
  return r.results;
}

export async function getDriverById(
  db: D1Database,
  id: string
): Promise<DriverRow | null> {
  return db.prepare(`SELECT * FROM drivers WHERE id = ?`).bind(id).first<DriverRow>();
}

export async function getDriverByLineGroupId(
  db: D1Database,
  lineGroupId: string
): Promise<DriverRow | null> {
  return db
    .prepare(`SELECT * FROM drivers WHERE line_group_id = ?`)
    .bind(lineGroupId)
    .first<DriverRow>();
}

export async function getDriverByName(
  db: D1Database,
  name: string
): Promise<DriverRow | null> {
  return db.prepare(`SELECT * FROM drivers WHERE name = ?`).bind(name).first<DriverRow>();
}

export async function createDriver(
  db: D1Database,
  input: CreateDriverInput
): Promise<DriverRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  try {
    await db
      .prepare(
        `INSERT INTO drivers
         (id, name, name_kana, line_group_id, line_group_name,
          has_invoice, is_active, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.name,
        input.nameKana ?? null,
        input.lineGroupId ?? null,
        input.lineGroupName ?? null,
        input.hasInvoice ? 1 : 0,
        input.isActive === false ? 0 : 1,
        input.notes ?? null,
        now,
        now
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e) && input.lineGroupId) {
      throw new DriverDuplicateGroupIdError(input.lineGroupId);
    }
    throw e;
  }
  const row = await getDriverById(db, id);
  if (!row) throw new Error('createDriver: insert succeeded but row missing');
  return row;
}

export async function updateDriver(
  db: D1Database,
  id: string,
  updates: UpdateDriverInput
): Promise<DriverRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push('name = ?');
    values.push(updates.name);
  }
  if (updates.nameKana !== undefined) {
    sets.push('name_kana = ?');
    values.push(updates.nameKana);
  }
  if (updates.lineGroupId !== undefined) {
    sets.push('line_group_id = ?');
    values.push(updates.lineGroupId);
  }
  if (updates.lineGroupName !== undefined) {
    sets.push('line_group_name = ?');
    values.push(updates.lineGroupName);
  }
  if (updates.hasInvoice !== undefined) {
    sets.push('has_invoice = ?');
    values.push(updates.hasInvoice ? 1 : 0);
  }
  if (updates.isActive !== undefined) {
    sets.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }
  if (updates.notes !== undefined) {
    sets.push('notes = ?');
    values.push(updates.notes);
  }
  if (sets.length === 0) return getDriverById(db, id);
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  try {
    await db.prepare(`UPDATE drivers SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  } catch (e) {
    if (isUniqueViolation(e) && updates.lineGroupId) {
      throw new DriverDuplicateGroupIdError(updates.lineGroupId);
    }
    throw e;
  }
  return getDriverById(db, id);
}

/** 論理削除（is_active = 0）。物理削除は行わない（FK 維持） */
export async function archiveDriver(db: D1Database, id: string): Promise<DriverRow | null> {
  await db
    .prepare(`UPDATE drivers SET is_active = 0, updated_at = ? WHERE id = ?`)
    .bind(jstNow(), id)
    .run();
  return getDriverById(db, id);
}

// =============================================================================
// driver_aliases
// =============================================================================

export async function listDriverAliases(
  db: D1Database,
  opts: { driverId?: string } = {}
): Promise<DriverAliasRow[]> {
  if (opts.driverId) {
    const r = await db
      .prepare(`SELECT * FROM driver_aliases WHERE driver_id = ? ORDER BY alias_name ASC`)
      .bind(opts.driverId)
      .all<DriverAliasRow>();
    return r.results;
  }
  const r = await db
    .prepare(`SELECT * FROM driver_aliases ORDER BY alias_name ASC`)
    .all<DriverAliasRow>();
  return r.results;
}

export async function createDriverAlias(
  db: D1Database,
  input: { driverId: string; aliasName: string }
): Promise<DriverAliasRow> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO driver_aliases (id, driver_id, alias_name) VALUES (?, ?, ?)`
      )
      .bind(id, input.driverId, input.aliasName)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new DriverAliasDuplicateError(input.aliasName);
    }
    throw e;
  }
  const row = await db
    .prepare(`SELECT * FROM driver_aliases WHERE id = ?`)
    .bind(id)
    .first<DriverAliasRow>();
  if (!row) throw new Error('createDriverAlias: insert succeeded but row missing');
  return row;
}

export async function deleteDriverAlias(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM driver_aliases WHERE id = ?`).bind(id).run();
}

/**
 * Excel DR 名から driver_id を解決する。
 *   1. drivers.name 完全一致
 *   2. driver_aliases.alias_name 完全一致
 *   それ以外は null
 */
export async function resolveDriverIdByName(
  db: D1Database,
  name: string
): Promise<string | null> {
  if (!name) return null;
  const byName = await db
    .prepare(`SELECT id FROM drivers WHERE name = ?`)
    .bind(name)
    .first<{ id: string }>();
  if (byName) return byName.id;
  const byAlias = await db
    .prepare(`SELECT driver_id FROM driver_aliases WHERE alias_name = ?`)
    .bind(name)
    .first<{ driver_id: string }>();
  return byAlias?.driver_id ?? null;
}

// =============================================================================
// utils
// =============================================================================

function isUniqueViolation(e: unknown): boolean {
  // D1 / SQLite の UNIQUE 制約違反は message に "UNIQUE" を含む
  return e instanceof Error && /UNIQUE/i.test(e.message);
}
