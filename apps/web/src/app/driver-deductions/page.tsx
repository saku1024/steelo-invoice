'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver, DriverDeduction } from '@line-crm/shared'

type DraftRow = {
  driverId: string
  driverName: string
  vehicleCost: number
  processingFee: number
  prepayment: number
  notes: string
  dirty: boolean
  existing: boolean
}

function defaultPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function DriverDeductionsPage() {
  const [period, setPeriod] = useState(defaultPeriod())
  const [rows, setRows] = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [drvR, dedR] = await Promise.all([
        steelo.drivers.list(true),
        steelo.driverDeductions.list({ period }),
      ])
      if (!drvR.success || !dedR.success) {
        setError('読み込みに失敗しました')
        return
      }
      const dedMap = new Map<string, DriverDeduction>(dedR.data.map((d) => [d.driverId, d]))
      const next: DraftRow[] = drvR.data.map((d) => {
        const e = dedMap.get(d.id)
        return {
          driverId: d.id,
          driverName: d.name,
          vehicleCost: e?.vehicleCost ?? 0,
          processingFee: e?.processingFee ?? 0,
          prepayment: e?.prepayment ?? 0,
          notes: e?.notes ?? '',
          dirty: false,
          existing: Boolean(e),
        }
      })
      setRows(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [period])

  const update = (driverId: string, patch: Partial<DraftRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.driverId === driverId ? { ...r, ...patch, dirty: true } : r))
    )
  }

  const saveRow = async (row: DraftRow) => {
    setSavingId(row.driverId)
    try {
      const r = await steelo.driverDeductions.upsert({
        driverId: row.driverId,
        period,
        vehicleCost: row.vehicleCost,
        processingFee: row.processingFee,
        prepayment: row.prepayment,
        notes: row.notes || null,
      })
      if (!r.success) throw new Error('save failed')
      setRows((prev) =>
        prev.map((x) =>
          x.driverId === row.driverId ? { ...x, dirty: false, existing: true } : x
        )
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingId(null)
    }
  }

  const saveAll = async () => {
    const dirty = rows.filter((r) => r.dirty)
    for (const r of dirty) {
      await saveRow(r)
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">月次控除マスタ</h1>
      <p className="mb-4 text-sm text-gray-600">
        ドライバー別・月別の車両代 / 電算処理費 / 前払金。支払明細生成時にこの値が使われます
        （BOND's Excel ヘッダーの会社合計値は支払計算には使いません）。
      </p>

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm font-semibold">対象月</label>
        <input
          type="month"
          className="rounded border px-2 py-1"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
        <button
          onClick={saveAll}
          disabled={!rows.some((r) => r.dirty)}
          className="ml-auto rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
        >
          変更を一括保存
        </button>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">ドライバー</th>
              <th className="px-3 py-2 text-right">車両代</th>
              <th className="px-3 py-2 text-right">電算処理費</th>
              <th className="px-3 py-2 text-right">前払金</th>
              <th className="px-3 py-2 text-left">メモ</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.driverId} className={`border-t ${r.dirty ? 'bg-yellow-50' : ''}`}>
                <td className="px-3 py-2 font-medium">{r.driverName}</td>
                {(['vehicleCost', 'processingFee', 'prepayment'] as const).map((k) => (
                  <td key={k} className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min={0}
                      className="w-24 rounded border px-2 py-1 text-right"
                      value={r[k]}
                      onChange={(e) =>
                        update(r.driverId, { [k]: Number(e.target.value || 0) } as Partial<DraftRow>)
                      }
                    />
                  </td>
                ))}
                <td className="px-3 py-2">
                  <input
                    className="w-48 rounded border px-2 py-1"
                    value={r.notes}
                    onChange={(e) => update(r.driverId, { notes: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  {r.dirty && (
                    <button
                      onClick={() => saveRow(r)}
                      disabled={savingId === r.driverId}
                      className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:bg-gray-300"
                    >
                      保存
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  対象期間のドライバーがいません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
