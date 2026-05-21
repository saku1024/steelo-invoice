'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver, DispatchRecord } from '@line-crm/shared'

export default function DispatchRecordsPage() {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [records, setRecords] = useState<DispatchRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<DispatchRecord> | null>(null)
  const [filter, setFilter] = useState({
    driverId: '',
    from: '',
    to: '',
    status: '' as '' | 'auto' | 'needs_review' | 'confirmed',
    confidence: '' as '' | 'high' | 'medium' | 'low',
  })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      if (drivers.length === 0) {
        const dr = await steelo.drivers.list(true)
        if (dr.success) setDrivers(dr.data)
      }
      const r = await steelo.dispatchRecords.list({
        driverId: filter.driverId || undefined,
        from: filter.from || undefined,
        to: filter.to || undefined,
      })
      if (r.success) setRecords(r.data.items)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [filter])

  const driverName = (id: string) => drivers.find((d) => d.id === id)?.name ?? id.slice(0, 8)

  // Phase 2: status / confidence のクライアント側フィルタ
  const filteredRecords = records.filter((r) => {
    if (filter.status && r.status !== filter.status) return false
    if (filter.confidence && r.confidence !== filter.confidence) return false
    return true
  })

  // Phase 2: status="confirmed" に切り替え（編集せず）
  const confirmRow = async (r: DispatchRecord) => {
    try {
      await steelo.dispatchRecords.update(r.id, { status: 'confirmed' })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  const save = async (rec: Partial<DispatchRecord>) => {
    try {
      if (rec.id) {
        await steelo.dispatchRecords.update(rec.id, rec)
      } else {
        await steelo.dispatchRecords.create(rec)
      }
      setEditing(null)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">配車レコード</h1>
        <button
          onClick={() =>
            setEditing({
              workDate: new Date().toISOString().slice(0, 10),
              status: 'confirmed',
            })
          }
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          + 新規
        </button>
      </div>
      <p className="mb-4 text-sm text-gray-600">
        Phase 1 では手動入力のみ。Phase 2 で LINE メッセージから自動構造化する予定。
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded border bg-gray-50 p-3 md:grid-cols-5">
        <select
          className="rounded border px-2 py-1"
          value={filter.driverId}
          onChange={(e) => setFilter({ ...filter, driverId: e.target.value })}
        >
          <option value="">全ドライバー</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="rounded border px-2 py-1"
          value={filter.from}
          onChange={(e) => setFilter({ ...filter, from: e.target.value })}
        />
        <input
          type="date"
          className="rounded border px-2 py-1"
          value={filter.to}
          onChange={(e) => setFilter({ ...filter, to: e.target.value })}
        />
        <select
          className="rounded border px-2 py-1"
          value={filter.status}
          onChange={(e) =>
            setFilter({ ...filter, status: e.target.value as typeof filter.status })
          }
        >
          <option value="">全ステータス</option>
          <option value="auto">auto（LLM自動）</option>
          <option value="needs_review">needs_review（要確認）</option>
          <option value="confirmed">confirmed（確認済み）</option>
        </select>
        <select
          className="rounded border px-2 py-1"
          value={filter.confidence}
          onChange={(e) =>
            setFilter({ ...filter, confidence: e.target.value as typeof filter.confidence })
          }
        >
          <option value="">全 confidence</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">作業日</th>
              <th className="px-3 py-2 text-left">ドライバー</th>
              <th className="px-3 py-2 text-left">業務名</th>
              <th className="px-3 py-2 text-center">status</th>
              <th className="px-3 py-2 text-center">conf.</th>
              <th className="px-3 py-2 text-left">積込→納品</th>
              <th className="px-3 py-2 text-left">時刻</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filteredRecords.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">{r.workDate}</td>
                <td className="px-3 py-2">{driverName(r.driverId)}</td>
                <td className="px-3 py-2">{r.taskName ?? '—'}</td>
                <td className="px-3 py-2 text-center">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-center">
                  <ConfidenceBadge confidence={r.confidence} />
                </td>
                <td className="px-3 py-2 text-gray-600">
                  {(r.pickupLocation ?? '—') + ' → ' + (r.deliveryLocation ?? '—')}
                </td>
                <td className="px-3 py-2 text-gray-600">
                  {(r.startTime ?? '—') + ' ~ ' + (r.endTime ?? '—')}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status !== 'confirmed' && (
                    <button
                      onClick={() => confirmRow(r)}
                      className="mr-2 rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
                    >
                      確認済み
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(r)}
                    className="text-blue-600 hover:underline"
                  >
                    編集
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filteredRecords.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  該当する配車レコードがありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <DispatchForm
          initial={editing}
          drivers={drivers}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function DispatchForm({
  initial,
  drivers,
  onSave,
  onCancel,
}: {
  initial: Partial<DispatchRecord>
  drivers: Driver[]
  onSave: (r: Partial<DispatchRecord>) => void | Promise<void>
  onCancel: () => void
}) {
  const [f, setF] = useState<Partial<DispatchRecord>>(initial)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-xl rounded bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">
          {initial.id ? '配車レコード編集' : '配車レコード新規'}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ドライバー">
            <select
              className="w-full rounded border px-2 py-1"
              value={f.driverId ?? ''}
              onChange={(e) => setF({ ...f, driverId: e.target.value })}
            >
              <option value="">選択…</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="作業日">
            <input
              type="date"
              className="w-full rounded border px-2 py-1"
              value={f.workDate ?? ''}
              onChange={(e) => setF({ ...f, workDate: e.target.value })}
            />
          </Field>
          <Field label="業務名">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.taskName ?? ''}
              onChange={(e) => setF({ ...f, taskName: e.target.value })}
            />
          </Field>
          <Field label="案件番号">
            <input
              type="number"
              className="w-full rounded border px-2 py-1"
              value={f.taskNumber ?? ''}
              onChange={(e) => setF({ ...f, taskNumber: Number(e.target.value) || null })}
            />
          </Field>
          <Field label="積込先">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.pickupLocation ?? ''}
              onChange={(e) => setF({ ...f, pickupLocation: e.target.value })}
            />
          </Field>
          <Field label="納品先">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.deliveryLocation ?? ''}
              onChange={(e) => setF({ ...f, deliveryLocation: e.target.value })}
            />
          </Field>
          <Field label="開始時刻">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.startTime ?? ''}
              onChange={(e) => setF({ ...f, startTime: e.target.value })}
            />
          </Field>
          <Field label="終了時刻">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.endTime ?? ''}
              onChange={(e) => setF({ ...f, endTime: e.target.value })}
            />
          </Field>
          <Field label="動態管理番号">
            <input
              className="w-full rounded border px-2 py-1"
              value={f.managementNumber ?? ''}
              onChange={(e) => setF({ ...f, managementNumber: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border px-4 py-2">
            キャンセル
          </button>
          <button
            onClick={() => onSave(f)}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-gray-600">{label}</div>
      {children}
    </div>
  )
}

function StatusBadge({ status }: { status: DispatchRecord['status'] }) {
  const colors: Record<DispatchRecord['status'], string> = {
    auto: 'bg-blue-100 text-blue-800',
    needs_review: 'bg-yellow-100 text-yellow-800',
    confirmed: 'bg-green-100 text-green-800',
  }
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${colors[status] ?? 'bg-gray-100'}`}>
      {status}
    </span>
  )
}

function ConfidenceBadge({ confidence }: { confidence: DispatchRecord['confidence'] }) {
  const colors: Record<DispatchRecord['confidence'], string> = {
    high: 'bg-green-50 text-green-700 border-green-300',
    medium: 'bg-yellow-50 text-yellow-700 border-yellow-300',
    low: 'bg-orange-50 text-orange-700 border-orange-300',
  }
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 font-mono text-xs ${
        colors[confidence] ?? 'bg-gray-50 border-gray-300'
      }`}
    >
      {confidence}
    </span>
  )
}
