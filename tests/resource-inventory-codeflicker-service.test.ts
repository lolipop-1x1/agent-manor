import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceManager } from "../src/resources/management.js";
import { ResourceService } from "../src/resources/service.js";
import { SessionStore } from "../src/sessions/store.js";

async function file(path: string, text: string) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); }

test("本地项目查询读取压缩入口的有效上下文，不把被覆盖用户来源当作当前项目入口", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-flicker-scope-"));
  const userHome = join(directory, "user"), data = join(directory, "data");
  const first = join(directory, "first"), second = join(directory, "second");
  const body = "---\nname: sample\ndescription: Synthetic fixture\n---\n# Fixture\n";
  await file(join(userHome, ".codeflicker", "skills", "sample", "SKILL.md"), body);
  await file(join(userHome, ".codeflicker", "config.json"), '{"claudeImport":false,"remoteSkills":false}');
  await file(join(first, ".codeflicker", "skills", "sample", "SKILL.md"), body); await mkdir(second);
  const store = new SessionStore(join(data, "index.sqlite"));
  const manager = new ResourceManager(data);
  const service = new ResourceService(store, manager, { userHome }, () => [first, second]);
  try {
    const all = await service.local({ kind: "skill", client: "codeflicker" }); assert.equal(all.total, 2);
    const inherited = await service.local({ kind: "skill", client: "codeflicker", project: second });
    assert.equal(inherited.total, 1); assert.equal(inherited.rows[0]!.entries[0]!.scope, "user");
    assert.ok(inherited.rows[0]!.entries[0]!.selectionScopes?.some(scope => scope.project === second));
    const overridden = await service.local({ kind: "skill", client: "codeflicker", project: first });
    assert.equal(overridden.total, 1); assert.equal(overridden.rows[0]!.entries[0]!.scope, "project");
    const defaults = await service.local({ kind: "skill", client: "codeflicker", project: "none" });
    assert.equal(defaults.total, 1); assert.equal(defaults.rows[0]!.entries[0]!.scope, "user");
  } finally { manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
