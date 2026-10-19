import { availableParallelism, totalmem } from "node:os";

const MiB = 1024 ** 2;
interface Capacity { cpus: number; totalBytes: number; availableBytes: number }

/** 每轮固定并发上限，为写入者和其他本地程序留出 CPU、内存；少量来源直接解析。 */
export function importConcurrency(sources: number, capacity: Capacity = {
  cpus: availableParallelism(), totalBytes: totalmem(), availableBytes: process.availableMemory(),
}): number {
  if (sources < 8) return 1;
  const cpuLimit = Math.floor(capacity.cpus / 2);
  const machineLimit = Math.floor(capacity.totalBytes / (2048 * MiB));
  const availableLimit = Math.floor((capacity.availableBytes - 512 * MiB) / (256 * MiB));
  return Math.max(1, Math.min(4, cpuLimit, machineLimit, availableLimit));
}
