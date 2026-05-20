'use client'

import { useEffect, useState } from 'react'
import { steelo, type PreviewResponse } from '@/lib/api'
import type { Driver, ImportBatch } from '@line-crm/shared'

export default function ExcelImportsPage() {
  const [batches, setBatches] = useState<ImportBatch[]>([])
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [uploading, setUploading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<{ existingId: string } | null>(null)
  const [aliasModal, setAliasModal] = useState<string | null>(null) // unmatched DR name

  const loadBatches = async () => {
    try {
      const r = await steelo.excelImports.listBatches()
      if (r.success) setBatches(r.data)
    } catch (e) {
      setError(String(e))
    }
  }

  const loadDrivers = async () => {
    const r = await steelo.drivers.list(true)
    if (r.success) setDrivers(r.data)
  }

  useEffect(() => {
    loadBatches()
    loadDrivers()
  }, [])

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setUploading(true)
    setError('')
    setPreview(null)
    setConflict(null)
    try {
      const r = await steelo.excelImports.preview(f)
      if (!r.success) {
        const err = r as { error?: string; code?: string }
        setError(`${err.code ?? 'ERROR'}: ${err.error ?? ''}`)
        return
      }
      setPreview(r.data)
    } catch (err) {
      setError(String(err))
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const confirm = async (overwrite = false) => {
    if (!preview) return
    setConfirming(true)
    setError('')
    try {
      const r = await steelo.excelImports.confirm({
        previewId: preview.previewId,
        overwrite,
      })
      if (!r.success) {
        const err = r as { error?: string; existingId?: string }
        if (err.existingId) {
          setConflict({ existingId: err.existingId })
        } else {
          setError(err.error ?? '確定に失敗しました')
        }
        return
      }
      setPreview(null)
      setConflict(null)
      await loadBatches()
    } catch (e) {
      setError(String(e))
    } finally {
      setConfirming(false)
    }
  }

  const addAlias = async (aliasName: string, driverId: string) => {
    try {
      await steelo.driverAliases.create({ driverId, aliasName })
      setAliasModal(null)
      // 同じファイルを再 upload するよう促す: ここでは preview を破棄
      setPreview(null)
      alert('別名を登録しました。再度同じ Excel をアップロードしてください。')
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">Excel インポート（F3）</h1>
      <p className="mb-4 text-sm text-gray-600">
        BOND's の月次支払明細 Excel をアップロードしてプレビュー → 確定で取り込みます。
        確定するまで本番テーブルには書き込まれません。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}

      <div className="mb-6 rounded border bg-gray-50 p-4">
        <label className="block text-sm font-semibold">Excel ファイル（.xlsx）</label>
        <input
          type="file"
          accept=".xlsx"
          onChange={onUpload}
          disabled={uploading}
          className="mt-2"
        />
        {uploading && <div className="mt-2 text-sm text-gray-600">解析中…</div>}
        <p className="mt-2 text-xs text-gray-500">
          上限: 10 MB / シート 5 / 行 5,000 / セル 50,000。数式・外部リンクは拒否されます。
        </p>
      </div>

      {preview && (
        <div className="mb-6 rounded border bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">プレビュー</h2>
          <dl className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <Item label="対象月">{preview.summary.period}</Item>
            <Item label="取込件数">{preview.summary.rowCount}</Item>
            <Item label="運賃合計">{preview.summary.totalFare.toLocaleString()} 円</Item>
            <Item label="立替合計">{preview.summary.totalAdvance.toLocaleString()} 円</Item>
            <Item label="車両代（会社合計）">
              {preview.summary.headerVehicleCost.toLocaleString()} 円
            </Item>
            <Item label="電算処理費（会社合計）">
              {preview.summary.headerProcessingFee.toLocaleString()} 円
            </Item>
            <Item label="前払金（会社合計）">
              {preview.summary.headerPrepayment.toLocaleString()} 円
            </Item>
            <Item label="手数料率 / 税率">
              {(preview.summary.commissionRate * 100).toFixed(1)}% / {(preview.summary.taxRate * 100).toFixed(1)}%
            </Item>
          </dl>

          {preview.summary.warnings.length > 0 && (
            <div className="mb-3 rounded bg-yellow-50 p-3 text-sm">
              <div className="font-semibold">警告</div>
              <ul className="ml-4 list-disc">
                {preview.summary.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.unmatchedDrivers.length > 0 && (
            <div className="mb-3 rounded bg-orange-50 p-3 text-sm">
              <div className="mb-2 font-semibold">
                未紐付け DR 名: {preview.unmatchedDrivers.length} 件
              </div>
              <ul className="space-y-1">
                {preview.unmatchedDrivers.map((u) => (
                  <li key={u.name} className="flex items-center justify-between">
                    <span>
                      <strong>{u.name}</strong>（{u.count} 行）
                    </span>
                    <button
                      onClick={() => setAliasModal(u.name)}
                      className="rounded border bg-white px-2 py-0.5 text-xs hover:bg-gray-50"
                    >
                      別名として登録
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-gray-600">
                ※別名登録後、再度 Excel をアップロードしてください。
              </div>
            </div>
          )}

          <details className="mb-4">
            <summary className="cursor-pointer text-sm font-semibold">
              明細プレビュー（{preview.rows.length} 行）
            </summary>
            <div className="mt-2 max-h-72 overflow-y-auto rounded border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left">日</th>
                    <th className="px-2 py-1 text-left">業務名</th>
                    <th className="px-2 py-1 text-left">DR 名</th>
                    <th className="px-2 py-1 text-right">運賃</th>
                    <th className="px-2 py-1 text-right">立替</th>
                    <th className="px-2 py-1 text-center">紐付け</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">{r.workDay}</td>
                      <td className="px-2 py-1">{r.taskName ?? '—'}</td>
                      <td className="px-2 py-1">{r.driverName ?? '—'}</td>
                      <td className="px-2 py-1 text-right">
                        {r.fare === null ? '—' : r.fare.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {r.advancePayment.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {r.driverId ? '✓' : <span className="text-orange-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.rows.length > 200 && (
                <div className="border-t px-2 py-1 text-center text-xs text-gray-500">
                  …他 {preview.rows.length - 200} 行
                </div>
              )}
            </div>
          </details>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPreview(null)}
              className="rounded border px-4 py-2"
            >
              キャンセル
            </button>
            <button
              onClick={() => confirm(false)}
              disabled={confirming}
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              {confirming ? '確定中…' : '確定'}
            </button>
          </div>
        </div>
      )}

      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="max-w-md rounded bg-white p-6 shadow-lg">
            <h2 className="mb-3 text-lg font-semibold">既存の確定バッチが存在します</h2>
            <p className="mb-4 text-sm text-gray-700">
              この対象月には既に <code>confirmed</code> バッチがあります（{conflict.existingId.slice(0, 8)}…）。
              上書きすると既存バッチは <code>archived</code> になります。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConflict(null)}
                className="rounded border px-4 py-2"
              >
                キャンセル
              </button>
              <button
                onClick={() => confirm(true)}
                className="rounded bg-orange-600 px-4 py-2 text-white hover:bg-orange-700"
              >
                上書きして確定
              </button>
            </div>
          </div>
        </div>
      )}

      {aliasModal && (
        <AliasAddModal
          aliasName={aliasModal}
          drivers={drivers}
          onCancel={() => setAliasModal(null)}
          onSave={addAlias}
        />
      )}

      <h2 className="mb-3 text-lg font-semibold">取込履歴</h2>
      <div className="overflow-x-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left">対象月</th>
              <th className="px-3 py-2 text-left">ファイル名</th>
              <th className="px-3 py-2 text-left">ステータス</th>
              <th className="px-3 py-2 text-right">件数</th>
              <th className="px-3 py-2 text-left">取込日時</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-t">
                <td className="px-3 py-2 font-medium">{b.period}</td>
                <td className="px-3 py-2 text-gray-600">{b.fileName ?? '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      b.status === 'confirmed'
                        ? 'bg-green-100 text-green-800'
                        : b.status === 'archived'
                        ? 'bg-gray-100 text-gray-600'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {b.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{b.totalRecords}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{b.importedAt}</td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                  取込履歴がありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded bg-gray-50 p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="font-semibold">{children}</div>
    </div>
  )
}

function AliasAddModal({
  aliasName,
  drivers,
  onCancel,
  onSave,
}: {
  aliasName: string
  drivers: Driver[]
  onCancel: () => void
  onSave: (aliasName: string, driverId: string) => void | Promise<void>
}) {
  const [driverId, setDriverId] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="max-w-md rounded bg-white p-6 shadow-lg">
        <h2 className="mb-3 text-lg font-semibold">別名を登録</h2>
        <p className="mb-3 text-sm text-gray-700">
          <strong>{aliasName}</strong> を既存ドライバーの別名として登録します。
        </p>
        <select
          className="mb-4 w-full rounded border px-2 py-1"
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
        >
          <option value="">ドライバーを選択…</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border px-4 py-2">
            キャンセル
          </button>
          <button
            disabled={!driverId}
            onClick={() => onSave(aliasName, driverId)}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            登録
          </button>
        </div>
      </div>
    </div>
  )
}
