# 人工审阅与知识有效性

用户要求核对或批准具体知识时使用。一般“帮我记录”只授权创建待审内容，不代表审阅通过。

## 读具体版本后取得操作预览

```sh
am knowledge get <entryId> --review all --availability all --json
am knowledge revision <entryId> <latestRevisionId> --json
am knowledge review <entryId> <latestRevisionId> approve --json
```

比较 publishedRevisionId（已通过）与 latestRevisionId（最新提交）的正文、条件和来源。第三条在没有授权参数时不会审批：非交互模式以 `CONFIRMATION_REQUIRED` 返回 stderr JSON，details 中含 method、path、body、confirmation 和 preview；preview.targetRevision 为目标完整修订，publishedRevision 为当前已发布版本。

将具体内容和操作交给用户核对，**获得对该项操作的明确授权后**再运行同一命令并加：

```sh
am knowledge review <entryId> <latestRevisionId> approve --authorize <confirmation> --json
```

| 参数 | 含义 |
|---|---|
| `<entryId>` / `<revisionId>` | 具体条目和最新修订，不是任务 ID；旧修订不可冒充最新修订审批 |
| `<action>` | approve 或 reject |
| `--base-revision-id` | 可选并发检查，必须等于当前 latestRevisionId |
| `--reason` | 可选理由；参与操作绑定，改理由须重新预览和确认 |
| `--authorize` | 本次精确 method/path/body 的 confirmation；不是 yes，不是旧操作通用令牌 |

不要替用户自行计算 digest、复用旧授权或把“请沉淀”当作审批。期间版本变化会报 CONTENT_STALE；重新读取、比较并取得新操作的授权。提交后通过 get/revision 回读 review 状态。

## 废弃与重新启用

```sh
am knowledge availability <entryId> deprecated --reason "新版本已替换此规则" --json
```

同样先返回确认材料；取得该次用户授权后加 `--authorize <confirmation>` 重试。可设 active、deprecated、superseded；expired 根据 validUntil 计算，resolved 根据未决事项修订计算，不作为 availability 命令的手动值。重新 active 不代表自动批准 pending 修订。

结果默认保留条目 id、latestRevisionId、publishedRevisionId、availability、简短修订状态；需要正文用 revision。完成条件：核实具体版本的 review/availability 与用户授权一致；拒绝或废弃后检查默认 reviewed/active 搜索不会误用它。
