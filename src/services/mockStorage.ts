import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
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
import {
  computeTimelineVersion,
  freezeEdge,
  freezeEvidence,
  freezeNode,
} from "./snapshot";

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

const STORAGE_KEY = "bank-fraud-investigation-db-v2";
const LEGACY_STORAGE_KEY = "bank-fraud-investigation-db-v1";

const createSeedDatabase = (): MockDatabase => {
  const database: MockDatabase = {
    alerts: structuredClone(seedAlerts),
    cases: structuredClone(seedCases),
    nodes: structuredClone(seedNodes),
    edges: structuredClone(seedEdges),
    evidence: structuredClone(seedEvidence),
    conclusions: structuredClone(seedConclusions),
    snapshots: [],
    syncBatches: [],
    auditLogs: structuredClone(seedAuditLogs),
  };
  migrateLegacySnapshots(database);
  return database;
};

/**
 * 旧数据迁移：快照功能上线前已提交/已复核的结论没有固化记录，
 * 先统一标记为待核（pending_backfill）。补录前不允许重新提交结论。
 */
export function migrateLegacySnapshots(database: MockDatabase): void {
  if (!database.snapshots) {
    database.snapshots = [];
  }
  if (!database.syncBatches) {
    database.syncBatches = [];
  }
  database.conclusions.forEach((conclusion) => {
    if (conclusion.status === "draft") {
      return;
    }
    const exists = database.snapshots.some(
      (item) => item.conclusionId === conclusion.id,
    );
    if (exists) {
      return;
    }
    const caseNodes = database.nodes.filter(
      (item) => item.caseId === conclusion.caseId,
    );
    const caseEdges = database.edges.filter(
      (item) => item.caseId === conclusion.caseId,
    );
    const caseEvidence = database.evidence.filter(
      (item) => item.caseId === conclusion.caseId,
    );
    const targetCase = database.cases.find(
      (item) => item.id === conclusion.caseId,
    );
    const snapshot: ConclusionSnapshot = {
      id: `SNAP-LEGACY-${conclusion.id}`,
      caseId: conclusion.caseId,
      conclusionId: conclusion.id,
      version: conclusion.version,
      state: "pending_backfill",
      createdAt: conclusion.createdAt,
      baseCaseStatus: targetCase?.status ?? "investigating",
      timelineVersion: computeTimelineVersion({
        evidence: caseEvidence,
        edges: caseEdges,
        alertIds: targetCase?.alertIds ?? [],
      }),
      evidence: caseEvidence.map(freezeEvidence),
      nodes: caseNodes.map(freezeNode),
      edges: caseEdges.map(freezeEdge),
      alertIds: targetCase?.alertIds ?? [],
    };
    database.snapshots.push(snapshot);
    conclusion.snapshotId = snapshot.id;
  });
}

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    // 兼容首次升级：旧库数据原样保留，仅补快照字段
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as MockDatabase;
        migrateLegacySnapshots(parsed);
        writeDatabase(parsed);
        return parsed;
      } catch {
        // 解析失败则回落到种子数据
      }
    }
    const seeded = createSeedDatabase();
    writeDatabase(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(stored) as MockDatabase;
    migrateLegacySnapshots(parsed);
    return parsed;
  } catch {
    const seeded = createSeedDatabase();
    writeDatabase(seeded);
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

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

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
