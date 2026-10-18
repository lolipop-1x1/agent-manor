# 06 整版审查与交付

Type: task
Status: resolved
Blocked by: 05

## Scope

运行 code-review，集中修复发现；更新设计/产品/使用与验证记录，检查差异和公开边界。遵循用户要求直接 main，不建立功能 PR。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

完整变更按 Standards/Spec 两轴独立审查，2项规范问题与3项规格问题集中修复后，由原审查者逐项复核关闭；实际 Chrome 补验普通与嵌套弹窗焦点恢复。同步更新产品、设计、使用与验证文档，修复发布包文档链接并通过实际包外安装及最终全量测试。公开记录仅含合成示例和验证结论；真实输入、模型输出及截图保留忽略目录。按用户授权统一在 main 交付，不建立功能分支或 PR。
