'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'

function defaultPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

type ReportType = 'reconciliation' | 'client_summary' | 'payment_summary'

const REPORT_TYPES: Array<{
  key: ReportType
  label: string
  priority: 'P0' | 'P1' | 'P2'
  desc: string
}> = [
  {
    key: 'reconciliation',
    label: '照合結果レポート',
    priority: 'P0',
    desc: '月次照合の matched / client_only / dispatch_only + 異常 warning 一覧 (A4 縦、Noto Sans JP)',
  },
  {
    key: 'client_summary',
    label: '元請けサマリー',
    priority: 'P1',
    desc: '取込済み client_records の合計売上、件数、ドライバー別小計 (Phase 3 では未実装)',
  },
  {
    key: 'payment_summary',
    label: '支払明細サマリー',
    priority: 'P2',
    desc: '月次支払明細の総額、ドライバー別小計、控除内訳 (Phase 4 で再評価)',
  },
]

interface JobItem {
  id: string
  period: string
  reportType: string
  status: string
  byteSize: number | null
  pageCount: number | null
  requestedAt: string
  completedAt: string | null
}

export default function ReportsPage() {
  const [period, setPeriod] = useState(defaultPeriod())
  const [items, setItems] = useState<JobItem[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await steelo.reports.list({ period })
      if (r.success) {
        setItems(r.data.items)
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
  }, [period])

  const generate = async (reportType: ReportType) => {
    setGenerating(true)
    setError('')
    try {
      const r = await steelo.reports.enqueueJob({ period, reportType })
      if (!r.success) {
        const err = r as { error?: string }
        setError(err.error ?? '生成に失敗しました')
        return
      }
      const done = await steelo.reports.pollJob(r.data.jobId)
      if (done.status === 'failed') {
        setError(`生成失敗: ${done.errorMessage ?? '不明なエラー'}`)
      }
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  const download = async (jobId: string) => {
    try {
      const { blobUrl, filename } = await steelo.reports.download(jobId)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      a.click()
      // Cleanup
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">月次レポート出力 (F10)</h1>
      <p className="mb-4 text-sm text-gray-600">
        対象月の各種レポートを PDF で生成します。元請けへの月次報告や経理用の
        サマリーに使えます。Bearer 認証付き Worker proxy 経由でダウンロードします。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}

      <div className="mb-6 rounded border bg-gray-50 p-4">
        <label className="text-sm font-semibold">対象月</label>
        <input
          type="month"
          className="ml-3 rounded border px-2 py-1"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
      </div>

      <h2 className="mb-3 text-lg font-semibold">生成</h2>
      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
        {REPORT_TYPES.map((t) => (
          <div key={t.key} className="rounded border bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-bold ${
                  t.priority === 'P0'
                    ? 'bg-blue-100 text-blue-800'
                    : t.priority === 'P1'
                    ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {t.priority}
              </span>
              <span className="font-semibold">{t.label}</span>
            </div>
            <p className="mb-3 text-xs text-gray-600">{t.desc}</p>
            <button
              onClick={() => generate(t.key)}
              disabled={generating || t.priority !== 'P0'}
              className="w-full rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              title={t.priority !== 'P0' ? `${t.priority} は Phase 3 では未実装` : ''}
            >
              {generating ? '生成中…' : t.priority !== 'P0' ? '未実装' : '生成'}
            </button>
          </div>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-semibold">生成履歴 ({period})</h2>
      {loading && <div className="text-gray-500">読み込み中…</div>}
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">type</th>
              <th className="px-3 py-2 text-center">status</th>
              <th className="px-3 py-2 text-right">size</th>
              <th className="px-3 py-2 text-right">pages</th>
              <th className="px-3 py-2 text-left">requested</th>
              <th className="px-3 py-2 text-left">completed</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((j) => (
              <tr key={j.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{j.reportType}</td>
                <td className="px-3 py-2 text-center">
                  <StatusBadge status={j.status} />
                </td>
                <td className="px-3 py-2 text-right text-xs">
                  {j.byteSize ? `${(j.byteSize / 1024).toFixed(1)} KB` : '—'}
                </td>
                <td className="px-3 py-2 text-right text-xs">{j.pageCount ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {j.requestedAt.slice(0, 19)}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {j.completedAt?.slice(0, 19) ?? '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {j.status === 'completed' && (
                    <button
                      onClick={() => download(j.id)}
                      className="rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                    >
                      ダウンロード
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  この月のレポートはまだ生成されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: 'bg-gray-100 text-gray-700',
    running: 'bg-yellow-100 text-yellow-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
  }
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${map[status] ?? 'bg-gray-100'}`}>
      {status}
    </span>
  )
}
