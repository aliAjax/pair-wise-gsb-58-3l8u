import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AuditLog,
  CaseDisposition,
  CaseStatus,
  ConclusionSnapshot,
  ConclusionVersion,
  DashboardSummary,
  Evidence,
  ImpactReview,
  InvestigationCase,
  InvestigationNode,
  MergeConflict,
  MergeConflictResolution,
  OfflineOperation,
  RiskLevel,
  SyncBatch,
  SyncBatchMergeResult,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
  type MockDatabase,
} from "./mockStorage";
import {
  buildImpactReview,
  computeTimelineVersion,
  freezeEdge,
  freezeEvidence,
  freezeNode,
} from "./snapshot";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const CURRENT_ACTOR = "林澜";

export interface AddNodeInput {
  caseId: string;
  node: InvestigationNode;
  relation?: {
    sourceId: string;
    kind: "transfer" | "shared_device" | "shared_ip" | "payee";
    label: string;
    explanation: string;
    amount?: number;
  };
}

export interface QueueOfflineInput {
  caseId: string;
  investigator: string;
  device: string;
  operation: Omit<OfflineOperation, "id" | "caseId" | "investigator" | "createdAt">;
}

const caseTimelineVersion = (
  database: MockDatabase,
  caseId: string,
): string =>
  computeTimelineVersion({
    evidence: database.evidence.filter((item) => item.caseId === caseId),
    edges: database.edges.filter((item) => item.caseId === caseId),
    alertIds:
      database.cases.find((item) => item.id === caseId)?.alertIds ?? [],
  });

const buildBaseline = (database: MockDatabase, caseId: string) => ({
  nodeCount: database.nodes.filter((item) => item.caseId === caseId).length,
  edgeCount: database.edges.filter((item) => item.caseId === caseId).length,
  evidenceCount: database.evidence.filter((item) => item.caseId === caseId)
    .length,
  timelineVersion: caseTimelineVersion(database, caseId),
});

/**
 * 线索变更联动：提交后的结论快照一旦发现所依据的证据、图谱关系
 * 或关联告警发生变化，快照即失效，案件进入待复议；原裁定不被
 * 覆盖，仍然有效，直到重新提交或影响复查确认无实质变更。
 * 节点拖动只改布局，不调用本函数。
 */
const invalidateSnapshots = (
  database: MockDatabase,
  caseId: string,
  reason: string,
): string[] => {
  const affected: ConclusionSnapshot[] = database.snapshots.filter(
    (item) => item.caseId === caseId && item.state === "current",
  );
  if (affected.length === 0) {
    return [];
  }
  affected.forEach((snapshot) => {
    snapshot.state = "stale";
  });
  const targetCase = database.cases.find((item) => item.id === caseId);
  if (targetCase && targetCase.status !== "reconsider") {
    targetCase.status = "reconsider";
    targetCase.updatedAt = nowIso();
  }
  appendAudit(database, {
    caseId,
    actor: "系统",
    action: "结论快照失效",
    detail: `${reason}，影响 ${affected.length} 份已提交结论，案件转入待复议；原裁定继续有效。`,
  });
  return affected.map((item) => item.id);
};

const createSnapshot = (
  database: MockDatabase,
  caseId: string,
  conclusion: ConclusionVersion,
  baseCaseStatus: CaseStatus,
): ConclusionSnapshot => {
  const nodes = database.nodes.filter((item) => item.caseId === caseId);
  const edges = database.edges.filter((item) => item.caseId === caseId);
  const evidence = database.evidence.filter(
    (item) => item.caseId === caseId,
  );
  const targetCase = database.cases.find((item) => item.id === caseId);
  const snapshot: ConclusionSnapshot = {
    id: createId("SNAP"),
    caseId,
    conclusionId: conclusion.id,
    version: conclusion.version,
    state: "current",
    createdAt: nowIso(),
    baseCaseStatus,
    timelineVersion: computeTimelineVersion({
      evidence,
      edges,
      alertIds: targetCase?.alertIds ?? [],
    }),
    evidence: evidence.map(freezeEvidence),
    nodes: nodes.map(freezeNode),
    edges: edges.map(freezeEdge),
    alertIds: targetCase?.alertIds ?? [],
  };
  database.snapshots.unshift(snapshot);
  conclusion.snapshotId = snapshot.id;
  return snapshot;
};

