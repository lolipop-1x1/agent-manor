import type { Command } from "commander";
import { spawn } from "node:child_process";
import { startService } from "../../../../src/server.js";
import { connectService, dataHome, serviceUrl, startBackground, stopService, serviceStatus, waitForPreparation, serviceLogPath, readServiceLogs, delay, validateServicePort } from "../../../../src/service/runtime.js";
import { VERSION, API_VERSION } from "../../../../src/version.js";
import { logDelta } from "../output/logs.js";
import { startupProgress } from "../output/startup-progress.js";
import { timeoutMilliseconds } from "../api/tasks.js";
import type { CliContext, Options } from "../context.js";
import { installationChecks } from "../runtime/doctor.js";
import { updateProduct } from "../runtime/update.js";
import { summarizeReady, summarizeStatus } from "../output/summary.js";
const homeFor = (command: Command) => dataHome(command.optsWithGlobals<Options>().home as string | undefined);
function portFor(options: Options): number | undefined {
  const port = options.port === undefined ? undefined : typeof options.port === "string" && !options.port.trim() ? NaN : Number(options.port);
  validateServicePort(port);
  return port;
}
export function registerLifecycle(program: Command, context: CliContext): void {
  const startupWaiting = (command: Command) => command.option("--wait", context.t("cli.ext.waitData"))
    .option("--timeout <seconds>", context.t("cli.startup.timeout"));
  for (const name of ["start", "restart"]) startupWaiting(program.command(name).description(context.t(`cli.ext.${name}`)))
    .option("--port <number>", context.t("cli.port")).option("--wait-data", context.t("cli.ext.waitData"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), home = homeFor(command), port = portFor(opts), timeoutMs = opts.timeout === undefined ? undefined : timeoutMilliseconds(opts.timeout);
      if (name === "restart") await stopService(home, { wait: opts.wait === true, timeoutMs });
      const progress = opts.json ? undefined : startupProgress(context.language);
      try {
        const instance = await startBackground(home, { port, waitData: opts.waitData === true || opts.wait === true ? true : "initial", timeoutMs, onProgress: progress?.update });
        context.output(command, { instance, version: instance.version ?? VERSION, url: serviceUrl(instance), logPath: serviceLogPath(home) });
      } finally { progress?.close(); }
    });
  program.command("serve").description(context.t("cli.serve")).option("--port <number>", context.t("cli.port"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      const service = await startService({ home: homeFor(command), port: portFor(opts) });
      context.output(command, { instance: service.instance, url: serviceUrl(service.instance) });
      const shutdown = () => { void service.close(); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    });
  program.command("status").description(context.t("cli.status")).action(async (_opts, command: Command) => {
    const opts = command.optsWithGlobals<Options>(), value = await serviceStatus(homeFor(command), { summary: opts.full !== true });
    // 完整模式保留旧脚本字段，日常查询只保留一份状态摘要。
    context.output(command, opts.full ? opts.json ? { ...value.status, ...value } : value : summarizeStatus(value));
  });
  context.waiting(program.command("stop").description(context.t("cli.stop")))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      const result = await stopService(homeFor(command), { wait: opts.wait === true, timeoutMs: timeoutMilliseconds(opts.timeout) });
      context.output(command, opts.full ? { running: false, ...result } : result);
    });
  context.waiting(program.command("ready").description(context.t("cli.ext.ready")))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), timeoutMs = timeoutMilliseconds(opts.timeout);
      const instance = await connectService(true, homeFor(command));
      const progress = opts.json ? undefined : startupProgress(context.language);
      try {
        const value = await waitForPreparation(instance!, timeoutMs, { summary: opts.full !== true, onProgress: progress?.update });
        context.output(command, opts.full ? value : summarizeReady(value));
      } finally { progress?.close(); }
    });
  program.command("version").description(context.t("cli.version")).action((_opts, command: Command) => { context.output(command, { version: VERSION, apiVersion: API_VERSION, node: process.versions.node, platform: process.platform, arch: process.arch }); });
  context.waiting(program.command("update").description(context.t("cli.ext.update"))).option("--check", context.t("cli.ext.updateCheck")).option("--to <version>", context.t("cli.ext.updateTo"))
    .action(async (_opts, command: Command) => { const opts = command.optsWithGlobals<Options>(); context.output(command, await updateProduct({ home: homeFor(command), target: opts.to as string | undefined, check: opts.check === true, wait: opts.wait === true, timeoutMs: timeoutMilliseconds(opts.timeout) })); });
  program.command("doctor").description(context.t("cli.ext.doctor")).action(async (_opts, command: Command) => {
    const checks = installationChecks(), opts = command.optsWithGlobals<Options>();
    const service = await serviceStatus(homeFor(command), { summary: opts.full !== true });
    context.output(command, { version: VERSION, node: process.versions.node, platform: process.platform, arch: process.arch, home: homeFor(command), logPath: serviceLogPath(homeFor(command)), checks, service: opts.full ? service : summarizeStatus(service) });
    if (checks.some(check => !check.ok)) process.exitCode = 1;
  });
  program.command("logs").description(context.t("cli.ext.logs")).option("--lines <number>", context.t("cli.ext.lines")).option("--follow", context.t("cli.ext.follow"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(); let last = "";
      for (;;) {
        const result = await readServiceLogs(homeFor(command), { lines: opts.lines === undefined ? 100 : Number(opts.lines) });
        const text = result.text;
        if (!opts.follow) { context.output(command, result); return; }
        if (text !== last) {
          const delta = logDelta(last, text);
          context.output(command, { path: result.path, ...delta, follow: true });
          last = text;
        }
        await delay(500);
      }
    });
  startupWaiting(program.command("web").description(context.t("cli.web"))).option("--no-open", context.t("cli.noOpen"))
    .option("--wait-data", context.t("cli.ext.waitData"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), timeoutMs = opts.timeout === undefined ? undefined : timeoutMilliseconds(opts.timeout);
      const progress = opts.json ? undefined : startupProgress(context.language);
      let instance;
      try { instance = await startBackground(homeFor(command), { waitData: opts.waitData === true || opts.wait === true ? true : "initial", timeoutMs, onProgress: progress?.update }); }
      finally { progress?.close(); }
      const url = serviceUrl(instance);
      if (opts.open !== false) {
        const application = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const child = spawn(application, [url], { stdio: "ignore", detached: true });
        child.on("error", () => { /* 地址仍可手动打开。 */ }); child.unref();
      }
      context.output(command, { instance, url });
    });
}
