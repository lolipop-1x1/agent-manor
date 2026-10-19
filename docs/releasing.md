# npm 发布指南

本文供维护者使用。用户安装与使用见[使用指南](usage.md)，交付范围见[交付设计](design/npm-cli-distribution.md)，测试边界见[交付验证](validation/npm-cli-distribution.md)。

发布顺序：准备版本 → 检查源码 → 打包 → 验收安装包 → 确认 CI → 手动发布 → 核对线上结果。

所有命令在仓库根目录执行，使用 Node.js 24 和 npm。GitHub CLI 仅用于查看 CI 和下载产物，也可在 GitHub Actions 页面操作。以下文件名以 `0.1.0` 为例，发其他版本时替换成实际版本。

## 1. 准备版本

```sh
git switch main
git pull --ff-only
git status --short
node --version
npm --version
```

从确定的提交发布。已有未提交修改时，先确认并完成这些修改，避免把尚未审阅的代码混入包。

首次发布可沿用仓库中的版本。后续发版同步以下位置：

| 文件 | 需要一致的内容 |
| --- | --- |
| `package.json` | 根产品包的 `version` |
| `packages/cli/package.json` | 私有 CLI workspace 的 `version` |
| `src/version.ts` | `VERSION` |
| `package-lock.json` | 顶层版本，以及根包、CLI workspace 的版本记录 |

例如将下一版设为 `0.1.1`，先更新两个 npm manifest 和锁文件：

```sh
npm version 0.1.1 --no-git-tag-version
npm version 0.1.1 --workspace @agent-manor/cli --no-git-tag-version
```

然后将 `src/version.ts` 中的 `VERSION` 改为同一版本，核对 Git diff。打包检查会拒绝根包、CLI workspace 与程序版本不一致的产物。配套 Skill 安装版本取自产品版本，不需要单独发布 workspace。

核对直接断言当前产品版本的测试，例如 `tests/install-package.test.ts`；更新、降级等场景中的合成版本按测试关系维护，不要全局替换版本字符串。发布成功后同一包名和版本无法覆盖，修复需要使用新版本。

## 2. 检查源码

```sh
npm ci
npm run check
npm run check:cli
npm run test:cli
```

上述命令验证类型、国际化及 CLI 单元测试。它们不生成安装包，也不替代后面的包外验收。

## 3. 打包

```sh
node -e "require('node:fs').mkdirSync('.local/package', { recursive: true })"
npm pack --pack-destination .local/package
```

产物为 `.local/package/agent-manor-0.1.0.tgz`。以 `npm pack` 最后输出的文件名为准；目录中可能留有旧版本，后续命令明确指定本次文件，不用 `*.tgz` 代替。

`npm pack` 自动运行根包的 `prepack`：

1. 清空 `dist`，构建后台、Worker、CLI 和 Web。
2. 根据 Web 实际构建清单生成 `THIRD_PARTY_NOTICES.txt`，保留代码及字体的完整许可文本。
3. 执行公开内容检查。
4. 检查版本一致性、交付入口、Skill 引用、公共 registry 及第三方许可。