const hasPendingBackfill = (
  database: MockDatabase,
  caseId: string,
): boolean =>
  database.snapshots.some(
    (item) => item.caseId === caseId && item.state === "pending_backfill",
  );

/* ---------------- 离线合并 ---------------- */

const normalizeText = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const slug = (value: string): string =>
  value.replace(/[^a-zA-Z0-9一-鿿]/g, "_").slice(0, 24);

interface EvidencePayload {
  title: string;
  source: string;
  strength: Evidence["strength"];
  occurredAt: string;
  attachment: string;
  note: string;
}

interface NodePayload {
  sourceId: string;
  label: string;
  kind: InvestigationNode["data"]["kind"];
  riskLevel: RiskLevel;
  evidenceStrength: Evidence["strength"];
  source: string;
  occurredAt: string;
  note: string;
  relationLabel: string;
  relationExplanation: string;
  amount?: number;
}

const baselineSummary = (batch: SyncBatch): string =>
  `基线 ${batch.baseline.nodeCount} 节点 / ${batch.baseline.edgeCount} 关系 / ${batch.baseline.evidenceCount} 证据 @${batch.baseline.timelineVersion.slice(0, 6)}`;

const detectConflicts = (
  database: MockDatabase,
  batch: SyncBatch,
  otherBatches: SyncBatch[],
): MergeConflict[] => {
  const conflicts: MergeConflict[] = [];
  const remoteEvidence = database.evidence.filter(
    (item) =>
      item.caseId === batch.caseId &&
      item.submittedBy !== batch.investigator,
  );

  batch.operations.forEach((op) => {
    if (op.type === "add_evidence") {
      const payload = op.payload as unknown as EvidencePayload;
      const titleKey = normalizeText(payload.title);
      const remoteHit = remoteEvidence.find(
        (item) => normalizeText(item.title) === titleKey,
      );
      const remoteOp = otherBatches.flatMap((item) => item.operations).find(
        (other) =>
          other.type === "add_evidence" &&
          normalizeText(
            (other.payload as unknown as EvidencePayload).title,
          ) === titleKey,
      );
      if (remoteHit) {
        conflicts.push({
          key: `evidence:${titleKey}`,
          kind: "evidence",
          label: payload.title,
          local: {
            investigator: batch.investigator,
            device: batch.device,
            summary: `${payload.source} · ${payload.strength} · ${payload.attachment}`,
          },
          remote: {
            investigator: remoteHit.submittedBy,
            summary: `已并入主库：${remoteHit.source} · V${remoteHit.version}`,
          },
          localBaselineSummary: baselineSummary(batch),
          remoteBaselineSummary: "主库当前版本",
        });
      } else if (remoteOp) {
        const remoteBatch = otherBatches.find((item) =>
          item.operations.some((other) => other.id === remoteOp.id),
        )!;
        const remotePayload = remoteOp.payload as unknown as EvidencePayload;
        conflicts.push({
          key: `evidence:${titleKey}`,
          kind: "evidence",
          label: payload.title,
          local: {
            investigator: batch.investigator,
            device: batch.device,
            summary: `${payload.source} · ${payload.strength}`,
          },
          remote: {
            investigator: remoteOp.investigator,
            summary: `${remotePayload.source} · ${remotePayload.strength}（尚未并入）`,
          },
          localBaselineSummary: baselineSummary(batch),
          remoteBaselineSummary: baselineSummary(remoteBatch),
        });
      }
    }

    if (op.type === "add_node" || op.type === "add_relation") {
      const payload = op.payload as unknown as NodePayload;
      const relationKey = `${payload.sourceId}->${normalizeText(payload.label)}`;
      const remoteNodes = database.nodes.filter(
        (item) => item.caseId === batch.caseId,
      );
      const remoteNodeHit = remoteNodes.find(
        (item) => normalizeText(item.data.label) === normalizeText(payload.label),
      );
      if (remoteNodeHit) {
        conflicts.push({
          key: `relation:${relationKey}`,
          kind: "relation",
          label: `${payload.relationLabel || payload.label}（${payload.sourceId} → ${payload.label}）`,
          local: {
            investigator: batch.investigator,
            device: batch.device,
            summary: payload.relationExplanation,
          },
          remote: {
            investigator: "另一调查员",
            summary: `主库已存在节点 ${remoteNodeHit.data.label} 及其关系`,
          },
          localBaselineSummary: baselineSummary(batch),
          remoteBaselineSummary: "主库当前版本",
        });
      }
    }
  });

  const seen = new Set<string>();
  return conflicts.filter((item) => {
    if (seen.has(item.key)) {
      return false;
    }
    seen.add(item.key);
    return true;
  });
};

