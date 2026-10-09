import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Baseline, EvidenceFragment, HistoryEvent, ParsedSource } from "../src/contracts.js";
import { associateSource, createSourceAssociationCache, parseSource } from "../src/history/index.js";

const run = promisify(execFile);

async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-history-association-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function gitExecutable(): Promise<string> {
  return (await run("which", ["git"])).stdout.trim();
}

async function git(gitPath: string, args: string[]) {
  return run(gitPath, args);
}

async function repositoryFixture(directory: string) {
  const repository = join(directory, "repository");
  const firstWorktree = join(directory, "worktree-one");
  const secondWorktree = join(directory, "worktree-two");
  const independentClone = join(directory, "independent-clone");
  const gitPath = await gitExecutable();
  await mkdir(repository);
  await git(gitPath, ["init", repository]);
  await writeFile(join(repository, "a.ts"), "alpha\n");
  await git(gitPath, ["-C", repository, "add", "a.ts"]);
  await git(gitPath, ["-C", repository, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "synthetic baseline"]);
  await git(gitPath, ["-C", repository, "worktree", "add", "--detach", firstWorktree]);
  await git(gitPath, ["-C", repository, "worktree", "add", "--detach", secondWorktree]);
  await git(gitPath, ["clone", repository, independentClone]);
  const commonDir = (await git(gitPath, ["-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const baseline: Baseline = {
    repository: { id: "synthetic-git", path: repository, commonDir, name: "synthetic", stale: false },
    hash: "baseline",
    createdAt: "2026-01-01T00:00:00Z",
    git: { dirty: false },
    excluded: [],
    files: [{ path: "a.ts", category: "source", content: "alpha\n", hash: "file", lineCount: 1 }],
  };
  return { baseline, firstWorktree, secondWorktree, independentClone, repository, gitPath };
}

async function sourceFixture(cwd: string): Promise<ParsedSource> {
  const path = new URL("./fixtures/history/codex-modern.jsonl", import.meta.url).pathname;
  const source = await parseSource(path, "codex");
  source.cwd = cwd;
  return source;
}

function eventAt(template: HistoryEvent, cwd: string, path: string, fragmentPaths: string[]): HistoryEvent {
  const fragment = template.fragments[0]!;
  const fragments: EvidenceFragment[] = fragmentPaths.map((fragmentPath) => ({ ...fragment, path: fragmentPath }));
  return { ...template, cwd, path, fragments };
}

async function withGitCounter(directory: string, action: (readCounts: () => Promise<{ commonDir: number; worktreeRoot: number }>) => Promise<void>) {
  const bin = join(directory, "bin");
  const wrapper = join(bin, "git");
  const counter = join(directory, "git-calls");
  const realGit = await gitExecutable();
  await mkdir(bin, { recursive: true });
  await writeFile(counter, "");
  await writeFile(wrapper, [
    "#!/bin/sh",
    "if [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"--show-toplevel\" ]; then printf 'root\\n' >> \"$MANOR_ASSOC_COUNTER\"; fi",
    "if [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"--path-format=absolute\" ]; then printf 'common\\n' >> \"$MANOR_ASSOC_COUNTER\"; fi",
    "exec \"$MANOR_ASSOC_REAL_GIT\" \"$@\"",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const originalPath = process.env.PATH;
  const originalCounter = process.env.MANOR_ASSOC_COUNTER;
  const originalRealGit = process.env.MANOR_ASSOC_REAL_GIT;
  const readCounts = async () => {
    const calls = (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean);
    return { commonDir: calls.filter((call) => call === "common").length, worktreeRoot: calls.filter((call) => call === "root").length };
  };
  try {
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env.MANOR_ASSOC_COUNTER = counter;
    process.env.MANOR_ASSOC_REAL_GIT = realGit;
    await action(readCounts);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCounter === undefined) delete process.env.MANOR_ASSOC_COUNTER; else process.env.MANOR_ASSOC_COUNTER = originalCounter;
    if (originalRealGit === undefined) delete process.env.MANOR_ASSOC_REAL_GIT; else process.env.MANOR_ASSOC_REAL_GIT = originalRealGit;
  }
}

test("同一 cwd 在单次关联内复用 worktree 根查询且逐路径过滤", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const source = await sourceFixture(fixture.firstWorktree);
  source.events = [
    eventAt(source.events[0]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [join(fixture.firstWorktree, "a.ts"), join(fixture.firstWorktree, "a.ts")]),
    eventAt(source.events[1]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [join(fixture.independentClone, "a.ts")]),
  ];
  await withGitCounter(directory, async (readCounts) => {
    const result = await associateSource(source, fixture.baseline);
    assert.equal(result.associated, true);
    assert.deepEqual(result.events.map((event) => event.path), ["a.ts", "a.ts"]);
    assert.equal(result.events[0]!.fragments.length, 2);
    assert.equal(result.events[1]!.fragments.length, 0);
    assert.deepEqual(await readCounts(), { commonDir: 1, worktreeRoot: 1 });
  });
}));

test("同一关联中的不同 worktree 各自核验根目录", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const source = await sourceFixture(fixture.firstWorktree);
  source.events = [
    eventAt(source.events[0]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [join(fixture.firstWorktree, "a.ts")]),
    eventAt(source.events[1]!, fixture.secondWorktree, join(fixture.secondWorktree, "a.ts"), [join(fixture.secondWorktree, "a.ts")]),
  ];
  await withGitCounter(directory, async (readCounts) => {
    const result = await associateSource(source, fixture.baseline);
    assert.deepEqual(result.events.map((event) => event.path), ["a.ts", "a.ts"]);
    assert.deepEqual(await readCounts(), { commonDir: 2, worktreeRoot: 2 });
  });
}));

