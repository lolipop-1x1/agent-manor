import { join } from "node:path";
import type { NativePlannerOptions } from "./native-inventory.js";

/** 仅登记已核验的本机入口；下载同步目录不能当作普通可管理 Skill。 */
export async function planDoubaoWorkInventory({ userHome, projects, add }: NativePlannerOptions): Promise<void> {
  const profile = join(userHome, "Library", "Application Support", "DoubaoWork", "Default");
  const workspace = join(profile, ".doubaowork", "agent_mode", "workspace");
  for (const name of [".skills", ".user_skills"]) {
    const path = join(workspace, name);
    // 原生安装器会替换目录，USER watcher 还会上传和同步删除，始终保护。
    add("doubao-work", "skill", path, "skill-directory", { origin: "managed", skillDepth: 1, skillContainmentRoot: path });
  }
  // 原生本地 Skill loader 使用 .agents/skills；启停偏好和附加目录策略尚未核验。
  add("doubao-work", "skill", join(userHome, ".agents", "skills"), "skill-directory", { skillDepth: 1 });
  for (const project of projects) {
    add("doubao-work", "skill", join(project, ".agents", "skills"), "skill-directory", { project, skillDepth: 1 });
  }
  // helper 或连接器的存在不证明有可读取、可编辑的本地 MCP 注册文件。
  add("doubao-work", "mcp", profile, "unsupported", { verified: false });
}
