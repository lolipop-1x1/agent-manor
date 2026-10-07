import type { FastifyInstance } from "fastify";
import { isAbsolute } from "node:path";
import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import type { ResourceManualSource } from "../resource-inventory-contracts.js";
import type { ResourceManagementInput } from "../resource-management-contracts.js";
import type { ResourceService } from "../resources/service.js";
import { emptyBody, ServiceError, textValue } from "./input.js";
import { resourceBody, resourceOverviewQuery, resourceQuery } from "./resource-input.js";

type Query = Record<string, unknown>;
type Id = { id: string };
export function registerResourceRoutes(app: FastifyInstance, resources: ResourceService): void {
  const base = "/api/v1/resources";
  app.get(`${base}/status`, () => resources.status());
  app.post(`${base}/refresh`, request => { emptyBody(request.body); return resources.refresh(); });
  app.get<{ Querystring: Query }>(`${base}/overview`, request => resources.overview(resourceOverviewQuery(request.query)));
  app.get<{ Params: Id; Querystring: Query }>(`${base}/overview/:id`, request => resources.overviewDetail(request.params.id, resourceOverviewQuery(request.query)));
  app.get<{ Querystring: Query }>(`${base}/usage`, request => resources.usage(resourceQuery(request.query)));
  app.get<{ Params: Id; Querystring: Query }>(`${base}/usage/:id`, request => resources.usageDetail(request.params.id, resourceQuery(request.query)));
  app.get<{ Params: Id; Querystring: Query }>(`${base}/usage/:id/evidence`, request => resources.evidence(request.params.id, resourceQuery(request.query)));
  app.get<{ Querystring: Query }>(`${base}/local`, request => resources.local(resourceQuery(request.query)));
  app.get<{ Params: Id; Querystring: Query }>(`${base}/local/:id`, request => resources.localDetail(request.params.id, resourceQuery(request.query)));
  app.get<{ Querystring: Query }>(`${base}/archives`, request => {
    const query = resourceQuery(request.query);
    const state = textValue(request.query.state, "state");
    if (state && !["disabled", "standby", "trash", "restored", "purged"].includes(state)) throw new ServiceError("INVALID_INPUT", "未知恢复记录状态");
    const archives = resources.manager.archives(state as Parameters<typeof resources.manager.archives>[0]).filter(archive =>
      (!query.kind || archive.entry.kind === query.kind) && (!query.client || archive.entry.client === query.client)
      && (!query.project || (query.project === "none" ? !archive.entry.project : archive.entry.project === query.project))
      && (!query.q || [archive.entry.name, archive.originalPath].some(value => value.toLocaleLowerCase().includes(query.q!.toLocaleLowerCase()))));
    const page = query.page!, pageSize = query.pageSize!;
    return { archives: archives.slice((page - 1) * pageSize, page * pageSize), total: archives.length, page, pageSize };
  });
  app.get<{ Querystring: Query }>(`${base}/operations`, request => {
    const query = resourceQuery(request.query);
    return resources.manager.operations(query.page, query.pageSize, query);
  });
  app.post(`${base}/favorites`, request => {
    const body = resourceBody(request.body, ["id", "value"]);
    if (typeof body.value !== "boolean") throw new ServiceError("INVALID_INPUT", "value 必须是布尔值");
    return resources.setFavorite(textValue(body.id, "id", true)!, body.value);
  });
  app.post(`${base}/sources`, request => {
    const body = resourceBody(request.body, ["client", "kind", "path", "project", "format", "keyPath"]);
    const client = textValue(body.client, "client", true)!;
    if (!clientIds.includes(client as Client) || !["skill", "mcp"].includes(String(body.kind))) throw new ServiceError("INVALID_INPUT", "未知客户端或资源类型");
    const path = textValue(body.path, "path", true)!, project = textValue(body.project, "project");
    if (!isAbsolute(path) || project && !isAbsolute(project) || path.includes("\0") || project?.includes("\0")) throw new ServiceError("INVALID_INPUT", "来源和项目必须是绝对路径");
    if (body.format !== undefined && !["skill-directory", "skill-files", "json", "jsonc", "toml"].includes(String(body.format))) throw new ServiceError("INVALID_INPUT", "不支持的手动来源格式");
    if (body.keyPath !== undefined && (!Array.isArray(body.keyPath) || body.keyPath.length > 20 || body.keyPath.some(value => typeof value !== "string" || !value || value.length > 4096
      || ["__proto__", "constructor", "prototype"].includes(value)))) throw new ServiceError("INVALID_INPUT", "keyPath 必须是安全的注册定位数组");
    return resources.addSource({ client: client as Client, kind: body.kind as ResourceManualSource["kind"], path, project,
      format: body.format as ResourceManualSource["format"], keyPath: body.keyPath as string[] | undefined });
  });
  app.delete<{ Params: Id }>(`${base}/sources/:id`, request => { emptyBody(request.body); return resources.removeSource(request.params.id); });
  app.post(`${base}/preview`, request => {
    const body = resourceBody(request.body, ["entryId", "operationId", "action"]);
    if (!["disable", "standby", "trash", "restore", "purge"].includes(String(body.action))) throw new ServiceError("INVALID_INPUT", "未知管理动作");
    return resources.preview({ action: body.action as ResourceManagementInput["action"],
      entryId: textValue(body.entryId, "entryId"), operationId: textValue(body.operationId, "operationId") });
  });
  app.post(`${base}/apply`, request => {
    const body = resourceBody(request.body, ["previewId", "confirmed"]);
    if (body.confirmed !== true) throw new ServiceError("INVALID_INPUT", "必须明确确认当前预览");
    return resources.apply(textValue(body.previewId, "previewId", true)!, true);
  });
}
