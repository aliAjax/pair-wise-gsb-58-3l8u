import {
  seedAlerts,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
  seedSnapshots,
  seedSyncBatches,
  seedAuditLogs,
} from "../src/data/seed";
import type { MockDatabase } from "../src/services/mockStorage";

/** 与 mockStorage 的种子库一致，但不依赖浏览器 localStorage */
export const createSeedDatabase = (): MockDatabase => ({
  alerts: structuredClone(seedAlerts),
  cases: structuredClone(seedCases),
  nodes: structuredClone(seedNodes),
  edges: structuredClone(seedEdges),
  evidence: structuredClone(seedEvidence),
  conclusions: structuredClone(seedConclusions),
  snapshots: structuredClone(seedSnapshots),
  syncBatches: structuredClone(seedSyncBatches),
  auditLogs: structuredClone(seedAuditLogs),
});