const applyOperation = (
  database: MockDatabase,
  batch: SyncBatch,
  op: OfflineOperation,
  suffixWithInvestigator = false,
): void => {
  const opSlug = slug(op.id);
  if (op.type === "add_evidence") {
    const payload = op.payload as unknown as EvidencePayload;
    const evidence: Evidence = {
      id: `EV-OFF-${opSlug}`,
      caseId: op.caseId,
      title: suffixWithInvestigator
        ? `${payload.title}（${op.investigator} 副本）`
        : payload.title,
      source: payload.source,
      strength: payload.strength,
      occurredAt: payload.occurredAt,
      submittedAt: nowIso(),
      submittedBy: op.investigator,
      attachment: payload.attachment,
      note: payload.note,
      version: 1,
    };
    database.evidence.unshift(evidence);
    appendAudit(database, {
      caseId: op.caseId,
      actor: op.investigator,
      action: "离线合并登记证据",
      detail: `${evidence.title} 由离线批次 ${batch.id} 并入。`,
    });
  }

  if (op.type === "add_node" || op.type === "add_relation") {
    const payload = op.payload as unknown as NodePayload;
    const label = suffixWithInvestigator
      ? `${payload.label}（${op.investigator} 副本）`
      : payload.label;
    const node: InvestigationNode = {
      id: `NODE-OFF-${opSlug}`,
      caseId: op.caseId,
      position: { x: 420, y: 240 },
      data: {
        label,
        kind: payload.kind,
        riskLevel: payload.riskLevel,
        note: payload.note,
        evidenceStrength: payload.evidenceStrength,
        source: payload.source,
        occurredAt: payload.occurredAt,
      },
    };
    database.nodes.push(node);
    database.edges.push({
      id: `EDGE-OFF-${opSlug}`,
      caseId: op.caseId,
      source: payload.sourceId,
      target: node.id,
      kind: "transfer",
      label: suffixWithInvestigator
        ? `${payload.relationLabel}（${op.investigator} 副本）`
        : payload.relationLabel,
      amount: payload.amount,
      occurredAt: payload.occurredAt,
      explanation: payload.relationExplanation,
    });
    appendAudit(database, {
      caseId: op.caseId,
      actor: op.investigator,
      action: "离线合并图谱线索",
      detail: `${label} 与关系 ${payload.relationLabel} 由离线批次 ${batch.id} 并入。`,
    });
  }
};

