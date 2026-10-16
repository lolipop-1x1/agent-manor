import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeDoubaoWorkCache } from "./doubao-work-store.js";
import { isolatedHistoryRoots } from "./history-roots.js";

const run = promisify(execFile);
const skill = (name: string) => `---\nname: ${name}\ndescription: 人工合成的豆包资源说明\n---\n只用于隔离验收。\n`;
const text = (id: string, value: string, parent = "0") => ({ block_id: id, parent_id: parent, block_type: 10000, content: { text_block: { text: value } } });

/** 全部路径与内容都由测试新建；不使用日常 home、历史或客户端配置。 */
export async function createDoubaoWorkScenario(directory: string, options: { includeUnlinkedReplies?: boolean } = {}) {
  const home = join(directory, "data"), userHome = join(directory, "synthetic-user"), project = join(directory, "synthetic-project");
  const history = join(directory, "history");
  const launcher = join(history, "chrome_doubaowork-launcher_0.indexeddb.leveldb");
  const chat = join(history, "chrome_doubaowork-chat_0.indexeddb.leveldb");
  const sharedSkill = join(userHome, ".agents", "skills", "doubao-shared-guide");
  const managedSkill = join(userHome, "Library", "Application Support", "DoubaoWork", "Default", ".doubaowork", "agent_mode", "workspace", ".skills", "doubao-managed-guide");
  for (const path of [join(project, "src", "example.ts"), join(sharedSkill, "SKILL.md"), join(managedSkill, "SKILL.md")]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, path.endsWith(".ts") ? "export const synthetic = true;\n" : skill(path.includes("doubao-shared-guide") ? "doubao-shared-guide" : "doubao-managed-guide"));
  }
  await run("git", ["init", "-q", project]);
  await run("git", ["-C", project, "add", "src/example.ts"]);
  const title = "豆包合成兼容任务", needle = "DoubaoFixtureNeedle", thinking = "只用于完整过程的合成检查";
  const unlinkedReplies = ["未知轮次独立回复甲 OrphanReplyAlpha", "未知轮次独立回复乙 OrphanReplyBeta"];
  const response = (cells: unknown[]) => ({ downlink_body: { pull_recent_conv_chain_downlink_body: {
    has_more: false, next_conv_version: "8", first_conv_version: "1", cells: cells.map(conversation => ({ conversation })),
  } } });
  const message = (id: string, role: number, index: number, blocks: unknown[], extra: Record<string, unknown> = {}) => ({
    message_id: id, user_type: role, index_in_conv: String(index), create_time: String(1792029600 + index), update_time: String(1792029600 + index),
    section_id: "synthetic-shared-section", content_type: 9999, content: "", thinking_content: "", content_block: blocks,
    ext: { general_task_param: { client_option: { workspace: project } },
      context_window_usage: { system_prompt: 20, messages: 30, skills: 10, tools: 5, total_window_size: 1000 },
      input_skill: { skill_id: "synthetic-selected-only", skill_type: 0 },
      tea_tags_time_cost: { first_packet_cost_time: "8" }, commerce_usage_data_v1: { label: "Display only", value: "1" } }, ...extra,
  });
  const conversation = (reply: string, summary = false) => ({
    conversation_id: "synthetic-doubao-conversation", name: title, conv_version: "8", create_time: "1792029600", update_time: "1792029610",
    project_reference: { project_id: "synthetic-product-project" },
    messages: summary ? [] : [
      message("synthetic-user-one", 1, 1, [text("request-one", `检查合成文件 ${needle}`)]),
      message("synthetic-answer-one", 2, 2, [
        { block_id: "synthetic-thinking", parent_id: "0", block_type: 10040, content: { thinking_block: { finish_title: "合成过程" } } },
        text("thinking-text", thinking, "synthetic-thinking"),
        { block_id: "synthetic-file-card", parent_id: "synthetic-thinking", block_type: 10019, is_finish: true,
          content: { file_operation_block: { operation_type: 1, path: join(project, "src", "example.ts"),
            header: { summary: "已读取" }, content: "export const synthetic = true;" } } },
        { block_id: "synthetic-failed-card", parent_id: "synthetic-thinking", block_type: 10019, is_finish: true,
          content: { file_operation_block: { operation_type: 1, path: join(project, "src", "missing.ts"),
            header: { summary: "已读取" }, content: "File does not exist" } } },
        text("answer-one", reply),
      ], { bot_reply_message_id: "synthetic-user-one" }),
      message("synthetic-user-two", 1, 3, [text("request-two", "说明可确认的来源边界")]),
      message("synthetic-answer-two", 2, 4, [text("answer-two", "这是本机缓存的合成回复，完成状态未确认。")], { bot_reply_message_id: "synthetic-user-two" }),
      // 分别覆盖缺失关联和无效目标；它们都不能继承最近一条用户消息。
      ...(options.includeUnlinkedReplies ? [
        message("synthetic-unlinked-one", 2, 5, [text("unlinked-answer-one", unlinkedReplies[0]!)]),
        message("synthetic-unlinked-two", 2, 6, [text("unlinked-answer-two", unlinkedReplies[1]!)], { bot_reply_message_id: "synthetic-missing-user" }),
      ] : []),
    ],
  });
  const writeCache = async (reply = "合成回复：已保留本机证据。", present = true) => {
    const current = await writeDoubaoWorkCache(launcher, [{ account: "DoubaoPC_synthetic", value: response(present ? [conversation(reply)] : []) }], { external: true, table: true, snappy: true });
    await writeDoubaoWorkCache(chat, [{ account: "DoubaoPC_synthetic", value: response(present ? [conversation(reply, true)] : []) }]);
    return current;
  };
  const current = await writeCache();
  return { directory, home, userHome, project, history, launcher, chat, current, title, needle, thinking, sharedSkill, managedSkill, unlinkedReplies,
    roots: isolatedHistoryRoots({ "doubao-work": history }), writeCache };
}
