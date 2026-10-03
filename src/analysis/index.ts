export { BASELINE_RULE_VERSION, classifyFile, getRepository, hashContent, scanRepository, textLines } from "./baseline.js";
export { characterDifference, mappingCacheKey, MATCHING_LIMITS, MATCHING_RULE_VERSION, matchEvent } from "./matching.js";
export type { CharacterDifference } from "./matching.js";
export { buildCoverage, eventFilePaths, filterEvents, getHotspots, getUnreadFiles } from "./coverage.js";
export { countRangeLines, mergeRanges, subtractRanges } from "./ranges.js";
