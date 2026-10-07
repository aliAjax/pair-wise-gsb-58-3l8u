import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
  seedSnapshots,
  seedSyncBatches,
} from "../data/seed";
import type {
  Alert,
  AuditLog,
  ConclusionSnapshot,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
  SyncBatch,
} from "../models/types";
import { createId, nowIso } from "./id";

export interface MockDatabase {
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  snapshots: ConclusionSnapshot[];
  syncBatches: SyncBatch[];
  auditLogs: AuditLog[];
}

const STORAGE_KEY = "bank-fraud-investigation-db-v1";

const createSeedDatabase = (): MockDatabase => ({
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

/** 兼容旧版本 localStorage：补齐新增集合与案件 revision */
const migrateDatabase = (raw: MockDatabase): MockDatabase => {
  const database = raw as MockDatabase;
  database.snapshots = Array.isArray(database.snapshots)
    ? database.snapshots
    : [];
  database.syncBatches = Array.isArray(database.syncBatches)
    ? database.syncBatches
    : [];
  database.cases = database.cases.map((item) => ({
    ...item,
    status: item.status,
    revision: typeof item.revision === "number" ? item.revision : 1,
  }));
  database.auditLogs = database.auditLogs.map((item) => ({ ...item }));

  // 旧版本审计日志没有案件状态列：按留痕时间就近取案件当前状态作为展示兜底
  const withoutStatus = database.auditLogs.filter(
    (item) => item.caseId && !item.caseStatus,
  );
  if (withoutStatus.length > 0) {
    withoutStatus.forEach((log) => {
      const caseRecord = database.cases.find((item) => item.id === log.caseId);
      if (caseRecord) {
        log.caseStatus = caseRecord.status;
      }
    });
  }
  return database;
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    const seeded = createSeedDatabase();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }

  try {
    return migrateDatabase(JSON.parse(stored) as MockDatabase);
  } catch {
    const seeded = createSeedDatabase();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    return seeded;
  }
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }
};

export const resetDatabase = (): MockDatabase => {
  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  return seeded;
};

export { createId, nowIso } from "./id";

export const appendAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at">,
): void => {
  database.auditLogs.unshift({
    id: createId("LOG"),
    at: nowIso(),
    ...log,
  });
};
