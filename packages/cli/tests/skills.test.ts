import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { manageSkill, skillTargetPath } from "../src/skills/manager.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-manor-skill-"));
  const template = join(directory, "template");
  await mkdir(join(template, "references"), { recursive: true });
  await writeFile(join(template, "SKILL.md"), "# Example Skill\n[查询](references/sessions.md)\n");
  await writeFile(join(template, "references/sessions.md"), "am sessions list --json\n");
  return { directory, template, options: { target: "custom" as const, directory: join(directory, "installed"), templateDirectory: template } };
}
test("Skill 安装携带完整 references，同版跳过且移除不影响其他目录", async () => {
  const { directory, options } = await fixture();
  try {
    const installed = await manageSkill("install", options);
    assert.equal(installed.status, "installed");
    assert.match(await readFile(join(installed.targetPath, "references/sessions.md"), "utf8"), /sessions list/);
    assert.equal((await manageSkill("install", options)).status, "current");
    await mkdir(join(options.directory, "another-skill"));
    assert.equal((await manageSkill("remove", options)).status, "removed");
    assert.deepEqual(await readdir(options.directory), ["another-skill"]);
    assert.equal((await manageSkill("status", options)).status, "missing");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("用户修改必须明确覆盖并保留完整备份", async () => {
  const { directory, options } = await fixture();
  try {
    const installed = await manageSkill("install", options);
    await writeFile(join(installed.targetPath, "references/sessions.md"), "user edits");
    assert.equal((await manageSkill("status", options)).status, "modified");
    await assert.rejects(manageSkill("update", options), { code: "SKILL_MODIFIED" });
    const updated = await manageSkill("update", { ...options, overwrite: true });
    assert.equal(updated.status, "updated");
    assert.ok(updated.backupPath);
    assert.equal(await readFile(join(updated.backupPath, "references/sessions.md"), "utf8"), "user edits");
    assert.match(await readFile(join(updated.targetPath, "references/sessions.md"), "utf8"), /sessions list/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("外来同名副本受保护，显式安装接管先备份，移除修改副本保留备份", async () => {
  const { directory, options } = await fixture();
  try {
    const target = skillTargetPath(options);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "foreign");
    assert.equal((await manageSkill("status", options)).status, "foreign");
    await assert.rejects(manageSkill("remove", { ...options, overwrite: true }), { code: "SKILL_NOT_MANAGED" });
    await assert.rejects(manageSkill("install", options), { code: "SKILL_MODIFIED" });
    const installed = await manageSkill("install", { ...options, overwrite: true });
    assert.ok(installed.backupPath);
    assert.equal(await readFile(join(installed.backupPath, "SKILL.md"), "utf8"), "foreign");
    await writeFile(join(target, "extra.md"), "retain");
    const removed = await manageSkill("remove", { ...options, overwrite: true });
    assert.ok(removed.backupPath);
    assert.equal(await readFile(join(removed.backupPath, "extra.md"), "utf8"), "retain");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("旧版本未修改副本可更新；损坏记录和符号链接不可误删", async () => {
  const { directory, options } = await fixture();
  try {
    const installed = await manageSkill("install", options);
    const recordPath = join(installed.targetPath, ".agent-manor-skill.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, JSON.stringify({ ...record, version: "0.0.1" }));
    assert.equal((await manageSkill("status", options)).status, "outdated");
    assert.equal((await manageSkill("update", options)).status, "updated");
    await writeFile(recordPath, "{broken");
    await assert.rejects(manageSkill("remove", options), { code: "SKILL_NOT_MANAGED" });
    await rm(installed.targetPath, { recursive: true });
    await symlink(options.templateDirectory, installed.targetPath, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(manageSkill("remove", options), { code: "SKILL_TARGET_CONFLICT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("用户级、项目级和自定义路径解析不写真实用户目录", () => {
  const base = join(tmpdir(), "agent-manor-skill-paths");
  assert.equal(skillTargetPath({ target: "claude", userHome: base }), join(base, ".claude/skills/agent-manor"));
  assert.equal(skillTargetPath({ target: "codex", userHome: base }), join(base, ".codex/skills/agent-manor"));
  assert.equal(skillTargetPath({ target: "codex", scope: "project", projectDirectory: base }), join(base, ".agents/skills/agent-manor"));
  assert.equal(skillTargetPath({ target: "codex", environment: { CODEX_HOME: base } }), join(base, "skills/agent-manor"));
  assert.throws(() => skillTargetPath({}), { code: "SKILL_TARGET_REQUIRED" });
});
test("同版本模板变更可识别并升级；非法目标和范围在写入前拒绝", async () => {
  const { directory, options } = await fixture();
  try {
    await manageSkill("install", options);
    await writeFile(join(options.templateDirectory, "references/sessions.md"), "updated bundled template");
    assert.equal((await manageSkill("status", options)).status, "outdated");
    assert.equal((await manageSkill("update", options)).status, "updated");
    assert.equal(await readFile(join(skillTargetPath(options), "references/sessions.md"), "utf8"), "updated bundled template");
    assert.throws(() => skillTargetPath({ ...options, scope: "unexpected" as "user" }), { code: "SKILL_INVALID_SCOPE" });
    assert.throws(() => skillTargetPath({ ...options, target: "unexpected" as "codex" }), { code: "SKILL_INVALID_TARGET" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Claude 与 Codex 用户级、项目级安装均只写隔离的宿主根", async () => {
  const { directory, template } = await fixture();
  try {
    for (const target of ["claude", "codex"] as const) for (const scope of ["user", "project"] as const) {
      const options = { target, scope, userHome: join(directory, "user"), projectDirectory: join(directory, "project"), templateDirectory: template };
      const installed = await manageSkill("install", options);
      assert.equal(installed.status, "installed");
      assert.ok(installed.targetPath.startsWith(directory));
      assert.equal((await manageSkill("status", options)).status, "current");
      assert.equal((await manageSkill("remove", options)).status, "removed");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
