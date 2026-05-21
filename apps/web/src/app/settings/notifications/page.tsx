'use client'

import { useEffect, useState } from 'react'
import { steelo } from '@/lib/api'

const ALL_EVENTS = [
  {
    key: 'reconciliation_completed',
    label: '照合完了通知',
    desc: '月次照合ジョブが完了したら、件数 + 異常件数を LINE に通知',
  },
  {
    key: 'monthly_reminder',
    label: '月初リマインド',
    desc: '毎月 1 日 9:00 JST、前月の元請け Excel が未取込なら通知',
  },
  {
    key: 'llm_parse_failed_streak',
    label: 'LLM 連続失敗',
    desc: '直近 24h で LLM 解析が 5 件以上連続失敗したら通知 (API key 失効等)',
  },
]

interface Settings {
  settings: {
    id: 1
    lineTargetId: string | null
    lineTargetIdMasked: string | null
    lineTargetKind: 'user' | 'group' | 'room' | null
    enabledEvents: string[]
    lastTestAt: string | null
    lastError: string | null
    updatedAt: string
  }
  recentDeliveries: Array<{
    id: string
    eventType: string
    status: string
    attemptCount: number
    requestedAt: string
    sentAt: string | null
    lastError: string | null
  }>
}

export default function NotificationSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draftTargetId, setDraftTargetId] = useState('')
  const [draftEvents, setDraftEvents] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    setInfo('')
    try {
      const r = await steelo.notificationSettings.get()
      if (r.success) {
        setSettings(r.data)
        setDraftEvents(r.data.settings.enabledEvents)
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
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    setInfo('')
    try {
      const body: { lineTargetId?: string | null; enabledEvents?: string[] } = {
        enabledEvents: draftEvents,
      }
      if (draftTargetId !== '') {
        body.lineTargetId = draftTargetId
      }
      const r = await steelo.notificationSettings.update(body)
      if (!r.success) {
        const err = r as { error?: string }
        setError(err.error ?? '保存に失敗しました')
        return
      }
      setDraftTargetId('')
      setInfo('保存しました。テスト通知が 1 分以内に LINE に届きます。')
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setError('')
    setInfo('')
    try {
      const r = await steelo.notificationSettings.sendTest()
      if (!r.success) {
        const err = r as { error?: string }
        setError(err.error ?? 'テスト送信に失敗しました')
        return
      }
      setInfo(r.data.note)
    } catch (e) {
      setError(String(e))
    } finally {
      setTesting(false)
    }
  }

  const toggleEvent = (key: string) => {
    setDraftEvents((prev) =>
      prev.includes(key) ? prev.filter((e) => e !== key) : [...prev, key],
    )
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">LINE 通知設定 (F9)</h1>
      <p className="mb-4 text-sm text-gray-600">
        Phase 1 の LINE_CHANNEL_ACCESS_TOKEN を流用し、push_message で管理者に
        重要イベントを通知します。
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</div>}
      {info && <div className="mb-4 rounded bg-green-50 p-3 text-green-800">{info}</div>}
      {loading && <div className="text-gray-500">読み込み中…</div>}

      {settings && (
        <>
          <section className="mb-6 rounded border bg-gray-50 p-4">
            <h2 className="mb-3 text-lg font-semibold">送信先 LINE ID</h2>
            <div className="mb-2 text-xs text-gray-600">
              現在: {settings.settings.lineTargetIdMasked ?? '(未設定)'}{' '}
              {settings.settings.lineTargetKind &&
                `(${settings.settings.lineTargetKind})`}
            </div>
            <label className="block text-sm font-semibold">新しい LINE ID</label>
            <input
              type="text"
              placeholder="U... / C... / R... (33 文字)"
              className="mt-1 w-full rounded border px-2 py-1 font-mono text-sm"
              value={draftTargetId}
              onChange={(e) => setDraftTargetId(e.target.value)}
            />
            <div className="mt-1 text-xs text-gray-500">
              U で始まる = ユーザー / C = グループ / R = ルーム。
              空欄のまま保存すると現在の設定を維持。null で無効化したい場合は
              空文字を明示送信してください。
            </div>
          </section>

          <section className="mb-6 rounded border bg-gray-50 p-4">
            <h2 className="mb-3 text-lg font-semibold">通知イベント</h2>
            <div className="space-y-2">
              {ALL_EVENTS.map((e) => (
                <label key={e.key} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={draftEvents.includes(e.key)}
                    onChange={() => toggleEvent(e.key)}
                  />
                  <div>
                    <div className="font-semibold">{e.label}</div>
                    <div className="text-xs text-gray-600">{e.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <div className="mb-6 flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {/* Codex full review HIGH #8 反映:
                  API は安全のため lineTargetId 本体を返さないため、
                  lineTargetIdMasked で「設定済みかどうか」を判定する。 */}
            <button
              onClick={sendTest}
              disabled={testing || !settings.settings.lineTargetIdMasked}
              className="rounded border border-blue-600 px-4 py-2 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
              title={
                !settings.settings.lineTargetIdMasked
                  ? '先に LINE ID を保存してください'
                  : ''
              }
            >
              {testing ? '送信中…' : 'テスト送信'}
            </button>
            {/* Codex full review HIGH #8 反映: 明示的な無効化ボタン */}
            {settings.settings.lineTargetIdMasked && (
              <button
                onClick={async () => {
                  if (!confirm('LINE 通知を無効化しますか？(target_id をクリア)')) return
                  setSaving(true)
                  try {
                    await steelo.notificationSettings.update({
                      lineTargetId: null,
                      enabledEvents: draftEvents,
                    })
                    setInfo('LINE 通知を無効化しました')
                    await load()
                  } catch (e) {
                    setError(String(e))
                  } finally {
                    setSaving(false)
                  }
                }}
                disabled={saving}
                className="rounded border border-red-300 px-4 py-2 text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                通知無効化
              </button>
            )}
          </div>

          {settings.settings.lastError && (
            <div className="mb-4 rounded bg-orange-50 p-3 text-sm text-orange-800">
              <div className="font-semibold">直近のエラー:</div>
              <div className="font-mono">{settings.settings.lastError}</div>
            </div>
          )}

          <h2 className="mb-3 text-lg font-semibold">直近の通知履歴</h2>
          <div className="overflow-x-auto rounded border">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">event</th>
                  <th className="px-3 py-2 text-center">status</th>
                  <th className="px-3 py-2 text-right">attempts</th>
                  <th className="px-3 py-2 text-left">requested</th>
                  <th className="px-3 py-2 text-left">sent</th>
                  <th className="px-3 py-2 text-left">error</th>
                </tr>
              </thead>
              <tbody>
                {settings.recentDeliveries.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{d.eventType}</td>
                    <td className="px-3 py-2 text-center">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-3 py-2 text-right">{d.attemptCount}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {d.requestedAt.slice(0, 19)}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {d.sentAt?.slice(0, 19) ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-orange-700">
                      {d.lastError ?? '—'}
                    </td>
                  </tr>
                ))}
                {settings.recentDeliveries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      まだ通知履歴がありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    processing: 'bg-blue-100 text-blue-800',
    sent: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    skipped: 'bg-gray-100 text-gray-700',
  }
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${map[status] ?? 'bg-gray-100'}`}>
      {status}
    </span>
  )
}
