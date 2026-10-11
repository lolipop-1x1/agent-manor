import type { OverviewSource } from "../overview-contracts.js";
import type { SessionStore } from "../sessions/store.js";

export function loadOverviewSource(store: SessionStore, version?: string): OverviewSource {
  return store.overviewSource(version);
}
