import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/sessions/store.js";
import { ResourceManager } from "../src/resources/management.js";
import { ResourceService } from "../src/resources/service.js";

test("扫描期间新增、移除来源与项目变化只发布最新输入，普通并发读取仍合并", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-inventory-generation-"));
  const sourcePath = join(directory, "manual"), project = join(directory, "project");
  await mkdir(join(sourcePath, "guide"), { recursive: true }); await mkdir(project);
  await writeFile(join(sourcePath, "guide", "SKILL.md"), "---\nname: guide\ndescription: Synthetic guide\n---\n# Guide\n");
  const library = new SessionStore(join(directory, "data", "index.sqlite")), manager = new ResourceManager(join(directory, "data"));
  let projects: string[] = [], published = 0;
  const decorate = manager.decorateInventory.bind(manager);
  manager.decorateInventory = snapshot => { published++; return decorate(snapshot); };
  const service = new ResourceService(library, manager, { userHome: join(directory, "user"), environment: {} }, () => projects);
  try {
    const before = service.refresh();
    const added = service.addSource({ client: "codex", kind: "skill", path: sourcePath });
    const [initial, next] = await Promise.all([before, added]);
    assert.ok(initial.sources.some(source => source.path === sourcePath));
    assert.ok(next.sources.some(source => source.path === sourcePath)); assert.equal(published, 1, "过时扫描不发布，相同最新输入只发布一次");
    const sourceId = next.manualSources[0]!.id;
    const scanning = service.refresh(), removed = service.removeSource(sourceId);
    const statuses = await Promise.all([scanning, removed, service.status()]);
    assert.ok(statuses.every(status => !status.sources.some(source => source.path === sourcePath)));
    assert.equal(published, 2);
    const oldProject = service.refresh(); projects = [project];
    const [previous, current] = await Promise.all([oldProject, service.status()]);
    assert.ok(previous.sources.some(source => source.project === project));
    assert.ok(current.sources.some(source => source.project === project)); assert.equal(published, 3);
    await Promise.all([service.status(), service.status(), service.status()]); assert.equal(published, 3);
  } finally { library.close(); manager.close(); await rm(directory, { recursive: true, force: true }); }
});