export const bankApi = createApi({
  reducerPath: "bankApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Alerts", "Cases", "Case", "Audit", "Dashboard"],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        const activeCases = database.cases.filter(
          (item) => item.status !== "closed",
        );
        const caseStatusCounts: DashboardSummary["caseStatusCounts"] = {
          investigating: 0,
          pending_review: 0,
          supplement: 0,
          reconsider: 0,
          closed: 0,
        };
        const riskCounts: DashboardSummary["riskCounts"] = {
          high: 0,
          medium: 0,
          low: 0,
        };

        database.cases.forEach((item) => {
          caseStatusCounts[item.status] += 1;
          riskCounts[item.riskLevel] += 1;
        });

        return {
          data: {
            newAlerts: database.alerts.filter((item) => item.status === "new")
              .length,
            highRiskAlerts: database.alerts.filter(
              (item) => item.riskLevel === "high",
            ).length,
            activeCases: activeCases.length,
            pendingReview: database.cases.filter((item) =>
              ["pending_review", "supplement", "reconsider"].includes(
                item.status,
              ),
            ).length,
            totalExposure: database.alerts.reduce(
              (sum, item) => sum + item.amount,
              0,
            ),
            caseStatusCounts,
            riskCounts,
          },
        };
      },
      providesTags: ["Dashboard"],
    }),
    getAlerts: builder.query<Alert[], AlertFilters>({
      queryFn: async (filters) => {
        await wait();
        const database = readDatabase();
        const keyword = filters.keyword.trim().toLowerCase();
        const items = database.alerts.filter((item) => {
          const matchesKeyword =
            !keyword ||
            [
              item.id,
              item.title,
              item.account,
              item.counterparty,
              item.deviceId,
              item.ip,
              ...item.tags,
            ]
              .join(" ")
              .toLowerCase()
              .includes(keyword);
          const matchesRisk =
            filters.riskLevel === "all" ||
            item.riskLevel === filters.riskLevel;
          const matchesStatus =
            filters.status === "all" || item.status === filters.status;
          const matchesChannel =
            !filters.channel || item.channel === filters.channel;
          return (
            matchesKeyword && matchesRisk && matchesStatus && matchesChannel
          );
        });
        return { data: items };
      },
      providesTags: ["Alerts"],
    }),
    getCases: builder.query<InvestigationCase[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().cases };
      },
      providesTags: ["Cases"],
    }),
    getCaseWorkspace: builder.query<
      {
        case: InvestigationCase;
        nodes: InvestigationNode[];
        edges: ReturnType<typeof readDatabase>["edges"];
        evidence: Evidence[];
        conclusions: ConclusionVersion[];
        snapshots: ConclusionSnapshot[];
        syncBatches: SyncBatch[];
        timelineVersion: string;
      },
      string
    >({
      queryFn: async (caseId) => {
        await wait();
        const database = readDatabase();
        const investigationCase = database.cases.find(
          (item) => item.id === caseId,
        );
        if (!investigationCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        return {
          data: {
            case: investigationCase,
            nodes: database.nodes.filter((item) => item.caseId === caseId),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: database.evidence.filter(
              (item) => item.caseId === caseId,
            ),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version),
            snapshots: database.snapshots.filter(
              (item) => item.caseId === caseId,
            ),
            syncBatches: database.syncBatches.filter(
              (item) => item.caseId === caseId,
            ),
            timelineVersion: caseTimelineVersion(database, caseId),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Dashboard",
      ],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit"],
    }),
    linkAlertsToCase: builder.mutation<
      Alert[],
      { alertIds: string[]; caseId: string }
    >({
      queryFn: async ({ alertIds, caseId }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const updated = database.alerts.map((item) =>
          alertIds.includes(item.id)
            ? { ...item, caseId, status: "linked" as const }
            : item,
        );
        const selected = updated.filter((item) => alertIds.includes(item.id));
        targetCase.alertIds = Array.from(
          new Set([...targetCase.alertIds, ...alertIds]),
        );
        targetCase.updatedAt = nowIso();
        database.alerts = updated;
        appendAudit(database, {
          caseId,
          actor: CURRENT_ACTOR,
          action: "批量关联告警",
          detail: `关联告警 ${alertIds.join("、")}。`,
        });
        invalidateSnapshots(database, caseId, "案件关联了新的告警");
        writeDatabase(database);
        return { data: selected };
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: Alert["status"] }
    >({
      queryFn: async ({ alertId, status }) => {
        await wait();
        const database = readDatabase();
        const alert = database.alerts.find((item) => item.id === alertId);
        if (!alert) {
          return { error: { status: "CUSTOM_ERROR", error: "告警不存在" } };
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: CURRENT_ACTOR,
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        writeDatabase(database);
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard"],
    }),
    addGraphNode: builder.mutation<
      InvestigationNode,
      AddNodeInput
    >({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        database.nodes.push(node);
        if (relation) {
          database.edges.push({
            id: createId("E"),
            caseId,
            source: relation.sourceId,
            target: node.id,
            kind: relation.kind,
            label: relation.label,
            amount: relation.amount,
            occurredAt: node.data.occurredAt,
            explanation: relation.explanation,
          });
        }
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: CURRENT_ACTOR,
          action: "加入图谱节点",
          detail: `${node.data.label} 已加入，证据强度 ${node.data.evidenceStrength}。`,
        });
        invalidateSnapshots(
          database,
          caseId,
          `图谱新增节点 ${node.data.label} 与关系`,
        );
        writeDatabase(database);
        return { data: node };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    updateGraphNode: builder.mutation<
      InvestigationNode,
      { caseId: string; node: InvestigationNode }
    >({
      queryFn: async ({ caseId, node }) => {
        await wait(80);
        const database = readDatabase();
        const index = database.nodes.findIndex((item) => item.id === node.id);
        if (index < 0) {
          return { error: { status: "CUSTOM_ERROR", error: "节点不存在" } };
        }
        const before = database.nodes[index];
        database.nodes[index] = { ...database.nodes[index], ...node };
        // 仅布局变化（拖动）不影响结论；内容字段变化才触发复查
        const contentChanged =
          JSON.stringify(before.data) !== JSON.stringify(node.data);
        if (contentChanged) {
          invalidateSnapshots(database, caseId, "图谱节点内容被修改");
        }
        writeDatabase(database);
        return { data: database.nodes[index] };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    addEvidence: builder.mutation<
      Evidence,
      Omit<Evidence, "id" | "submittedAt" | "submittedBy" | "version">
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const evidence: Evidence = {
          ...input,
          id: createId("EV"),
          submittedAt: nowIso(),
          submittedBy: CURRENT_ACTOR,
          version: 1,
        };
        database.evidence.unshift(evidence);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId: input.caseId,
          actor: CURRENT_ACTOR,
          action: "新增证据",
          detail: `${input.title} 已登记，来源为 ${input.source}。`,
        });
        invalidateSnapshots(
          database,
          input.caseId,
          `新增证据 ${input.title}`,
        );
        writeDatabase(database);
        return { data: evidence };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    saveConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        disposition: CaseDisposition;
        rationale: string;
        riskControls: string[];
        submit?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        if (hasPendingBackfill(database, input.caseId)) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "历史结论快照待核：请先在结论页补录快照，补录前不能重新提交结论。",
            },
          };
        }
        if (input.submit) {
          const hasStale = database.snapshots.some(
            (item) =>
              item.caseId === input.caseId && item.state === "stale",
          );
          if (hasStale) {
            // 允许重新提交（会生成新快照），但给出审计留痕
            appendAudit(database, {
              caseId: input.caseId,
              actor: CURRENT_ACTOR,
              action: "失效快照重提结论",
              detail: "调查员基于线索变化重新提交结论，将生成新的结论快照。",
            });
          }
        }
        const existing = database.conclusions.filter(
          (item) => item.caseId === input.caseId,
        );
        const conclusion: ConclusionVersion = {
          id: createId("CV"),
          caseId: input.caseId,
          version:
            existing.reduce((max, item) => Math.max(max, item.version), 0) + 1,
          status: input.submit ? "submitted" : "draft",
          disposition: input.disposition,
          rationale: input.rationale,
          riskControls: input.riskControls,
          createdBy: CURRENT_ACTOR,
          createdAt: nowIso(),
          reviewer: "赵平",
        };
        database.conclusions.unshift(conclusion);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.status = input.submit ? "pending_review" : "investigating";
          targetCase.updatedAt = nowIso();
        }
        if (input.submit) {
          const snapshot = createSnapshot(
            database,
            input.caseId,
            conclusion,
            "pending_review",
          );
          appendAudit(database, {
            caseId: input.caseId,
            actor: CURRENT_ACTOR,
            action: "提交复核并固化快照",
            detail: `${conclusion.id} V${conclusion.version} 已提交；快照 ${snapshot.id} 固化 ${snapshot.evidence.length} 份证据、${snapshot.nodes.length} 个节点、${snapshot.edges.length} 条关系，时间线版本 ${snapshot.timelineVersion}。`,
          });
        } else {
          appendAudit(database, {
            caseId: input.caseId,
            actor: CURRENT_ACTOR,
            action: "保存结论版本",
            detail: `${conclusion.id} V${conclusion.version} 已保存为草稿。`,
          });
        }
        writeDatabase(database);
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    transitionCase: builder.mutation<
      InvestigationCase,
      { caseId: string; status: CaseStatus; reason?: string }
    >({
      queryFn: async ({ caseId, status, reason }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) =>
              item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
        }
        targetCase.status = status;
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor: CURRENT_ACTOR,
          action: "案件状态流转",
          detail: `状态更新为 ${status}${reason ? `，原因：${reason}` : ""}。`,
        });
        writeDatabase(database);
        return { data: targetCase };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    reviewConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        conclusionId: string;
        decision: "approve" | "return";
        reviewerNote: string;
      }
    >({
      queryFn: async ({ caseId, conclusionId, decision, reviewerNote }) => {
        await wait();
        const database = readDatabase();
        const conclusion = database.conclusions.find(
          (item) => item.id === conclusionId,
        );
        if (!conclusion) {
          return { error: { status: "CUSTOM_ERROR", error: "结论不存在" } };
        }
        if (
          conclusion.status !== "submitted" &&
          conclusion.status !== "draft"
        ) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "当前版本不能再次复核。",
            },
          };
        }
        const snapshot = database.snapshots.find(
          (item) => item.id === conclusion.snapshotId,
        );
        if (decision === "approve") {
          if (!snapshot || snapshot.state === "pending_backfill") {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "该结论为旧数据、快照待核，请先补录快照后再通过。",
              },
            };
          }
          if (snapshot.state === "stale") {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "快照已失效：提交后线索发生变化，请先完成影响复查或要求重新提交结论。",
              },
            };
          }
        }
        conclusion.status = decision === "approve" ? "approved" : "returned";
        conclusion.reviewerNote = reviewerNote;
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.status =
            decision === "approve" ? "closed" : "supplement";
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: "赵平",
          action: decision === "approve" ? "复核通过" : "退回补证",
          detail: `${conclusion.id} 已${decision === "approve" ? "通过" : "退回"}。${reviewerNote}`,
        });
        writeDatabase(database);
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    backfillSnapshot: builder.mutation<
      ConclusionSnapshot,
      { caseId: string; snapshotId: string }
    >({
      queryFn: async ({ caseId, snapshotId }) => {
        await wait();
        const database = readDatabase();
        const snapshot = database.snapshots.find(
          (item) => item.id === snapshotId,
        );
        if (!snapshot) {
          return { error: { status: "CUSTOM_ERROR", error: "快照不存在" } };
        }
        if (snapshot.state !== "pending_backfill") {
          return {
            error: { status: "CUSTOM_ERROR", error: "该快照已完成核验，无需补录。" },
          };
        }
        snapshot.state = "current";
        snapshot.backfilledAt = nowIso();
        snapshot.backfilledBy = CURRENT_ACTOR;
        appendAudit(database, {
          caseId,
          actor: CURRENT_ACTOR,
          action: "补录结论快照",
          detail: `${snapshot.id}（对应 V${snapshot.version}）已按当前证据、图谱与时间线补录核验，可以重新提交结论。`,
        });
        writeDatabase(database);
        return { data: snapshot };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    runImpactReview: builder.mutation<ImpactReview, { caseId: string }>({
      queryFn: async ({ caseId }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        // 优先复查失效快照；同一案件可能有多份（历史版本），全部复查
        const staleSnapshots = database.snapshots.filter(
          (item) => item.caseId === caseId && item.state === "stale",
        );
        const fallbackSnapshot = database.snapshots.find(
          (item) => item.caseId === caseId && item.state === "current",
        );
        const snapshot = staleSnapshots[0] ?? fallbackSnapshot;
        if (!snapshot) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "没有可复查的结论快照（草稿或待核快照不支持影响复查）。",
            },
          };
        }
        const review = buildImpactReview({
          snapshot,
          nodes: database.nodes.filter((item) => item.caseId === caseId),
          edges: database.edges.filter((item) => item.caseId === caseId),
          evidence: database.evidence.filter(
            (item) => item.caseId === caseId,
          ),
          alerts: database.alerts.filter(
            (item) => item.caseId === caseId,
          ),
        });
        if (staleSnapshots.length > 0) {
          if (review.changes.length === 0) {
            // 未影响结论实质（例如只有布局调整）：恢复快照与原状态，未受影响项整体跳过
            staleSnapshots.forEach((item) => {
              item.state = "current";
            });
            targetCase.status = snapshot.baseCaseStatus;
            targetCase.updatedAt = nowIso();
            appendAudit(database, {
              caseId,
              actor: CURRENT_ACTOR,
              action: "影响复查无实质变更",
              detail: `${staleSnapshots.length} 份快照复查均未发现证据/关系/告警变化，恢复为有效，案件状态回到 ${snapshot.baseCaseStatus}。`,
            });
            review.state = "current";
          } else {
            appendAudit(database, {
              caseId,
              actor: CURRENT_ACTOR,
              action: "影响复查确认变更",
              detail: `快照 ${snapshot.id} 复查发现 ${review.changes.length} 项受影响线索（共 ${staleSnapshots.length} 份失效快照），案件维持待复议，等待重新提交结论。`,
            });
          }
        }
        writeDatabase(database);
        return { data: review };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    queueOfflineOperation: builder.mutation<SyncBatch, QueueOfflineInput>({
      queryFn: async ({ caseId, investigator, device, operation }) => {
        await wait(120);
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        let batch = database.syncBatches.find(
          (item) =>
            item.caseId === caseId &&
            item.investigator === investigator &&
            item.state !== "merged",
        );
        const op: OfflineOperation = {
          id: createId("OP"),
          caseId,
          investigator,
          type: operation.type,
          payload: operation.payload,
          createdAt: nowIso(),
        };
        if (!batch) {
          batch = {
            id: createId("BATCH"),
            caseId,
            investigator,
            device,
            state: "pending",
            // 基线在首个离线操作登记时固化
            baseline: buildBaseline(database, caseId),
            operations: [],
            createdAt: nowIso(),
            appliedOpIds: [],
          };
          database.syncBatches.unshift(batch);
        }
        batch.operations.push(op);
        batch.device = device;
        appendAudit(database, {
          caseId,
          actor: investigator,
          action: "离线登记线索",
          detail: `${device} 离线登记操作 ${op.id}（${op.type}），已加入批次 ${batch.id}，保存合并基线不变。`,
        });
        writeDatabase(database);
        return { data: batch };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
      ],
    }),
    mergeSyncBatches: builder.mutation<
      SyncBatchMergeResult,
      {
        caseId: string;
        batchId: string;
        simulateFailure?: boolean;
        resolutions?: Record<string, MergeConflictResolution>;
      }
    >({
      queryFn: async ({ batchId, simulateFailure, resolutions }) => {
        await wait();
        const database = readDatabase();
        const batch = database.syncBatches.find((item) => item.id === batchId);
        if (!batch) {
          return { error: { status: "CUSTOM_ERROR", error: "离线批次不存在" } };
        }

        // 重复合并：已并入的操作只补缺项（正常情况下没有新操作）
        if (batch.state === "merged") {
          const pending = batch.operations.filter(
            (op) => !batch.appliedOpIds.includes(op.id),
          );
          if (pending.length === 0) {
            return {
              data: {
                batchId: batch.id,
                caseId: batch.caseId,
                state: "merged",
                appliedCount: 0,
                skippedDuplicateCount: batch.appliedOpIds.length,
                conflicts: [],
                mergedAt: batch.mergedAt,
              },
            };
          }
        }

        const otherBatches = database.syncBatches.filter(
          (item) =>
            item.caseId === batch.caseId &&
            item.id !== batch.id &&
            item.investigator !== batch.investigator &&
            item.state !== "merged",
        );
        const conflicts = detectConflicts(database, batch, otherBatches);

        // 模拟保存失败：批次原样保留，可直接重试
        if (simulateFailure) {
          batch.state = "save_failed";
          batch.lastError = "网络中断，批次保存失败；操作已保留，可重试合并。";
          writeDatabase(database);
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: batch.lastError,
            },
          };
        }

        // 存在未决策冲突：按各自基线列清，不做任何覆盖
        const unresolved = conflicts.filter(
          (conflict) => !resolutions?.[conflict.key],
        );
        if (unresolved.length > 0) {
          writeDatabase(database);
          return {
            error: {
              status: "CONFLICT",
              error: "存在离线冲突，请先按双方基线选择处理方式。",
              data: { conflicts, batchId: batch.id },
            },
          };
        }

        let appliedCount = 0;
        let skippedDuplicateCount = 0;
        const conflictByKey = new Map(
          conflicts.map((conflict) => [conflict.key, conflict]),
        );

        batch.operations.forEach((op) => {
          if (batch.appliedOpIds.includes(op.id)) {
            skippedDuplicateCount += 1;
            return;
          }

          let conflict: MergeConflict | undefined;
          if (op.type === "add_evidence") {
            const payload = op.payload as unknown as EvidencePayload;
            conflict = conflictByKey.get(`evidence:${normalizeText(payload.title)}`);
          }
          if (
            !conflict &&
            (op.type === "add_node" || op.type === "add_relation")
          ) {
            const payload = op.payload as unknown as NodePayload;
            conflict = conflictByKey.get(
              `relation:${payload.sourceId}->${normalizeText(payload.label)}`,
            );
          }

          const resolution = conflict
            ? resolutions?.[conflict.key]
            : undefined;
          if (resolution === "keep_remote") {
            appendAudit(database, {
              caseId: batch.caseId,
              actor: batch.investigator,
              action: "离线合并冲突处置",
              detail: `冲突「${conflict!.label}」采用对方版本，本端操作 ${op.id} 跳过，不覆盖对方数据。`,
            });
            batch.appliedOpIds.push(op.id);
            skippedDuplicateCount += 1;
            return;
          }

          applyOperation(
            database,
            batch,
            op,
            resolution === "keep_both",
          );
          batch.appliedOpIds.push(op.id);
          if (resolution === "keep_local" || resolution === "keep_both") {
            appendAudit(database, {
              caseId: batch.caseId,
              actor: batch.investigator,
              action: "离线合并冲突处置",
              detail: `冲突「${conflict!.label}」采用${resolution === "keep_both" ? "双方并存" : "本端版本"}，对方数据保持不变。`,
            });
          }
          appliedCount += 1;
        });

        const targetCase = database.cases.find(
          (item) => item.id === batch.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        if (appliedCount > 0) {
          invalidateSnapshots(
            database,
            batch.caseId,
            `离线批次 ${batch.id} 并入新线索`,
          );
        }
        batch.state = "merged";
        batch.mergedAt = nowIso();
        batch.lastError = undefined;
        appendAudit(database, {
          caseId: batch.caseId,
          actor: batch.investigator,
          action: "离线批次合并完成",
          detail: `${batch.device} 批次并入 ${appliedCount} 项操作，跳过重复 ${skippedDuplicateCount} 项，冲突 ${conflicts.length} 项已按基线决策。`,
        });
        writeDatabase(database);

        return {
          data: {
            batchId: batch.id,
            caseId: batch.caseId,
            state: "merged",
            appliedCount,
            skippedDuplicateCount,
            conflicts,
            mergedAt: batch.mergedAt,
          },
        };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(180);
        resetDatabase();
        return { data: { ok: true } };
      },
      invalidatesTags: ["Alerts", "Cases", "Case", "Audit", "Dashboard"],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useBackfillSnapshotMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useLinkAlertsToCaseMutation,
  useMergeSyncBatchesMutation,
  useQueueOfflineOperationMutation,
  useResetMockDataMutation,
  useReviewConclusionMutation,
  useRunImpactReviewMutation,
  useSaveConclusionMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
} = bankApi;

export type { RiskLevel };
