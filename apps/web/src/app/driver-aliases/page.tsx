'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver, DriverAlias } from '@line-crm/shared'

export default function DriverAliasesPage() {
  const [aliases, setAliases] = useState<DriverAlias[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<string>('')
  const [newAlias, setNewAlias] = useState({ driverId: '', aliasName: '' })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [aR, dR] = await Promise.all([steelo.driverAliases.list(), steelo.drivers.list(true)])
      if (aR.success) setAliases(aR.data)
      if (dR.success) setDrivers(dR.data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const driverName = (id: string) => drivers.find((d) => d.id === id)?.name ?? id.slice(0, 8)

  const add = async () => {
    if (!newAlias.driverId || !newAlias.aliasName.trim()) return
    try {
      const r = await steelo.driverAliases.create(newAlias)
      if (!r.success) throw new Error((r as { error?: string }).error ?? 'create failed')
      setNewAlias({ driverId: '', aliasName: '' })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }
  const remove = async (id: string) => {
    if (!confirm('別名を削除しますか?')) return
    try {
      await steelo.driverAliases.delete(id)
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  const filtered = filter ? aliases.filter((a) => a.driverId === filter) : aliases

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">ドライバー別名マスタ</h1>
      <p className="mb-4 text-sm text-gray-600">
        BOND's Excel の DR 名表記ゆれ（旧姓・空白・カナ違い等）を吸収するためのマスタです。
        Excel 取込時に <code>drivers.name</code> 完全一致で解決できなかった行の DR 名と
        ドライバーの紐付けをここで登録します。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}

      <div className="mb-4 flex items-end gap-2 rounded border bg-gray-50 p-3">
        <div className="flex-1">
          <label className="block text-xs font-semibold text-gray-600">ドライバー</label>
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={newAlias.driverId}
            onChange={(e) => setNewAlias({ ...newAlias, driverId: e.target.value })}
          >
            <option value="">選択…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-semibold text-gray-600">別名（DR 名）</label>
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={newAlias.aliasName}
            onChange={(e) => setNewAlias({ ...newAlias, aliasName: e.target.value })}
            placeholder="例: タナカ"
          />
        </div>
        <button
          onClick={add}
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          追加
        </button>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <label className="text-sm">ドライバーで絞り込み:</label>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">全て</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {loading && <div className="text-gray-500">読み込み中…</div>}
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">別名</th>
              <th className="px-3 py-2 text-left">ドライバー</th>
              <th className="px-3 py-2 text-left">作成日時</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="px-3 py-2 font-medium">{a.aliasName}</td>
                <td className="px-3 py-2">{driverName(a.driverId)}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{a.createdAt}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(a.id)}
                    className="text-red-600 hover:underline"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-gray-500">
                  別名が登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
