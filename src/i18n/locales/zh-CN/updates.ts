import type { MessageCatalog } from "../../types.js";

export default {
  "updates.invalidSettings": "更新设置只接受 autoCheck 或精确的稳定版 ignoredVersion。",
  "updates.invalidVersion": "仅支持精确的稳定发布版本。",
  "updates.invalidMetadata": "发布元信息缺失或无效，请稍后重试检查。",
  "updates.notFound": "公共仓库中没有此安装包或版本（HTTP {{status}}）。",
  "updates.httpError": "发布仓库返回 HTTP {{status}}，请稍后重试检查。",
  "updates.checkFailed": "无法检查更新，请稍后重试。",
  "updates.checkTimeout": "检查更新超过 5 秒，请稍后重试。",
  "updates.incompatibleNode": "此版本要求 Node.js {{required}}，当前运行环境为 {{current}}。",
  "updates.incompatibleOs": "此版本不支持当前操作系统（{{current}}）。",
  "updates.incompatibleArch": "此版本不支持当前 CPU 架构（{{current}}）。",
} satisfies MessageCatalog;
