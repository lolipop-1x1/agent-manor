import { Worker } from "node:worker_threads";
import type { ServiceInstance } from "../contracts.js";

/** 独立控制线程不访问数据库，主线程阻塞时仍可核验身份并接收停止请求。 */
export async function startServiceControl(instance: ServiceInstance, stop: () => void): Promise<{ port: number; stop(): void; close(): Promise<void> }> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const url = new URL(`./control-worker.${extension}`, import.meta.url);
  const options = { workerData: { instance } };
  const worker = extension === "ts"
    ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { ...options, eval: true })
    : new Worker(url, options);
  let closed = false;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", code => { if (!closed) reject(new Error(`Service control exited (${code})`)); });
      worker.on("message", (message: { port?: number; stop?: boolean }) => {
        if (message.port) resolve(message.port);
        if (message.stop) stop();
      });
    });
    return { port, stop() { worker.postMessage("stop"); }, async close() { closed = true; await worker.terminate(); } };
  } catch (error) { closed = true; await worker.terminate(); throw error; }
}
