import { startService } from "../../src/server.js";
import { isolatedHistoryRoots } from "./history-roots.js";
const home = process.argv[2]!;
const service = await startService({ home, port: 0, startupRefresh: false, noUpdateCheck: true,
  roots: isolatedHistoryRoots({ codex: process.argv[3]! }), resourceInventory: { userHome: home, environment: {} } });
process.send!({ ready: service.instance });
process.on("message", () => { void service.close().then(() => process.disconnect()); });
