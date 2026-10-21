import { createServer } from "node:http";
import { parentPort, workerData } from "node:worker_threads";
import type { ServiceInstance } from "../contracts.js";

if (!parentPort) throw new Error("Service control requires a Worker");
const port = parentPort;
const { instance } = workerData as { instance: ServiceInstance };
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  // 只终止承载本线程的当前进程，不使用磁盘记录里的 PID；未提交事务由 SQLite 回滚。
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 2000);
  port.postMessage({ stop: true });
}
port.on("message", message => { if (message === "stop") stop(); });
const server = createServer((request, reply) => {
  reply.setHeader("Content-Type", "application/json");
  reply.setHeader("Cache-Control", "no-store");
  const address = server.address();
  if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`
    || request.headers.origin || request.headers["sec-fetch-site"] || request.headers["x-agent-manor-instance"] !== instance.id) {
    reply.writeHead(403).end("{}"); return;
  }
  if (request.url === "/status" && request.method === "GET") {
    reply.end(JSON.stringify({ instance, stopping })); return;
  }
  if (request.url !== "/stop" || request.method !== "POST") { reply.writeHead(404).end("{}"); return; }
  reply.end(JSON.stringify({ instance, stopping: true }));
  stop();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service control has no address");
  port.postMessage({ port: address.port });
});
