import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listDrivers,
  getDriverById,
  getDriverByLineGroupId,
  createDriver,
  updateDriver,
  archiveDriver,
  listDriverAliases,
  createDriverAlias,
  deleteDriverAlias,
  resolveDriverIdByName,
  DriverDuplicateGroupIdError,
  DriverAliasDuplicateError,
} from './drivers.js';
import { createSqliteD1, type SqliteD1 } from './test-helpers/sqlite-d1.js';

let h: SqliteD1;

beforeEach(() => {
  h = createSqliteD1();
});

afterEach(() => {
  h.close();
});

describe('drivers CRUD', () => {
  it('createDriver → getDriverById で round-trip', async () => {
    const created = await createDriver(h.db, {
      name: '田中太郎',
      nameKana: 'タナカタロウ',
      lineGroupId: 'G_tanaka',
      lineGroupName: '田中DR配車',
      hasInvoice: true,
      notes: 'メモ',
    });
    expect(created.name).toBe('田中太郎');
    expect(created.has_invoice).toBe(1);
    expect(created.is_active).toBe(1);

    const fetched = await getDriverById(h.db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.line_group_id).toBe('G_tanaka');
  });

  it('lineGroupId が重複したら DriverDuplicateGroupIdError', async () => {
    await createDriver(h.db, { name: '田中太郎', lineGroupId: 'G_x' });
    await expect(
      createDriver(h.db, { name: '別人', lineGroupId: 'G_x' })
    ).rejects.toBeInstanceOf(DriverDuplicateGroupIdError);
  });

  it('updateDriver で has_invoice を変更できる', async () => {
    const d = await createDriver(h.db, { name: '田中太郎', hasInvoice: false });
    const updated = await updateDriver(h.db, d.id, { hasInvoice: true });
    expect(updated!.has_invoice).toBe(1);
  });

  it('archiveDriver は is_active=0 に変更し物理削除しない', async () => {
    const d = await createDriver(h.db, { name: '田中太郎' });
    const archived = await archiveDriver(h.db, d.id);
    expect(archived!.is_active).toBe(0);
    // 物理的には残っている
    expect(await getDriverById(h.db, d.id)).not.toBeNull();
  });

  it('listDrivers は activeOnly オプションでフィルタできる', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    await createDriver(h.db, { name: 'B' });
    await archiveDriver(h.db, a.id);
    expect((await listDrivers(h.db)).length).toBe(2);
    expect((await listDrivers(h.db, { activeOnly: true })).length).toBe(1);
  });

  it('getDriverByLineGroupId は存在しないグループに対し null を返す', async () => {
    expect(await getDriverByLineGroupId(h.db, 'G_missing')).toBeNull();
  });
});

describe('driver_aliases CRUD', () => {
  it('alias_name UNIQUE 違反は DriverAliasDuplicateError', async () => {
    const d = await createDriver(h.db, { name: '田中太郎' });
    await createDriverAlias(h.db, { driverId: d.id, aliasName: 'タナカ' });
    await expect(
      createDriverAlias(h.db, { driverId: d.id, aliasName: 'タナカ' })
    ).rejects.toBeInstanceOf(DriverAliasDuplicateError);
  });

  it('listDriverAliases は driverId でフィルタできる', async () => {
    const a = await createDriver(h.db, { name: 'A' });
    const b = await createDriver(h.db, { name: 'B' });
    await createDriverAlias(h.db, { driverId: a.id, aliasName: 'a1' });
    await createDriverAlias(h.db, { driverId: a.id, aliasName: 'a2' });
    await createDriverAlias(h.db, { driverId: b.id, aliasName: 'b1' });
    expect((await listDriverAliases(h.db, { driverId: a.id })).length).toBe(2);
    expect((await listDriverAliases(h.db)).length).toBe(3);
  });

  it('deleteDriverAlias で削除できる', async () => {
    const d = await createDriver(h.db, { name: '田中太郎' });
    const alias = await createDriverAlias(h.db, { driverId: d.id, aliasName: 'タナカ' });
    await deleteDriverAlias(h.db, alias.id);
    expect((await listDriverAliases(h.db)).length).toBe(0);
  });
});

describe('resolveDriverIdByName', () => {
  it('drivers.name 完全一致を優先', async () => {
    const d = await createDriver(h.db, { name: '田中太郎' });
    expect(await resolveDriverIdByName(h.db, '田中太郎')).toBe(d.id);
  });

  it('alias_name でも解決できる（マスタに無いとき）', async () => {
    const d = await createDriver(h.db, { name: '田中太郎' });
    await createDriverAlias(h.db, { driverId: d.id, aliasName: 'タナカ' });
    expect(await resolveDriverIdByName(h.db, 'タナカ')).toBe(d.id);
  });

  it('どちらにも該当しなければ null', async () => {
    expect(await resolveDriverIdByName(h.db, '存在しない人')).toBeNull();
  });

  it('空文字列は null', async () => {
    expect(await resolveDriverIdByName(h.db, '')).toBeNull();
  });
});
