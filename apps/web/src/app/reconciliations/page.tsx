'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type {
  Reconciliation,
  ReconciliationJob,
  MatchStatus,
} from '@line-crm/shared'

function defaultPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const TABS: Array<{ key: MatchStatus; label: string }> = [
  { key: 'matched', label: 'マッチ済み' },
  { key: 'client_only', label: '元請けのみ' },
  { key: 'dispatch_only', label: 'LINEのみ' },
]

export default function ReconciliationsPage() {
  const [period, setPeriod] = useState(defaultPeriod())
  const [tab, setTab] = useState<MatchStatus>('matched')
  const [items, setItems] = useState<Reconciliation[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<MatchStatus, number>>({
    matched: 0,
    client_only: 0,
    dispatch_only: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [job, setJob] = useState<ReconciliationJob | null>(null)
  const [jobRunning, setJobRunning] = useState(false)
  const [offset, setOffset] = useState(0)
  const [manualMatchTarget, setManualMatchTarget] = useState<Reconciliation | null>(null)
  const LIMIT = 100

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await steelo.reconciliations.list({
        period,
        matchStatus: tab,
        limit: LIMIT,
        offset,
      })
      if (r.success) {
        setItems(r.data.items)
        setTotal(r.data.total)
      } else {
        setError('読み込みに失敗しました')
      }
      // タブの件数を 3 並列で取得
      const all = await Promise.all(
        TABS.map((t) =>
          steelo.reconciliations.list({
            period,
            matchStatus: t.key,
            limit: 1,
          }),
        ),
      )
      const next: Record<MatchStatus, number> = { matched: 0, client_only: 0, dispatch_only: 0 }
      TABS.forEach((t, i) => {
        const r = all[i]
        if (r.success) next[t.key] = r.data.total
      })
      setCounts(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [period, tab, offset])

  useEffect(() => {
    setOffset(0)
  }, [period, tab])

  const startJob = async () => {
    setJobRunning(true)
    setError('')
    try {
      const r = await steelo.reconciliations.enqueueJob(period)
      if (!r.success) {
        const err = r as { error?: string }
        setError(err.error ?? '照合ジョブの投入に失敗しました')
        return
      }
      const result = await steelo.reconciliations.pollJob(r.data.jobId, {
        intervalMs: 3000,
        timeoutMs: 5 * 60_000,
      })
      setJob(result)
      if (result.status === 'completed') {
        await load()
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setJobRunning(false)
    }
  }

  const review = async (id: string, reviewed: boolean) => {
    try {
      await steelo.reconciliations.review(id, { reviewed })
      await load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">稼働照合 (F4)</h1>
      <p className="mb-4 text-sm text-gray-600">
        LINE 配車レコード (dispatch_records) と元請け Excel (client_records) を
        自動マッチングし、計上漏れ・差分を検出します。Phase 2 の中核機能。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}

      <div className="mb-6 rounded border bg-gray-50 p-4">
        <div className="flex items-center gap-3">
          <label className="text-sm font-semibold">対象月</label>
          <input
            type="month"
            className="rounded border px-2 py-1"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
          <button
            onClick={startJob}
            disabled={jobRunning}
            className="ml-auto rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {jobRunning ? '照合実行中…' : '照合実行'}
          </button>
        </div>
        {job && (
          <div className="mt-3 rounded border bg-white p-3 text-sm">
            <div className="font-semibold">
              ジョブ {job.id.slice(0, 8)}… ：{job.status}（{job.progress}%）
            </div>
            {job.status === 'completed' && (
              <div className="mt-1 text-gray-700">
                dispatch {job.dispatchCount} / client {job.clientCount} →
                {' '}matched {job.matchedCount} / client_only {job.clientOnlyCount} /
                dispatch_only {job.dispatchOnlyCount}
              </div>
            )}
            {job.status === 'failed' && (
              <div className="mt-1 text-red-700">エラー: {job.errorMessage}</div>
            )}
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
              tab === t.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            {t.label}{' '}
            <span className="ml-2 inline-block rounded bg-gray-200 px-2 py-0.5 text-xs">
              {counts[t.key]}
            </span>
          </button>
        ))}
      </div>

      {loading && <div className="text-gray-500">読み込み中…</div>}
      <div className="mb-3 text-sm text-gray-600">合計 {total} 件</div>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">match</th>
              <th className="px-3 py-2 text-right">score</th>
              <th className="px-3 py-2 text-left">method</th>
              <th className="px-3 py-2 text-left">dispatch</th>
              <th className="px-3 py-2 text-left">client_record</th>
              <th className="px-3 py-2 text-left">warnings</th>
              <th className="px-3 py-2 text-center">reviewed</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2">
                  <MatchBadge status={r.matchStatus} />
                </td>
                <td className="px-3 py-2 text-right">{r.matchScore.toFixed(2)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.matchMethod}</td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {r.dispatchId ? r.dispatchId.slice(0, 8) + '…' : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {r.clientRecordId ? r.clientRecordId.slice(0, 8) + '…' : '—'}
                </td>
                <td className="px-3 py-2">
                  <WarningsCell warnings={r.warnings} />
                </td>
                <td className="px-3 py-2 text-center">
                  {r.reviewed ? (
                    <span className="text-green-700">✓</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.matchStatus !== 'matched' && (
                    <button
                      onClick={() => setManualMatchTarget(r)}
                      className="mr-2 rounded border bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100"
                    >
                      手動マッチ
                    </button>
                  )}
                  <button
                    onClick={() => review(r.id, !r.reviewed)}
                    className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                  >
                    {r.reviewed ? '未確認に戻す' : '確認済み'}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  該当する照合行がありません。「照合実行」で初回計算してください。
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

      {manualMatchTarget && (
        <ManualMatchModal
          recon={manualMatchTarget}
          onCancel={() => setManualMatchTarget(null)}
          onSaved={async () => {
            setManualMatchTarget(null)
            await load()
          }}
          onError={(e) => setError(e)}
        />
      )}
    </div>
  )
}

function ManualMatchModal({
  recon,
  onCancel,
  onSaved,
  onError,
}: {
  recon: Reconciliation
  onCancel: () => void
  onSaved: () => void | Promise<void>
  onError: (e: string) => void
}) {
  // dispatch_only なら client_record の候補を探す（同 period 内）
  // client_only なら dispatch_records の候補を探す（同 period 内、未マッチ）
  // 簡易版: 同 period の全候補から手動選択
  const [candidateId, setCandidateId] = useState('')
  const [saving, setSaving] = useState(false)
  const targetKind = recon.matchStatus === 'dispatch_only' ? 'client' : 'dispatch'

  const save = async () => {
    if (!candidateId.trim()) {
      onError('候補 ID を入力してください')
      return
    }
    setSaving(true)
    try {
      await steelo.reconciliations.manualMatch(recon.id, {
        dispatchId: targetKind === 'dispatch' ? candidateId.trim() : undefined,
        clientRecordId: targetKind === 'client' ? candidateId.trim() : undefined,
      })
      await onSaved()
    } catch (e) {
      onError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded bg-white p-6 shadow-lg">
        <h2 className="mb-2 text-lg font-semibold">手動マッチング</h2>
        <p className="mb-3 text-sm text-gray-700">
          {recon.matchStatus === 'dispatch_only'
            ? 'この dispatch_record に紐付ける client_record の ID を入力してください'
            : 'この client_record に紐付ける dispatch_record の ID を入力してください'}
        </p>
        <p className="mb-2 text-xs text-gray-500">
          現在: {recon.matchStatus} / score {recon.matchScore.toFixed(2)}
        </p>
        <input
          type="text"
          className="mb-4 w-full rounded border px-2 py-1 font-mono text-sm"
          placeholder={`${targetKind}_record の UUID`}
          value={candidateId}
          onChange={(e) => setCandidateId(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border px-4 py-2">
            キャンセル
          </button>
          <button
            onClick={save}
            disabled={saving || !candidateId.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {saving ? 'マッチング中…' : 'マッチ作成'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MatchBadge({ status }: { status: MatchStatus }) {
  const colors: Record<MatchStatus, string> = {
    matched: 'bg-green-100 text-green-800',
    client_only: 'bg-orange-100 text-orange-800',
    dispatch_only: 'bg-blue-100 text-blue-800',
  }
  const labels: Record<MatchStatus, string> = {
    matched: 'matched',
    client_only: 'client_only',
    dispatch_only: 'dispatch_only',
  }
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${colors[status]}`}>
      {labels[status]}
    </span>
  )
}

// F8 Task 2.6: warnings の severity 別色分け + type バッジ表示
function WarningsCell({
  warnings,
}: {
  warnings: Reconciliation['warnings']
}) {
  if (warnings.length === 0) return <span className="text-xs text-gray-400">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {warnings.map((w, idx) => (
        <span
          key={idx}
          className={`inline-block rounded px-1.5 py-0.5 font-mono text-xs ${
            w.severity === 'warn'
              ? 'bg-orange-100 text-orange-800'
              : 'bg-yellow-50 text-yellow-700'
          }`}
          title={w.message}
        >
          {w.type}
        </span>
      ))}
    </div>
  )
}

