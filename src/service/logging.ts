import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const serviceLogPath = (home: string): string => join(home, "logs", "service.log");

/** 日志只接受生命周期元信息，不传入会话正文、请求体或模型凭据。 */
export function serviceLog(home: string, event: string, details: Record<string, unknown> = {}, maxBytes = 10 * 1024 * 1024): void {
  const directory = join(home, "logs"), path = serviceLogPath(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
    rmSync(`${path}.4`, { force: true });
    for (let index = 3; index >= 1; index--) if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, line, { mode: 0o600 });
  chmodSync(path, 0o600);
}
