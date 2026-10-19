import type { Command } from "commander";
import type { CliContext } from "./context.js";

/** 帮助只补充使用契约，不改变解析、默认值及 HTTP 请求。 */
export function configureGuidance(program: Command, context: CliContext): void {
  const visit = (command: Command, parents: string[]) => {
    const path = [...parents, command.name()].filter(Boolean), name = path.slice(1).join(" ");
    for (const option of command.options) {
      const key = option.attributeName();
      if (option.description === context.t("cli.ext.option", { name: key })) option.description = context.t(`cli.guide.option.${key}`);
    }
    const guide = guides[name];
    if (guide) command.addHelpText("after", `\n${context.t(`cli.guide.${guide.key}`)}\n\n${guide.examples.map(example => `  am ${example}`).join("\n")}\n`);
    for (const child of command.commands) visit(child, path);
  };
  visit(program, []);
}

const guides: Record<string, { key: string; examples: string[] }> = {
  "update": { key: "update", examples: ["update --check --json", "update --dry-run --json", "update --to 0.2.0 --yes --wait --json"] },
  "update settings set": { key: "update", examples: ["update settings set --data '{\"autoCheck\":false}' --json", "update settings set --data '{\"ignoredVersion\":null}' --json"] },
  "sessions list": { key: "sessions", examples: ["sessions list --client codex --page-size 5 --json"] },
  "sessions search": { key: "sessions", examples: ['sessions search "cache" --mode keyword --page-size 5 --json'] },
  "sessions messages": { key: "messages", examples: ["sessions messages <sessionId> --version <version> --mode brief --page-size 5 --json", "sessions messages <sessionId> --version <version> --mode full --message-id <messageId> --text-offset <nextTextOffset> --json"] },
  "sessions profile": { key: "profile", examples: ["sessions profile <sessionId> --section steps --step-limit 10 --step-offset 0 --json"] },
  "knowledge write": { key: "write", examples: ['knowledge write --data \'{"title":"Cache validation","body":"Read again after updates.","scope":{"kind":"global"},"language":"en","sources":[{"kind":"agent"}]}\' --json'] },
  "knowledge revise": { key: "revise", examples: ["knowledge revise <entryId> --input revision.json --json"] },
  "knowledge restore": { key: "restore", examples: ['knowledge restore <entryId> --data \'{"revisionId":"<historicalRevisionId>","baseRevisionId":"<latestRevisionId>"}\' --json'] },
  "knowledge search": { key: "read", examples: ['knowledge search "cache" --mode keyword --review reviewed --page-size 5 --json'] },
  "knowledge get": { key: "read", examples: ["knowledge get <entryId> --review all --availability all --json"] },
  "knowledge review": { key: "review", examples: ["knowledge review <entryId> <latestRevisionId> approve --json"] },
  "knowledge availability": { key: "availability", examples: ["knowledge availability <entryId> deprecated --reason outdated --json"] },
  "knowledge extraction preview": { key: "extraction", examples: ["knowledge extraction preview --input extraction-preview.json --json"] },
  "knowledge extraction start": { key: "startExtraction", examples: ["knowledge extraction start <previewId> --wait --timeout 300 --json"] },
  "knowledge extraction get": { key: "job", examples: ["knowledge extraction get <jobId> --json", "knowledge extraction get <jobId> --full --json"] },
  "knowledge settings set": { key: "knowledgeSettings", examples: ["knowledge settings get --json", "knowledge settings set --input settings.json --json"] },
  "knowledge settings try": { key: "try", examples: ["knowledge settings try --input try.json --json"] },
  "semantic settings set": { key: "semanticSettings", examples: ["semantic settings get --json", "semantic settings set --input semantic-settings.json --json"] },
  "semantic test": { key: "semanticTest", examples: ["semantic test --input connection-test.json --json"] },
  "semantic preview": { key: "semanticPreview", examples: ['semantic preview --data \'{}\' --json'] },
  "semantic search": { key: "semanticSearch", examples: ["semantic search --input semantic-search.json --json"] },
  "usage report": { key: "usage", examples: ['usage report --clients \'["codex"]\' --group-by model --page-size 5 --json'] },
  "usage requests": { key: "requests", examples: ["usage requests --session-id <sessionId> --version <version> --price-version <priceVersion> --request-page 1 --request-page-size 20 --json"] },
  "usage pricing set": { key: "pricing", examples: ['usage pricing set --data \'{"overrides":[{"model":"example-model","input":1,"output":2}],"mappings":[]}\' --json'] },
  "overview panel": { key: "overview", examples: ["overview panel --window 30 --panel core --json", "overview panel --window 30 --panel distribution --dimension project --json"] },
  "overview detail": { key: "detail", examples: ['overview detail --window 30 --detail \'{"view":"resources","page":1,"pageSize":5}\' --json'] },
  "overview review-detail": { key: "detail", examples: ['overview review-detail --detail \'{"kind":"sessions","page":1,"pageSize":5}\' --json'] },
  "overview evidence": { key: "detail", examples: ['overview evidence --evidence \'{"kind":"requests","page":1,"pageSize":5}\' --json'] },
  "resources detail": { key: "resourceIds", examples: ["resources detail <bodyId> --view local --json"] },
  "resources preview": { key: "resourceManagement", examples: ["resources preview disable --entry-id <entryId> --json"] },
  "repositories replay-evidence": { key: "replay", examples: ["repositories replay-evidence <repositoryId> --version <repositoryVersion> --session-version <sessionVersion> --session-id <sessionId> --event-id <eventId> --json"] },
  "preferences set": { key: "preferences", examples: ['preferences set --data \'{"language":"en"}\' --json'] },
};
