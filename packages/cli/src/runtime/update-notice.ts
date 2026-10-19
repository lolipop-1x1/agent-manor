import { ReleaseService } from "../../../../src/service/releases.js";
import { dataHome } from "../../../../src/service/runtime.js";
import { translate, type Language } from "../../../../src/i18n/index.js";

export interface NoticeEnvironment { tty: boolean; ci: boolean; disabled: boolean }
export function allowsUpdateNotice(args: readonly string[], environment: NoticeEnvironment): boolean {
  if (!environment.tty || environment.ci || environment.disabled || process.exitCode) return false;
  if (args.some(value => ["--json", "--no-update-check", "--help", "-h", "--version", "--cli-version", "-V"].includes(value))) return false;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") break;
    if (["--home", "--lang"].includes(value)) { index++; continue; }
    if (!value.startsWith("-")) words.push(value);
  }
  if (words.includes("status") || words.includes("help")) return false;
  return ["sessions", "knowledge", "semantic", "resources", "repositories", "overview", "usage", "preferences", "skills", "web", "start", "restart", "ready"].includes(words[0] ?? "");
}
export async function cachedUpdateNotice(args: readonly string[], language: Language, dependencies: {
  service?: Pick<ReleaseService, "claimNotice">; environment?: NoticeEnvironment;
} = {}): Promise<string | undefined> {
  const environment = dependencies.environment ?? { tty: !!process.stdin.isTTY && !!process.stderr.isTTY, ci: !!process.env.CI, disabled: process.env.AGENT_MANOR_NO_UPDATE_CHECK === "1" };
  if (!allowsUpdateNotice(args, environment)) return;
  let home: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--home") home = args[index + 1];
    else if (args[index]?.startsWith("--home=")) home = args[index]!.slice(7);
  }
  // 提醒只读取本地缓存；损坏或忙碌的提醒记录不改变业务命令结果。
  try {
    const status = await (dependencies.service ?? new ReleaseService({ home: dataHome(home) })).claimNotice();
    if (status) return translate(language, "cli.update.notice", { version: status.latestVersion!, command: status.updateCommand });
  } catch { /* 更新提醒失败不影响已经成功的命令。 */ }
}
