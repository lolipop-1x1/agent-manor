# 服务与安装维护

- `am start --json` 启动或复用健康后台；`am serve` 前台运行；关闭启动命令终端后后台继续服务。
- `am web` 打开实际服务地址；地址以返回值为准。默认从 16666 开始尝试，CLI 通过本地实例身份发现服务，不通过猜端口接管进程。
- `am status --json`、`am version --json`、`am doctor --json` 和帮助不会启动服务；`am logs --help` 查看日志。服务就绪与历史／索引准备分开，具体等待选项见帮助。
- `am stop --json` 等待已核验实例停止，`am restart --help` 查看重启及在途任务约束。只在用户要求或隔离测试收尾时停止，普通查询后不停止用户后台。
- `am update --help` 查看显式程序更新方式。先核对安装来源、目标版本、在途任务与恢复材料；不在查询时静默升级。

## 配套 Skill

`am skills install` 提供交互目标选择；脚本通过参数指定宿主、范围或自定义父目录，例如：

```sh
am skills install --target codex --scope user --json
am skills install --target claude --scope project --json
am skills install --target custom --directory <skillsDirectory> --json
am skills status --target codex --scope user --json
am skills update --target codex --scope user --json
```

复制整个 Skill，references 随副本一起可用。安装会报告最终位置，同版本未修改副本跳过。用户修改或外来同名目录默认报冲突；用户明确选择 `--overwrite` 才覆盖并保留返回的备份。`skills remove` 只移除有有效本产品记录的副本，修改过的内容需明确选择并保留备份。

测试使用独立 `--home` 和合成历史目录，Skill 使用临时自定义目录；不能把真实 home、客户端配置、模型 Key 或正在使用的后台当成测试对象。
