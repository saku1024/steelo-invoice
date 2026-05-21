'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'

export default function LlmStatsPage() {
  const [stats, setStats] = useState<{
    total: number
    success: number
    failed: number
    successRate: number
    tokenInputSum: number
    tokenOutputSum: number
    costUsdSum: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState({ from: '', to: '' })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await steelo.llmParse.stats({
        from: filter.from || undefined,
        to: filter.to || undefined,
      })
      if (r.success) setStats(r.data)
      else setError('読み込みに失敗しました')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [filter])

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">LLM 解析統計 (F2)</h1>
      <p className="mb-4 text-sm text-gray-600">
        Claude Haiku で LINE メッセージを解析した実績。token 使用量とコストを
        モニタリングします（月 ¥500-1,500 目標）。
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 rounded border bg-gray-50 p-3 md:grid-cols-4">
        <div>
          <label className="block text-xs font-semibold text-gray-600">期間 開始</label>
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600">期間 終了</label>
          <input
            type="date"
            className="mt-1 w-full rounded border px-2 py-1"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="解析総数" value={stats.total.toLocaleString()} />
          <Stat
            label="成功率"
            value={`${(stats.successRate * 100).toFixed(1)}%`}
            sub={`${stats.success} 成功 / ${stats.failed} 失敗`}
          />
          <Stat
            label="入力 tokens"
            value={stats.tokenInputSum.toLocaleString()}
          />
          <Stat
            label="出力 tokens"
            value={stats.tokenOutputSum.toLocaleString()}
          />
          <Stat
            label="費用 (USD)"
            value={`$${stats.costUsdSum.toFixed(4)}`}
            sub={`概算 ¥${Math.round(stats.costUsdSum * 150).toLocaleString()}`}
          />
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border bg-white p-4 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}
