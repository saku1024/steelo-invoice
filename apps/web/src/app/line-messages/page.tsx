'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver, LineMessage } from '@line-crm/shared'

const TYPES = ['', 'text', 'image', 'file', 'video', 'audio', 'sticker'] as const

export default function LineMessagesPage() {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [messages, setMessages] = useState<LineMessage[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState({
    driverId: '',
    from: '',
    to: '',
    messageType: '',
  })
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<LineMessage | null>(null)
  const LIMIT = 50

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      if (drivers.length === 0) {
        const dr = await steelo.drivers.list(false)
        if (dr.success) setDrivers(dr.data)
      }
      const r = await steelo.lineMessages.list({
        driverId: filter.driverId || undefined,
        from: filter.from || undefined,
        to: filter.to || undefined,
        messageType: filter.messageType || undefined,
        limit: LIMIT,
        offset,
      })
      if (r.success) {
        setMessages(r.data.items)
        setTotal(r.data.total)
      } else {
        setError('読み込みに失敗しました')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [filter, offset])

  const driverName = (id: string | null) =>
    id ? drivers.find((d) => d.id === id)?.name ?? id.slice(0, 8) : '—'

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">LINE メッセージ閲覧</h1>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded border bg-gray-50 p-3 md:grid-cols-4">
        <div>
          <label className="block text-xs font-semibold text-gray-600">ドライバー</label>
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.driverId}
            onChange={(e) => {
              setFilter({ ...filter, driverId: e.target.value })
              setOffset(0)
            }}
          >
            <option value="">全て</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">期間 開始</label>
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.from}
            onChange={(e) => {
              setFilter({ ...filter, from: e.target.value })
              setOffset(0)
            }}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">期間 終了</label>
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.to}
            onChange={(e) => {
              setFilter({ ...filter, to: e.target.value })
              setOffset(0)
            }}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">type</label>
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.messageType}
            onChange={(e) => {
              setFilter({ ...filter, messageType: e.target.value })
              setOffset(0)
            }}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t === '' ? '全て' : t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      <div className="mb-3 text-sm text-gray-600">合計 {total} 件</div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">受信日時</th>
              <th className="px-3 py-2 text-left">ドライバー</th>
              <th className="px-3 py-2 text-left">送信者</th>
              <th className="px-3 py-2 text-left">type</th>
              <th className="px-3 py-2 text-left">本文（先頭 100 字）</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr
                key={m.id}
                className="cursor-pointer border-t hover:bg-blue-50"
                onClick={() => setSelected(m)}
              >
                <td className="px-3 py-2 text-xs text-gray-500">{m.receivedAt}</td>
                <td className="px-3 py-2">{driverName(m.driverId)}</td>
                <td className="px-3 py-2">{m.senderName ?? m.senderUserId?.slice(0, 8) ?? '—'}</td>
                <td className="px-3 py-2">{m.messageType}</td>
                <td className="px-3 py-2 text-gray-700">
                  {(m.messageText ?? '').slice(0, 100)}
                </td>
              </tr>
            ))}
            {!loading && messages.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                  メッセージが見つかりません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          className="rounded border px-3 py-1 text-sm disabled:bg-gray-100"
        >
          ← 前へ
        </button>
        <div className="text-xs text-gray-500">
          {offset + 1}〜{Math.min(offset + LIMIT, total)} / {total}
        </div>
        <button
          disabled={offset + LIMIT >= total}
          onClick={() => setOffset(offset + LIMIT)}
          className="rounded border px-3 py-1 text-sm disabled:bg-gray-100"
        >
          次へ →
        </button>
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setSelected(null)}
        >
          <div
            className="max-w-2xl rounded bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-xs text-gray-500">{selected.receivedAt}</div>
            <div className="mb-2 text-sm">
              {driverName(selected.driverId)} ／ {selected.senderName ?? '—'} ／ {selected.messageType}
            </div>
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded border bg-gray-50 p-3 text-sm">
              {selected.messageText ?? '(本文なし)'}
            </pre>
            <div className="mt-4 text-right">
              <button
                onClick={() => setSelected(null)}
                className="rounded border px-4 py-2"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
