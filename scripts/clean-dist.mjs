import { rm } from "node:fs/promises";

// 以脚本位置定位构建目录，避免从其他工作目录调用时误删文件。
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
