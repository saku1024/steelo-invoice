'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { AuditLog } from '@line-crm/shared'

const ACTIONS: Array<{ value: AuditLog['action'] | ''; label: string }> = [
  { value: '', label: '全て' },
  { value: 'driver_create', label: 'ドライバー作成' },
  { value: 'driver_update', label: 'ドライバー更新' },
  { value: 'driver_archive', label: 'ドライバー論理削除' },
  { value: 'driver_alias_create', label: '別名作成' },
  { value: 'driver_alias_delete', label: '別名削除' },
  { value: 'deduction_update', label: '控除更新' },
  { value: 'import_confirm', label: 'インポート確定' },
  { value: 'import_overwrite', label: 'インポート上書き' },
  { value: 'payment_generate', label: '支払明細生成' },
  { value: 'payment_job_request', label: 'ジョブ投入' },
  { value: 'payment_batch_generate', label: 'ジョブ完了' },
  { value: 'webhook_save_failed', label: 'Webhook 保存失敗' },
]

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState({
    action: '' as AuditLog['action'] | '',
    actor: '',
    resourceType: '',
    from: '',
    to: '',
  })
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const LIMIT = 100

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await steelo.auditLogs.list({
        action: filter.action || undefined,
        actor: filter.actor || undefined,
        resourceType: filter.resourceType || undefined,
        from: filter.from || undefined,
        to: filter.to || undefined,
        limit: LIMIT,
        offset,
      })
      if (r.success) {
        setLogs(r.data.items)
        setTotal(r.data.total)
      } else {
        const err = r as { error?: string }
        setError(err.error ?? '読み込みに失敗しました')
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

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">監査ログ</h1>
      <p className="mb-4 text-sm text-gray-600">
        STEELO 系の重要操作（インポート確定／上書き、支払明細生成、マスタ・控除変更等）の
        履歴です。閲覧には admin/owner ロールが必要です。
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded border bg-gray-50 p-3 md:grid-cols-5">
        <div>
          <label className="block text-xs font-semibold text-gray-600">アクション</label>
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.action}
            onChange={(e) => {
              setFilter({ ...filter, action: e.target.value as AuditLog['action'] | '' })
              setOffset(0)
            }}
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">actor</label>
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.actor}
            onChange={(e) => {
              setFilter({ ...filter, actor: e.target.value })
              setOffset(0)
            }}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">resource type</label>
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.resourceType}
            onChange={(e) => {
              setFilter({ ...filter, resourceType: e.target.value })
              setOffset(0)
            }}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">from</label>
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
          <label className="block text-xs font-semibold text-gray-600">to</label>
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
      </div>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}
      <div className="mb-3 text-sm text-gray-600">合計 {total} 件</div>

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">日時</th>
              <th className="px-3 py-2 text-left">actor</th>
              <th className="px-3 py-2 text-left">action</th>
              <th className="px-3 py-2 text-left">resource</th>
              <th className="px-3 py-2 text-left">IP</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <>
                <tr key={l.id} className="border-t">
                  <td className="px-3 py-2 text-xs text-gray-500">{l.createdAt}</td>
                  <td className="px-3 py-2">{l.actorName}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.action}</td>
                  <td className="px-3 py-2 text-gray-700">
                    {l.resourceType} / {l.resourceId.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{l.ip ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {l.payloadJson && (
                      <button
                        onClick={() =>
                          setExpanded(expanded === l.id ? null : l.id)
                        }
                        className="text-blue-600 hover:underline"
                      >
                        {expanded === l.id ? '閉じる' : '詳細'}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded === l.id && l.payloadJson && (
                  <tr key={l.id + '-payload'} className="border-t bg-gray-50">
                    <td colSpan={6} className="px-3 py-2">
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">
                        {JSON.stringify(JSON.parse(l.payloadJson), null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                  該当ログがありません
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
    </div>
  )
}
