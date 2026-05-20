'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'
import type { Driver, DriverPaymentSummary, PaymentJob } from '@line-crm/shared'

function defaultPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function PaymentSummariesPage() {
  const [period, setPeriod] = useState(defaultPeriod())
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [summaries, setSummaries] = useState<DriverPaymentSummary[]>([])
  const [job, setJob] = useState<PaymentJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const [jobBusy, setJobBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      if (drivers.length === 0) {
        const dr = await steelo.drivers.list(true)
        if (dr.success) setDrivers(dr.data)
      }
      const r = await steelo.paymentSummaries.list(period)
      if (r.success) setSummaries(r.data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [period])

  const summaryByDriver = new Map(summaries.map((s) => [s.driverId, s]))

  const generateOne = async (driver: Driver) => {
    setGeneratingId(driver.id)
    setError('')
    try {
      await steelo.paymentSummaries.generateAndDownload(driver.id, period, driver.name)
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setGeneratingId(null)
    }
  }

  const downloadExisting = async (s: DriverPaymentSummary) => {
    try {
      await steelo.paymentSummaries.downloadById(s.id, s.driverNameSnapshot, s.period)
    } catch (e) {
      setError(String(e))
    }
  }

  const startBatchJob = async () => {
    setJobBusy(true)
    setError('')
    try {
      const r = await steelo.paymentJobs.enqueue(period)
      if (!r.success) {
        const err = r as { error?: string }
        setError(err.error ?? 'ジョブ投入に失敗しました')
        return
      }
      // poll
      const result = await steelo.paymentJobs.poll(r.data.jobId)
      setJob(result)
      if (result.status === 'completed') {
        await load()
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setJobBusy(false)
    }
  }

  const downloadZip = async () => {
    if (!job || job.status !== 'completed') return
    try {
      await steelo.paymentJobs.downloadZip(job.id, job.period)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">支払明細生成（F6）</h1>
      <p className="mb-4 text-sm text-gray-600">
        個別生成は同期で 2 秒以内、一括生成は非同期ジョブで R2 に保存後 ZIP DL します。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}

      <div className="mb-6 rounded border bg-gray-50 p-4">
        <div className="mb-3 flex items-center gap-3">
          <label className="text-sm font-semibold">対象月</label>
          <input
            type="month"
            className="rounded border px-2 py-1"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
          <button
            onClick={startBatchJob}
            disabled={jobBusy}
            className="ml-auto rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {jobBusy ? '実行中（ポーリング）…' : '一括生成（非同期ジョブ）'}
          </button>
        </div>
        {job && (
          <div className="rounded border bg-white p-3 text-sm">
            <div className="font-semibold">
              ジョブ {job.id.slice(0, 8)}… ：{job.status}（{job.progress}%、{job.doneDrivers}/
              {job.totalDrivers}）
            </div>
            {job.status === 'completed' && (
              <button
                onClick={downloadZip}
                className="mt-2 rounded bg-green-600 px-3 py-1 text-white hover:bg-green-700"
              >
                ZIP をダウンロード
              </button>
            )}
            {job.status === 'failed' && (
              <div className="mt-2 text-red-700">エラー: {job.errorMessage}</div>
            )}
          </div>
        )}
      </div>

      {loading && <div className="text-gray-500">読み込み中…</div>}

      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">ドライバー</th>
              <th className="px-3 py-2 text-center">インボイス</th>
              <th className="px-3 py-2 text-right">税込運賃合計</th>
              <th className="px-3 py-2 text-right">立替合計</th>
              <th className="px-3 py-2 text-right">控除計</th>
              <th className="px-3 py-2 text-right">支払額</th>
              <th className="px-3 py-2 text-left">生成日時</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => {
              const s = summaryByDriver.get(d.id)
              return (
                <tr key={d.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{d.name}</td>
                  <td className="px-3 py-2 text-center">
                    {d.hasInvoice ? '✓' : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s ? s.totalFareWithTax.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s ? s.totalAdvance.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {s
                      ? (s.vehicleCost + s.processingFee + s.prepayment).toLocaleString()
                      : '—'}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-semibold ${
                      s && s.finalAmount < 0 ? 'text-red-700' : ''
                    }`}
                  >
                    {s ? s.finalAmount.toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {s?.generatedAt ?? '未生成'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => generateOne(d)}
                      disabled={generatingId === d.id}
                      className="rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:bg-gray-200"
                    >
                      {generatingId === d.id ? '生成中…' : s ? '再生成' : '個別生成'}
                    </button>
                    {s?.r2XlsxKey && (
                      <button
                        onClick={() => downloadExisting(s)}
                        className="ml-2 rounded border px-2 py-1 text-xs hover:bg-gray-50"
                      >
                        再 DL
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {!loading && drivers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                  アクティブなドライバーが居ません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
