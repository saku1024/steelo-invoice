'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver } from '@line-crm/shared'

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<Driver> | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await steelo.drivers.list(!showInactive)
      if (r.success) setDrivers(r.data)
      else setError('読み込みに失敗しました')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [showInactive])

  const save = async (d: Partial<Driver>) => {
    try {
      if (d.id) {
        await steelo.drivers.update(d.id, d)
      } else {
        await steelo.drivers.create(d)
      }
      setEditing(null)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  const archive = async (id: string) => {
    if (!confirm('このドライバーを論理削除しますか?（is_active=0）')) return
    try {
      await steelo.drivers.archive(id)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">ドライバーマスタ</h1>
        <button
          onClick={() => setEditing({})}
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          + 追加
        </button>
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
        />
        論理削除済みも表示
      </label>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">氏名</th>
              <th className="px-3 py-2 text-left">カナ</th>
              <th className="px-3 py-2 text-left">LINEグループ</th>
              <th className="px-3 py-2 text-center">インボイス</th>
              <th className="px-3 py-2 text-center">有効</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2 font-medium">{d.name}</td>
                <td className="px-3 py-2 text-gray-600">{d.nameKana ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">
                  {d.lineGroupName ?? '—'}
                  {d.lineGroupId && (
                    <span className="ml-2 text-xs text-gray-400">{d.lineGroupId.slice(0, 8)}…</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {d.hasInvoice ? (
                    <span className="inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">あり</span>
                  ) : (
                    <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">なし</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">{d.isActive ? '✓' : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setEditing(d)}
                    className="text-blue-600 hover:underline"
                  >
                    編集
                  </button>
                  {d.isActive && (
                    <button
                      onClick={() => archive(d.id)}
                      className="ml-3 text-red-600 hover:underline"
                    >
                      削除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && drivers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  ドライバーが登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <DriverForm
          initial={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function DriverForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Partial<Driver>
  onSave: (d: Partial<Driver>) => void | Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<Partial<Driver>>(initial)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">
          {initial.id ? 'ドライバー編集' : 'ドライバー追加'}
        </h2>
        <div className="space-y-3">
          <Field label="氏名">
            <input
              className="w-full rounded border px-2 py-1"
              value={form.name ?? ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="カナ">
            <input
              className="w-full rounded border px-2 py-1"
              value={form.nameKana ?? ''}
              onChange={(e) => setForm({ ...form, nameKana: e.target.value })}
            />
          </Field>
          <Field label="LINE グループ ID">
            <input
              className="w-full rounded border px-2 py-1"
              value={form.lineGroupId ?? ''}
              onChange={(e) => setForm({ ...form, lineGroupId: e.target.value })}
            />
          </Field>
          <Field label="LINE グループ名">
            <input
              className="w-full rounded border px-2 py-1"
              value={form.lineGroupName ?? ''}
              onChange={(e) => setForm({ ...form, lineGroupName: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(form.hasInvoice)}
              onChange={(e) => setForm({ ...form, hasInvoice: e.target.checked })}
            />
            インボイス登録あり
            <span className="ml-2 text-xs text-gray-500">
              ※変更は今後生成される支払明細にのみ反映されます
            </span>
          </label>
          <Field label="備考">
            <textarea
              className="w-full rounded border px-2 py-1"
              rows={2}
              value={form.notes ?? ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border px-4 py-2">
            キャンセル
          </button>
          <button
            onClick={() => onSave(form)}
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