不用提前另跑一次 `npm run build`。正式打包保留生命周期脚本；`--ignore-scripts` 只适用于已经完成构建的受控测试，不能用来跳过发布前检查。打包、生命周期及版本行为见 [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)、[npm scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/) 和 [npm version](https://docs.npmjs.com/cli/v11/commands/npm-version/)。

检查 `npm pack` 输出的清单与大小。包应包含 `LICENSE`、`THIRD_PARTY_NOTICES.txt`、`dist`、Skill 和白名单文档／展示资源；源码、测试、`.local`、`.scratch`、个人配置及本地数据库不应进入包。公开检查只扫描文本，新增图片及公开历史仍需人工检查。

Web 构建会更新根目录许可声明。若内容变化，核对并将声明与相关依赖变更一起提交；从最终提交重新打包、验收。任何会改变包内容的修改都需要重新验收。

## 4. 验收本次安装包

先运行需要编译产物的全量测试：

```sh
node --import tsx --test --test-concurrency=2 tests/*.test.ts
```

再将本次 tarball 显式传给两个包外验收脚本：

```sh
npm run test:package -- .local/package/agent-manor-0.1.0.tgz
npm run test:cli:installed -- .local/package/agent-manor-0.1.0.tgz
```

- `test:package`：在源码目录外安装，验证完整许可、两个命令入口、原生 SQLite／向量、端口冲突、后台／Worker／Web、停止以及 Skill 安装和备份。
- `test:cli:installed`：用合成数据验证会话、知识、用量、总览、仓库和资源等命令的参数、返回值及管理边界；模型场景调用隔离的本地测试服务。

脚本使用临时安装目录与合成数据，不需要替换本机正在使用的 `am`。验收期间不要在另一个终端执行构建或打包，以免清理测试正在读取的 `dist`。

## 5. 确认同一提交的 CI

提交并推送版本及相关修改，用 `git rev-parse HEAD` 记录提交 SHA。在 `npm package installation` workflow 中确认该 SHA 的以下任务全部通过：

- `package`：检查、构建和打包。
- `install`：同一 tarball 在 macOS arm64/x64、Linux arm64/x64、Windows x64 上安装并验收。

同时确认该提交的 `Public content` 通过。不能用上一个提交的绿色结果代替本次验收。CI 安装矩阵运行的是 `test:package`；全量测试及 `test:cli:installed` 另行执行，不由矩阵结果推定通过。

推荐从这个成功的 workflow 下载 `npm-tarball`，作为实际发布包。下列 `RUN_ID` 替换为对应运行 ID，下载到一个新目录：

```sh
gh run view RUN_ID --json headSha,status,conclusion,url
gh run download RUN_ID --name npm-tarball --dir .local/release-candidate
npm run test:cli:installed -- .local/release-candidate/agent-manor-0.1.0.tgz
```

最后一条把完整业务 CLI 验收也跑在准备发布的 CI 包上。本地打包用于提前验证；下载后的 CI 包是发布候选，后续直接上传这一文件。

保留提交 SHA、CI 链接、包文件和测试结果。记录文件完整性标识：

```sh
node -e "const fs=require('node:fs'),c=require('node:crypto');console.log('sha512-'+c.createHash('sha512').update(fs.readFileSync('.local/release-candidate/agent-manor-0.1.0.tgz')).digest('base64'))"
```

## 6. 登录并手动发布

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view agent-manor@0.1.0 version --registry=https://registry.npmjs.org/
```

确认登录的是有发布权限的账号。首次查询目标版本返回 `E404` 表示公共源当前未查到该版本，不保证包名一定可以注册；如果已能查到目标版本，不再重复上传。

核对账号、版本和候选文件后执行：

```sh
npm publish ./.local/release-candidate/agent-manor-0.1.0.tgz --registry=https://registry.npmjs.org/ --access public --tag latest
```

按 npm 提示完成账号验证。成功时终端显示 `+ agent-manor@0.1.0`。此命令会向公共 npm 发布；只在正式发版时执行，不放进验收脚本。tarball 发布、`latest` 和版本不可覆盖的规则见 [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## 7. 核对线上结果

```sh
npm view agent-manor@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
npm view agent-manor dist-tags --json --registry=https://registry.npmjs.org/
```

确认版本正确，`dist.integrity` 与候选包的 SHA-512 一致，`latest` 指向目标稳定版本。用户随后可执行 `npm install -g agent-manor`，再运行 `am --version` 和 `am web`。

发布后，从 registry 下载已发布的包并重新执行隔离安装验收：

```sh
node -e "require('node:fs').mkdirSync('.local/registry-smoke', { recursive: true })"
npm pack agent-manor@0.1.0 --registry=https://registry.npmjs.org/ --ignore-scripts --pack-destination .local/registry-smoke
npm run test:package -- .local/registry-smoke/agent-manor-0.1.0.tgz
```

这里下载的是已经构建的线上 tarball，`--ignore-scripts` 避免执行本仓库的生命周期脚本。包外验收检查两个命令及真实 Web，不用源码目录里的命令输出代替线上安装结果。记录最终 npm 页面、版本和发布时间。

## 常见问题

| 情况 | 处理 |
| --- | --- |
| `ENEEDAUTH` 或账号验证失败 | 重新登录公共 npm，完成 npm 提示的验证后再发布 |
| `E403` 或包名不可用 | 核对账号权限、包名及 registry 返回的具体原因；不要改用其他源规避 |
| 超时或断网，无法确定是否发布成功 | 先查询目标版本及 `dist.integrity`；确认远端状态后再决定是否重试 |
| 版本已经存在 | 相同版本不能覆盖；核对已有包，确需修改时递增版本后重新走完整流程 |
| 许可缺失或版本一致性检查失败 | 修正源文件／依赖及对应许可，再重新打包；不要跳过 prepack |
| 原生依赖安装失败 | 核对 Node.js、CPU 架构、平台、网络及原生构建工具，不能仅以打包成功作为验收结果 |
| CI 队列、额度或平台任务失败 | 排查具体任务，取得该提交全部目标平台的成功结果后再发布 |
