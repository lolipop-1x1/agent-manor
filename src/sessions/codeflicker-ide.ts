import { object, string } from "./parser-usage.js";
import { ideTool } from "../history/adapters/codeflicker-ide.js";
import type { IdeSnapshot } from "../history/adapters/codeflicker-ide.js";

/** 内存中规范化主 UI 记录；API 上下文副本不重复作为用户消息或工具调用导入。 */
export function* ideSessionRecords(snapshot: IdeSnapshot): Generator<{ line: number; record: Record<string, unknown> }> {
  for (const { record, line } of snapshot.records) {
    if (snapshot.legacy) {
      const question = object(record.Q);
      yield { line, record: { id: `legacy:${line}:user`, role: "user", content: question.plainText ?? question.question,
        timestamp: record.ts } };
      for (const [index, value] of (Array.isArray(record.A) ? record.A : []).entries()) {
        const answer = object(value);
        yield { line, record: { id: `legacy:${line}:answer:${index}`, role: "assistant", content: answer.reply, model: answer.modelType,
          timestamp: record.ts } };
      }
      continue;
    }
    const base: Record<string, unknown> = { id: `ide:${line}`, timestamp: record.ts, model: record.chatModel };
    const type = string(record.say ?? record.ask);
    const tool = ideTool(record);
    if (tool) {
      const callId = string(record.toolCallId) ?? `ide:${line}`;
      const name = tool.mcp ? `mcp__${tool.mcp.server}__${tool.mcp.name}` : tool.name === "useSkill" ? "use_skill" : tool.name;
      // UI 工具对象把返回正文放在 content／output 中，不能再当作请求参数重复估算。
      const { content: _content, output: _output, ...parameters } = tool.input;
      const input = tool.name === "useSkill" ? { ...parameters, name: tool.input.skillName }
        : tool.name === "editFile" ? tool.input : parameters;
      yield { line, record: { ...base, role: "assistant", toolCalls: [{ id: callId, function: { name, arguments: JSON.stringify(input) } }] } };
      if (!record.__separateResult && (tool.content || Object.keys(object(record.workingSetEffect)).length)) yield { line,
        record: { ...base, id: `${base.id}:result`, role: "tool", toolCallId: callId, content: tool.content,
          isError: tool.status === "failure" ? true : tool.status === "success" ? false : undefined,
          extra: { toolName: name } } };
    } else if (type === "text") yield { line, record: { ...base, role: record.role === "user" ? "user" : "assistant", content: record.text } };
    else if (type === "followup") yield { line, record: { ...base, role: "assistant", content: record.text } };
    else if (type === "thinking") yield { line, record: { ...base, role: "reasoning", content: record.text } };
    else if (type === "summarize_messages") yield { line, record: { ...base, role: "activity", content: record.text, extra: { compaction: { recorded: true } } } };
    else if (["command_output", "use_mcp_tool_result", "tool_error"].includes(type ?? "")) yield { line,
      record: { ...base, role: "tool", toolCallId: record.toolCallId, content: record.text, isError: type === "tool_error" ? true : undefined } };
    else if (type === "completion_result") yield { line, record: { ...base, op: "turn_terminal",
      outcome: record.partial === true || /error|abort|cancel/i.test(string(record.stopReason) ?? "") ? "interrupted" : "completed" } };
    else yield { line, record: { ...base, role: "system", content: record.text || type || "未记录内容",
      ...(!record.text && !type ? { textDescriptor: { key: "sessions.body.unrecorded" } } : {}) } };
  }
}
