import type { Command } from "commander";
import type { CliContext, Options } from "../context.js";
import { jsonInput, readJsonInput, queryOptions, queryParameters } from "../api/input.js";
import { RequestError } from "../../../../src/service/runtime.js";
import type { KnowledgeDetail } from "../../../../src/knowledge-contracts.js";
import { managementOptions, managementRequest } from "../api/management.js";
const fields = ["view", "project", "client", "type", "tag", "review", "availability", "from", "to", "taskId", "page", "pageSize"];
const entryPath = (id: string) => `/knowledge/entries/${encodeURIComponent(id)}`;
export function registerKnowledge(program: Command, context: CliContext): void {
  const group = program.command("knowledge").description(context.t("cli.ext.knowledge"));
  queryOptions(group.command("list").description(context.t("cli.ext.knowledge.list")), context, [...fields, "q"])
    .action(async (_opts, command: Command) => { await context.request(command, `/knowledge/entries${queryParameters(command, [...fields, "q"])}`); });
  queryOptions(group.command("search <text>").description(context.t("cli.ext.knowledge.search")), context, [...fields, "mode"])
    .action(async (text: string, _opts, command: Command) => {
      const query = Object.fromEntries(new URLSearchParams(queryParameters(command, [...fields, "mode"]).slice(1)));
      const body: Record<string, unknown> = { ...query, q: text };
      for (const key of ["page", "pageSize"]) if (body[key] !== undefined) body[key] = Number(body[key]);
      await context.request(command, "/knowledge/search", "POST", body);
    });
  group.command("facets").description(context.t("cli.ext.facets")).action(async (_opts, command: Command) => { await context.request(command, "/knowledge/facets"); });
  queryOptions(group.command("get <id>").description(context.t("cli.ext.knowledge.get")), context, ["revisionId", "review", "availability"])
    .action(async (id: string, _opts, command: Command) => { await context.request(command, `${entryPath(id)}${queryParameters(command, ["revisionId", "review", "availability"])}`); });
  for (const [name, method, path] of [["write", "POST", "/knowledge/entries"], ["revise <id>", "POST", "revisions"], ["restore <id>", "POST", "restore"]]) {
    jsonInput(group.command(name!).description(context.t(`cli.ext.knowledge.${name!.split(" ")[0]}`)), context)
      .action(async (...args: unknown[]) => {
        const command = args.at(-1) as Command;
        await context.request(command, path!.startsWith("/") ? path! : `${entryPath(String(args[0]))}/${path}`, method, await readJsonInput(command));
      });
  }
  group.command("revisions <id>").description(context.t("cli.ext.knowledge.revisions"))
    .action(async (id: string, _opts, command: Command) => { await context.request(command, `${entryPath(id)}/revisions`); });
  group.command("revision <id> <revisionId>").description(context.t("cli.ext.knowledge.revision"))
    .action(async (id: string, revisionId: string, _opts, command: Command) => { await context.request(command, `${entryPath(id)}/revisions/${encodeURIComponent(revisionId)}`); });
  managementOptions(group.command("review <id> <revisionId> <action>").description(context.t("cli.ext.knowledge.review")), context)
    .option("--reason <text>", context.t("cli.ext.reason")).option("--base-revision-id <id>", context.t("cli.ext.baseRevision"))
    .action(async (id: string, revisionId: string, action: string, _opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      if (!["approve", "reject"].includes(action)) throw new RequestError("INVALID_INPUT", "Review action must be approve or reject", { key: "cli.ext.reviewAction" });
      const detail = await context.fetch(command, `${entryPath(id)}?review=all&availability=all`) as KnowledgeDetail;
      if (detail.latestRevisionId !== revisionId || opts.baseRevisionId !== undefined && opts.baseRevisionId !== detail.latestRevisionId) throw new RequestError("CONTENT_STALE", "The target revision is no longer the latest revision", { key: "cli.ext.reviewStale" });
      const targetRevision = detail.revisions.find(revision => revision.id === revisionId);
      const publishedRevision = detail.revisions.find(revision => revision.id === detail.publishedRevisionId) ?? null;
      const preview = { latestRevisionId: detail.latestRevisionId, publishedRevision, targetRevision };
      const body = { revisionId, action, baseRevisionId: detail.latestRevisionId, ...(opts.reason ? { reason: opts.reason } : {}) };
      await managementRequest(command, context, `${entryPath(id)}/reviews`, "POST", body, preview);
    });
  managementOptions(group.command("availability <id> <state>").description(context.t("cli.ext.knowledge.availability")), context)
    .option("--reason <text>", context.t("cli.ext.reason"))
    .action(async (id: string, availability: string, _opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      if (!["active", "deprecated", "superseded"].includes(availability)) throw new RequestError("INVALID_INPUT", "Invalid availability", { key: "cli.ext.availabilityInvalid" });
      const preview = await context.fetch(command, `${entryPath(id)}?review=all&availability=all`);
      await managementRequest(command, context, `${entryPath(id)}/availability`, "POST", { availability, baseRevisionId: (preview as { latestRevisionId: string }).latestRevisionId, ...(opts.reason ? { reason: opts.reason } : {}) }, preview);
    });
  const settings = group.command("settings").description(context.t("cli.ext.settings"));
  for (const name of ["get", "defaults"]) queryOptions(settings.command(name).description(context.t(`cli.ext.settings.${name}`)), context, ["language"])
    .action(async (_opts, command: Command) => { await context.request(command, `/knowledge/settings${name === "defaults" ? "/defaults" : ""}${queryParameters(command, ["language"])}`); });
  for (const [name, method, path] of [["set", "PUT", "/knowledge/settings"], ["test", "POST", "/knowledge/test"], ["try", "POST", "/knowledge/prompts/try"]]) {
    jsonInput(settings.command(name!).description(context.t(`cli.ext.settings.${name}`)), context)
      .action(async (_opts, command: Command) => { await context.request(command, path!, method, await readJsonInput(command, name !== "test")); });
  }
  managementOptions(settings.command("key <kind>").description(context.t("cli.ext.settings.key")), context)
    .action(async (kind: string, _opts, command: Command) => { await managementRequest(command, context, "/knowledge/settings/key", "POST", { kind }); });
  const extraction = group.command("extraction").description(context.t("cli.ext.extraction"));
  jsonInput(extraction.command("preview").description(context.t("cli.ext.extraction.preview")), context)
    .action(async (_opts, command: Command) => { await context.request(command, "/knowledge/extractions/preview", "POST", await readJsonInput(command)); });
  extraction.command("preview-get <id>").description(context.t("cli.ext.extraction.previewGet"))
    .action(async (id: string, _opts, command: Command) => { await context.request(command, `/knowledge/extractions/previews/${encodeURIComponent(id)}`); });
  context.waiting(extraction.command("start <previewId>").description(context.t("cli.ext.extraction.start")))
    .option("--idempotency-key <key>", context.t("cli.ext.idempotency"))
    .action(async (previewId: string, _opts, command: Command) => {
      const result = await context.fetch(command, "/knowledge/extractions", "POST", { previewId, ...(command.optsWithGlobals<Options>().idempotencyKey ? { idempotencyKey: command.optsWithGlobals<Options>().idempotencyKey } : {}) });
      await finishExtraction(command, context, result);
    });
  extraction.command("list").description(context.t("cli.ext.extraction.list")).action(async (_opts, command: Command) => { await context.request(command, "/knowledge/extractions"); });
  context.waiting(extraction.command("get <id>").description(context.t("cli.ext.extraction.get")))
    .action(async (id: string, _opts, command: Command) => { await context.request(command, `/knowledge/extractions/${encodeURIComponent(id)}`, "GET", undefined, true, `/knowledge/extractions/${encodeURIComponent(id)}`); });
  for (const action of ["pause", "resume", "retry"]) context.waiting(extraction.command(`${action} <id>`).description(context.t(`cli.ext.${action}`)))
    .action(async (id: string, _opts, command: Command) => { await context.request(command, `/knowledge/extractions/${encodeURIComponent(id)}/${action}`, "POST", {}, true, `/knowledge/extractions/${encodeURIComponent(id)}`); });
  const index = group.command("index").description(context.t("cli.ext.index"));
  index.command("status").description(context.t("cli.ext.index.status")).action(async (_opts, command: Command) => { await context.request(command, "/knowledge/index/status"); });
  index.command("preview").description(context.t("cli.ext.index.preview")).action(async (_opts, command: Command) => { await context.request(command, "/knowledge/index/preview", "POST", {}); });
  context.waiting(index.command("build <previewId>").description(context.t("cli.ext.index.build")))
    .action(async (previewId: string, _opts, command: Command) => { await context.request(command, "/knowledge/index/build", "POST", { previewId }, true, "/knowledge/index/status"); });
  for (const action of ["pause", "resume"]) context.waiting(index.command(action).description(context.t(`cli.ext.${action}`)))
    .action(async (_opts, command: Command) => { await context.request(command, `/knowledge/index/${action}`, "POST", {}, true, "/knowledge/index/status"); });
}
async function finishExtraction(command: Command, context: CliContext, value: unknown): Promise<void> {
  const result = value as { id?: string; job?: { id: string } };
  if (command.optsWithGlobals<Options>().wait) await context.request(command, `/knowledge/extractions/${encodeURIComponent(result.job?.id ?? result.id ?? "")}`, "GET", undefined, true, `/knowledge/extractions/${encodeURIComponent(result.job?.id ?? result.id ?? "")}`);
  else context.output(command, value);
}