test("相同 remote 的独立 clone 不作为 worktree 关联", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const source = await sourceFixture(fixture.independentClone);
  source.events = [eventAt(source.events[0]!, fixture.independentClone, join(fixture.independentClone, "a.ts"), [])];
  await withGitCounter(directory, async (readCounts) => {
    const result = await associateSource(source, fixture.baseline);
    assert.equal(result.associated, false);
    assert.equal(result.events.length, 0);
    assert.deepEqual(await readCounts(), { commonDir: 1, worktreeRoot: 0 });
  });
}));

test("同一刷新跨来源复用Git归属验证，新刷新仍重新检查", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const first = await sourceFixture(fixture.firstWorktree);
  first.events = [eventAt(first.events[0]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [])];
  const second = { ...first, sourceId: "synthetic-second-source", events: first.events.map(event => ({ ...event, id: `${event.id}:second` })) };
  await withGitCounter(directory, async (readCounts) => {
    const cache = createSourceAssociationCache();
    assert.equal((await associateSource(first, fixture.baseline, [], cache)).events.length, 1);
    assert.equal((await associateSource(second, fixture.baseline, [], cache)).events.length, 1);
    assert.deepEqual(await readCounts(), { commonDir: 1, worktreeRoot: 1 });
    await git(fixture.gitPath, ["-C", fixture.repository, "worktree", "remove", "--force", fixture.firstWorktree]);
    await git(fixture.gitPath, ["clone", fixture.repository, fixture.firstWorktree]);
    assert.equal((await associateSource(second, fixture.baseline, [], createSourceAssociationCache())).events.length, 0);
    assert.deepEqual(await readCounts(), { commonDir: 2, worktreeRoot: 1 });
  });
}));

test("共享缓存不把一次Git校验失败带到后续来源", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const source = await sourceFixture(fixture.firstWorktree);
  source.events = [eventAt(source.events[0]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [])];
  await withGitCounter(directory, async (readCounts) => {
    await writeFile(join(directory, "bin", "git"), [
      "#!/bin/sh",
      "if [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"--show-toplevel\" ]; then printf 'root\\n' >> \"$MANOR_ASSOC_COUNTER\"; fi",
      "if [ \"$3\" = \"rev-parse\" ] && [ \"$4\" = \"--path-format=absolute\" ]; then",
      "  printf 'common\\n' >> \"$MANOR_ASSOC_COUNTER\"",
      "  if [ ! -e \"$MANOR_ASSOC_COUNTER.failed\" ]; then : > \"$MANOR_ASSOC_COUNTER.failed\"; exit 1; fi",
      "fi",
      "exec \"$MANOR_ASSOC_REAL_GIT\" \"$@\"",
      "",
    ].join("\n"));
    const cache = createSourceAssociationCache();
    assert.equal((await associateSource(source, fixture.baseline, [], cache)).events.length, 0);
    assert.equal((await associateSource(source, fixture.baseline, [], cache)).events.length, 1);
    assert.deepEqual(await readCounts(), { commonDir: 2, worktreeRoot: 1 });
  });
}));

test("跨调用重新核验同一路径的 Git 身份变化", () => temporary(async (directory) => {
  const fixture = await repositoryFixture(directory);
  const source = await sourceFixture(fixture.firstWorktree);
  source.events = [eventAt(source.events[0]!, fixture.firstWorktree, join(fixture.firstWorktree, "a.ts"), [join(fixture.firstWorktree, "a.ts")])];
  await withGitCounter(directory, async (readCounts) => {
    assert.equal((await associateSource(source, fixture.baseline)).associated, true);
    await git(fixture.gitPath, ["-C", fixture.repository, "worktree", "remove", "--force", fixture.firstWorktree]);
    await git(fixture.gitPath, ["clone", fixture.repository, fixture.firstWorktree]);
    const changedIdentity = await associateSource(source, fixture.baseline);
    assert.equal(changedIdentity.associated, false);
    assert.equal(changedIdentity.events.length, 0);
    assert.deepEqual(await readCounts(), { commonDir: 2, worktreeRoot: 1 });
  });
}));
