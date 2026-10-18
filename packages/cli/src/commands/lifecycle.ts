import type { Command } from "commander";
import { spawn } from "node:child_process";
import { startService } from "../../../../src/server.js";
import { connectService, dataHome, serviceUrl, startBackground, stopService, serviceStatus, waitForPreparation, serviceLogPath, readServiceLogs, delay } from "../../../../src/service/runtime.js";
import { VERSION, API_VERSION } from "../../../../src/version.js";
import { logDelta } from "../output/logs.js";
import { timeoutMilliseconds } from "../api/tasks.js";
import type { CliContext, Options } from "../context.js";
import { installationChecks } from "../runtime/doctor.js";
import { updateProduct } from "../runtime/update.js";
const homeFor = (command: Command) => dataHome(command.optsWithGlobals<Options>().home as string | undefined);
export function registerLifecycle(program: Command, context: CliContext): void {
  for (const name of ["start", "restart"]) context.waiting(program.command(name).description(context.t(`cli.ext.${name}`)))
    .option("--port <number>", context.t("cli.port")).option("--wait-data", context.t("cli.ext.waitData"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), home = homeFor(command);
      if (name === "restart") await stopService(home, { wait: opts.wait === true, timeoutMs: timeoutMilliseconds(opts.timeout) });
      const instance = await startBackground(home, { port: opts.port === undefined ? undefined : Number(opts.port), waitData: opts.waitData === true, timeoutMs: timeoutMilliseconds(opts.timeout) });
      context.output(command, { instance, version: instance.version ?? VERSION, url: serviceUrl(instance), logPath: serviceLogPath(home) });
    });
  program.command("serve").description(context.t("cli.serve")).option("--port <number>", context.t("cli.port"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      const service = await startService({ home: homeFor(command), port: opts.port === undefined ? undefined : Number(opts.port) });
      context.output(command, { instance: service.instance, url: serviceUrl(service.instance) });
      const shutdown = () => { void service.close(); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    });
  program.command("status").description(context.t("cli.status")).action(async (_opts, command: Command) => {
    const value = await serviceStatus(homeFor(command));
    // 保留原有顶层字段，新增生命周期信息不改变既有脚本的读取路径。
    context.output(command, command.optsWithGlobals<Options>().json ? { ...value.status, ...value } : value);
  });
  context.waiting(program.command("stop").description(context.t("cli.stop")))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      const result = await stopService(homeFor(command), { wait: opts.wait === true, timeoutMs: timeoutMilliseconds(opts.timeout) });
      context.output(command, { stopping: result.stopped, running: false, ...result });
    });
  context.waiting(program.command("ready").description(context.t("cli.ext.ready")))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), instance = await connectService(true, homeFor(command));
      context.output(command, await waitForPreparation(instance!, timeoutMilliseconds(opts.timeout)));
    });
  program.command("version").description(context.t("cli.version")).action((_opts, command: Command) => { context.output(command, { version: VERSION, apiVersion: API_VERSION, node: process.versions.node, platform: process.platform, arch: process.arch }); });
  context.waiting(program.command("update").description(context.t("cli.ext.update"))).option("--check", context.t("cli.ext.updateCheck")).option("--to <version>", context.t("cli.ext.updateTo"))
    .action(async (_opts, command: Command) => { const opts = command.optsWithGlobals<Options>(); context.output(command, await updateProduct({ home: homeFor(command), target: opts.to as string | undefined, check: opts.check === true, wait: opts.wait === true, timeoutMs: timeoutMilliseconds(opts.timeout) })); });
  program.command("doctor").description(context.t("cli.ext.doctor")).action(async (_opts, command: Command) => {
    const checks = installationChecks();
    context.output(command, { version: VERSION, node: process.versions.node, platform: process.platform, arch: process.arch, home: homeFor(command), logPath: serviceLogPath(homeFor(command)), checks, service: await serviceStatus(homeFor(command)) });
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
  program.command("web").description(context.t("cli.web")).option("--no-open", context.t("cli.noOpen"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(), instance = (await connectService(true, homeFor(command)))!, url = serviceUrl(instance);
      if (opts.open !== false) {
        const application = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const child = spawn(application, [url], { stdio: "ignore", detached: true });
        child.on("error", () => { /* 地址仍可手动打开。 */ }); child.unref();
      }
      context.output(command, { instance, url });
    });
}
