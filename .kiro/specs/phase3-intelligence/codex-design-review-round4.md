### サマリー

第 4 回最終確認の判定は **🟡 条件付き通過** です。Round 3 の残 3 件のうち、**F10 download** と **Slack latency Goal** は解消されていますが、**notification payload 表現が tasks/design interface まで完全には揃っていません**。

### Phase A 検証結果

| 観点 | 判定 | 確認結果 |
|---|---|---|
| 1. F10 download 図 | ✅ | F10 sequence は Bearer 必須 proxy download に統一済み。`createPresignedUrl` は [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:267) の図から消えています。 |
| 2. notification payload 表現 | ⚠️ | requirements Data Model、F9 sequence、migration SQL は `event_payload_json` + `payload_schema_ver` に揃っています。[requirements.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/requirements.md:324) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:231) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:499) ただし tasks は `schema_version` 表記が残り、[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:155) design の notifier interface も `SlackBlockMessage` を直接渡す形が残っています。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:401) |
| 3. Slack latency Goal | ✅ | Goals は `≤ 1 分`、F9 note も cron `*/1` による最大 1 分遅延で一致しています。[design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:18) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:263) |

### Phase B 新規指摘

1. **[HIGH] notification payload の service/interface 表現が最後まで統一されていない**  
   DB と sequence は `payload_schema_ver` ですが、tasks は `schema_version`、design の `sendSlackNotification()` は Block Kit 済み message を受ける形です。これだと「delivery row の event payload から送信時 render」の設計境界が実装時にぶれます。[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:159) [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:415)

2. **[LOW] Phase 3 acceptance への既存 docs 参照追加がタスク上は明示不足**  
   `phase3-acceptance.md` 作成と `deployment.md` 更新タスクはあります。[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:315) [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:321) ただし既存 `deployment.md` は Phase 1/2 acceptance だけをリンクしているため、Task 5.4 に Phase 3 acceptance link 追加を一言入れると漏れにくいです。[deployment.md](/home/user/steelo-invoice/docs/operations/deployment.md:7)

確認済みで blocker なし:
- `spec.json` の `approvals` は core 構造が Phase 1/2 と同じです。Phase 3 は `review_rounds` / `approval_basis` を追加しただけで、repo 内にそれを拒否する型定義は見つかりません。[spec.json](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/spec.json:7) [init.json](/home/user/steelo-invoice/.kiro/settings/templates/specs/init.json:7)
- migration 048 を物理ファイル化する Foundation タスクは含まれています。[tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:13)

### Phase C 実装 gate 判定

## 🟡 条件付き通過

直す箇所はこれです。  
1. [tasks.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/tasks.md:159) の `schema_version` を `payload_schema_ver` に統一する。  
2. [design.md](/home/user/steelo-invoice/.kiro/specs/phase3-intelligence/design.md:401) の notifier interface を `event_payload_json` + `payload_schema_ver` 起点の説明に直す。  
3. その後なら今回確認範囲では **CRITICAL 0 / cross-spec 矛盾解消で 🟢 通過** にできます。

### 次のタスクはこれ

notification payload の最後の表記ゆれを `tasks.md` と `design.md` の notifier interface から消して、再度 `rg "schema_version|payload_json|createPresignedUrl"` で残存確認することです。

### 今の進捗を全体像から整理するとこれ

- Round 3 残件 3 件のうち **2 件は解消**
- 残りは **notification payload の interface 表現 1 件**
- 新規 CRITICAL は **0**
- 現在地は **実装直前。最後の cross-spec 表記統一だけ未完** です。