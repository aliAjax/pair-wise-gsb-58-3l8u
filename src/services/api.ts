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
  InvestigationCase,
  InvestigationNode,
  OfflineChange,
  RiskLevel,
  SyncBatch,
  SyncConflictItem,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "./mockStorage";
import {
  buildFingerprint,
  createSnapshot,
  recheckSnapshot,
  type CaseFingerprintInput,
} from "./snapshotEngine";
import { mergeBatch } from "./offlineEngine";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

type Database = ReturnType<typeof readDatabase>;

const caseFingerprintInput = (
  database: Database,
  caseId: string,
): CaseFingerprintInput => ({
  nodes: database.nodes.filter((item) => item.caseId === caseId),
  edges: database.edges.filter((item) => item.caseId === caseId),
  evidence: database.evidence.filter((item) => item.caseId === caseId),
  alerts: database.alerts.filter((item) => item.caseId === caseId),
});

/**
 * 线索变化后的影响复查：逐份快照与当前指纹重算。
 * 任一快照失效 → 案件进入待复议（原裁定仍有效）；全部有效则案件状态不动。
 * 未受影响的快照直接跳过。
 */
const recheckCaseSnapshots = (
  database: Database,
  caseId: string,
): { snapshots: ConclusionSnapshot[]; enteredReconsider: boolean } => {
  const caseRecord = database.cases.find((item) => item.id === caseId);
  const snapshots = database.snapshots.filter((item) => item.caseId === caseId);
  if (!caseRecord || snapshots.length === 0) {
    return { snapshots, enteredReconsider: false };
  }

  const currentInput = caseFingerprintInput(database, caseId);
  let anyStale = false;

  const rechecked = snapshots.map((snapshot) => {
    const result = recheckSnapshot(snapshot, currentInput);
    if (result.impacts.length > 0 || result.status === "stale") {
      const next: ConclusionSnapshot = {
        ...snapshot,
        status: "stale",
        impacts: result.impacts,
        recheckedAt: nowIso(),
        recheckNote:
          "线索变化已触发影响复查，请基于补录后的材料重新提交结论；原裁定在复议期间继续有效。",
      };
      const index = database.snapshots.findIndex((item) => item.id === snapshot.id);
      if (index >= 0) {
        database.snapshots[index] = next;
      }
      anyStale = true;
      return next;
    }
    return snapshot;
  });

  let enteredReconsider = false;
  if (anyStale && caseRecord.status !== "reconsider" && caseRecord.status !== "closed") {
    caseRecord.status = "reconsider";
    enteredReconsider = true;
  }
  return { snapshots: rechecked, enteredReconsider };
};

/** 旧结论没有快照 → 待核；补录前禁止重提结论 */
const getOrCreateBackfillMarker = (
  database: Database,
  caseId: string,
): ConclusionSnapshot | undefined => {
  const submitted = database.conclusions
    .filter(
      (item) => item.caseId === caseId && item.status !== "draft",
    )
    .sort((a, b) => b.version - a.version);
  const latest = submitted[0];
  if (!latest || latest.snapshotId) {
    return undefined;
  }
  const existing = database.snapshots.find(
    (item) => item.conclusionId === latest.id && item.status === "pending_backfill",
  );
  if (existing) {
    return existing;
  }
  // 旧数据无冻结明细，仅落一个待核标记，不允许当作有效快照使用
  const empty = { nodes: [], edges: [], evidence: [], alerts: [] };
  const marker = createSnapshot({
    caseId,
    conclusionId: latest.id,
    fingerprint: buildFingerprint(empty),
    frozen: empty,
    status: "pending_backfill",
    recheckNote: "该结论来自旧数据，缺少提交时快照；补录核对前不能重新提交结论。",
  });
  database.snapshots.push(marker);
  const conclusion = database.conclusions.find((item) => item.id === latest.id);
  if (conclusion) {
    conclusion.snapshotId = marker.id;
  }
  return marker;
};

/** 工作区打开时：为旧结论补待核标记，并对已有快照做一次复查 */
const ensureCaseIntegrity = (database: Database, caseId: string) => {
  getOrCreateBackfillMarker(database, caseId);
  recheckCaseSnapshots(database, caseId);
};

/** 线索写入后的统一复查留痕 */
const runPostChangeRecheck = (database: Database, caseId: string): void => {
  const { enteredReconsider } = recheckCaseSnapshots(database, caseId);
  const stale = database.snapshots.filter(
    (item) => item.caseId === caseId && item.status === "stale",
  );
  if (stale.length > 0) {
    const impacted = stale[stale.length - 1];
    const caseRecord = database.cases.find((item) => item.id === caseId);
    appendAudit(database, {
      caseId,
      actor: "系统",
      action: "快照影响复查",
      detail:
        `检测到线索变化并完成复查：受影响快照 ${stale.length} 份、影响项 ${impacted.impacts.length} 条；` +
        (enteredReconsider
          ? "原裁定仍有效，案件转为待复议。"
          : "案件维持待复议状态。"),
      caseStatus: caseRecord?.status,
    });
  }
};

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

export const bankApi = createApi({
  reducerPath: "bankApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Alerts", "Cases", "Case", "Audit", "Dashboard", "Snapshot", "Sync"],
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
              ["pending_review", "supplement", "reconsider"].includes(item.status),
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
        const database = readDatabase();
        let mutated = false;
        database.cases.forEach((item) => {
          const beforeStatus = item.status;
          const beforeSnapshotCount = database.snapshots.length;
          ensureCaseIntegrity(database, item.id);
          const after = database.cases.find((c) => c.id === item.id);
          if (
            after &&
            (after.status !== beforeStatus ||
              database.snapshots.length !== beforeSnapshotCount)
          ) {
            mutated = true;
          }
        });
        if (mutated) {
          writeDatabase(database);
        }
        return { data: database.cases };
      },
      providesTags: ["Cases", "Dashboard"],
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
        ensureCaseIntegrity(database, caseId);
        writeDatabase(database);
        return {
          data: {
            case: investigationCase,
            nodes: database.nodes.filter((item) => item.caseId === caseId),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: database.evidence
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version),
            snapshots: database.snapshots.filter(
              (item) => item.caseId === caseId,
            ),
            syncBatches: database.syncBatches
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        { type: "Snapshot", id: caseId },
        { type: "Sync", id: caseId },
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
        targetCase.revision += 1;
        database.alerts = updated;
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "批量关联告警",
          detail: `关联告警 ${alertIds.join("、")}。`,
          caseStatus: targetCase.status,
        });
        runPostChangeRecheck(database, caseId);
        writeDatabase(database);
        return { data: selected };
      },
      invalidatesTags: (_result, _error, input) => [
        "Alerts",
        "Cases",
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
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
          actor: "林澜",
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
          targetCase.revision += 1;
        }
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "加入图谱节点",
          detail: `${node.data.label} 已加入，证据强度 ${node.data.evidenceStrength}。`,
          caseStatus: targetCase?.status,
        });
        runPostChangeRecheck(database, caseId);
        writeDatabase(database);
        return { data: node };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
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
        const previous = database.nodes[index];
        const contentChanged =
          JSON.stringify(previous.data) !== JSON.stringify(node.data);
        database.nodes[index] = { ...previous, ...node };
        if (contentChanged) {
          const targetCase = database.cases.find(
            (item) => item.id === caseId,
          );
          if (targetCase) {
            targetCase.updatedAt = nowIso();
            targetCase.revision += 1;
          }
          appendAudit(database, {
            caseId,
            actor: "林澜",
            action: "更新图谱节点",
            detail: `${node.data.label} 的节点内容已修改，已触发快照影响复查；纯位置拖动不触发。`,
            caseStatus: targetCase?.status,
          });
          runPostChangeRecheck(database, caseId);
        }
        writeDatabase(database);
        return { data: database.nodes[index] };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
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
          submittedBy: "林澜",
          version: 1,
        };
        database.evidence.unshift(evidence);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
          targetCase.revision += 1;
        }
        appendAudit(database, {
          caseId: input.caseId,
          actor: "林澜",
          action: "新增证据",
          detail: `${input.title} 已登记，来源为 ${input.source}。`,
          caseStatus: targetCase?.status,
        });
        runPostChangeRecheck(database, input.caseId);
        writeDatabase(database);
        return { data: evidence };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    saveConclusion: builder.mutation<
      { conclusion: ConclusionVersion; snapshot?: ConclusionSnapshot },
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
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }

        // 旧数据缺快照先标待核，补录前不能重提结论
        const backfillMarker = getOrCreateBackfillMarker(
          database,
          input.caseId,
        );
        if (input.submit && backfillMarker) {
          writeDatabase(database);
          return {
            error: {
              status: "CUSTOM_ERROR",
              error:
                "该案件的上一版结论缺少提交时快照，已标记为待核；请先完成快照补录，再重新提交结论。",
            },
          };
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
          createdBy: "林澜",
          createdAt: nowIso(),
          reviewer: "赵平",
        };

        let snapshot: ConclusionSnapshot | undefined;
        if (input.submit) {
          // 提交时固化证据、图谱关系与时间线版本
          const frozen = caseFingerprintInput(database, input.caseId);
          snapshot = createSnapshot({
            caseId: input.caseId,
            conclusionId: conclusion.id,
            fingerprint: buildFingerprint(frozen),
            frozen,
            status: "verified",
          });
          conclusion.snapshotId = snapshot.id;
          database.snapshots.push(snapshot);
        }

        database.conclusions.unshift(conclusion);
        if (input.submit) {
          // 新结论带新快照，旧快照保留为历史；案件进入待复核
          targetCase.status = "pending_review";
        } else if (targetCase.status === "reconsider") {
          // 保存草稿不改变待复议状态
        } else {
          targetCase.status = "investigating";
        }
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId: input.caseId,
          actor: "林澜",
          action: "保存结论版本",
          detail: input.submit
            ? `${conclusion.id} V${conclusion.version} 已提交复核，并固化快照 ${snapshot?.id ?? ""}（证据 ${snapshot?.evidenceCount ?? 0}、节点 ${snapshot?.nodeCount ?? 0}、关系 ${snapshot?.edgeCount ?? 0}、时间线 ${snapshot?.timelineCount ?? 0} 项）。`
            : `${conclusion.id} V${conclusion.version} 已保存为草稿。`,
          caseStatus: targetCase.status,
        });
        writeDatabase(database);
        return { data: { conclusion, snapshot } };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
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
          const latestSubmitted = database.conclusions
            .filter(
              (item) =>
                item.caseId === caseId && item.status === "submitted",
            )
            .sort((a, b) => b.version - a.version)[0];
          if (!latestSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
          }
          const snapshot = latestSubmitted.snapshotId
            ? database.snapshots.find(
                (item) => item.id === latestSubmitted.snapshotId,
              )
            : undefined;
          if (!snapshot || snapshot.status === "pending_backfill") {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "上一版结论缺少快照且已标记待核，请先补录快照再提交复核。",
              },
            };
          }
          if (snapshot.status === "stale") {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "提交依据已发生变化（快照失效），请基于补录材料重新提交结论后再进入复核。",
              },
            };
          }
        }
        targetCase.status = status;
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "案件状态流转",
          detail: `状态更新为 ${status}${reason ? `，原因：${reason}` : ""}。`,
          caseStatus: status,
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
        const snapshot = conclusion.snapshotId
          ? database.snapshots.find((item) => item.id === conclusion.snapshotId)
          : undefined;
        if (!snapshot) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "该结论缺少提交时快照，已标记待核，补录前不能复核。",
            },
          };
        }
        if (snapshot.status === "pending_backfill") {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "旧数据快照待核，请先完成快照补录再执行复核。",
            },
          };
        }
        if (snapshot.status === "stale") {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "结论依据已变化（快照失效 · 待复议），请要求调查员基于新材料重新提交结论。",
            },
          };
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
          caseStatus: targetCase?.status,
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
      { caseId: string; conclusionId: string }
    >({
      queryFn: async ({ caseId, conclusionId }) => {
        await wait();
        const database = readDatabase();
        const conclusion = database.conclusions.find(
          (item) => item.id === conclusionId && item.caseId === caseId,
        );
        if (!conclusion) {
          return { error: { status: "CUSTOM_ERROR", error: "结论不存在" } };
        }
        const frozen = caseFingerprintInput(database, caseId);
        if (
          frozen.evidence.length === 0 &&
          frozen.nodes.length === 0 &&
          frozen.edges.length === 0
        ) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "当前案件没有可核对的线索，无法补录快照。",
            },
          };
        }
        const snapshot = createSnapshot({
          caseId,
          conclusionId,
          fingerprint: buildFingerprint(frozen),
          frozen,
          status: "verified",
          backfilled: true,
          recheckNote: "旧结论快照已按当前已核对线索补录。",
        });
        database.snapshots = database.snapshots.filter(
          (item) =>
            !(
              item.conclusionId === conclusionId &&
              item.status === "pending_backfill"
            ),
        );
        database.snapshots.push(snapshot);
        conclusion.snapshotId = snapshot.id;
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "补录结论快照",
          detail: `旧结论 ${conclusion.id} 已按核对后的线索补录快照 ${snapshot.id}，待核标记解除。`,
        });
        writeDatabase(database);
        return { data: snapshot };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    recheckSnapshots: builder.mutation<
      { snapshots: ConclusionSnapshot[]; enteredReconsider: boolean },
      { caseId: string }
    >({
      queryFn: async ({ caseId }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const { enteredReconsider } = recheckCaseSnapshots(database, caseId);
        const stale = database.snapshots.filter(
          (item) => item.caseId === caseId && item.status === "stale",
        );
        appendAudit(database, {
          caseId,
          actor: "林澜",
          action: "手动影响复查",
          detail:
            stale.length > 0
              ? `复查完成：${stale.length} 份快照失效，共 ${stale.reduce((sum, item) => sum + item.impacts.length, 0)} 条影响项。`
              : "复查完成：证据、图谱关系与时间线均未变化，快照继续有效。",
          caseStatus: enteredReconsider ? "reconsider" : undefined,
        });
        writeDatabase(database);
        return {
          data: {
            snapshots: database.snapshots.filter(
              (item) => item.caseId === caseId,
            ),
            enteredReconsider,
          },
        };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        { type: "Snapshot", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    createSyncBatch: builder.mutation<
      SyncBatch,
      {
        caseId: string;
        investigator: string;
        baseRevision: number;
        changes: Array<Omit<OfflineChange, "id" | "createdAt" | "baseRevision">>;
        failNext?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait(120);
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === input.caseId)) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const batch: SyncBatch = {
          id: createId("BATCH"),
          caseId: input.caseId,
          investigator: input.investigator,
          baseRevision: input.baseRevision,
          state: "pending",
          createdAt: nowIso(),
          changes: input.changes.map((change) => ({
            ...change,
            id: createId("CHG"),
            baseRevision: input.baseRevision,
            createdAt: nowIso(),
          })),
          appliedChangeIds: [],
          conflicts: [],
          failNext: input.failNext ?? false,
        };
        database.syncBatches.unshift(batch);
        appendAudit(database, {
          caseId: input.caseId,
          actor: input.investigator,
          action: "创建离线批次",
          detail: `离线记录 ${batch.changes.length} 项改动，基线 R${input.baseRevision}。`,
        });
        writeDatabase(database);
        return { data: batch };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Sync", id: input.caseId },
        "Audit",
      ],
    }),
    mergeSyncBatch: builder.mutation<
      { batch: SyncBatch; appliedCount: number },
      { batchId: string; simulateFailure?: boolean }
    >({
      queryFn: async ({ batchId, simulateFailure }) => {
        await wait();
        const database = readDatabase();
        const index = database.syncBatches.findIndex(
          (item) => item.id === batchId,
        );
        if (index < 0) {
          return { error: { status: "CUSTOM_ERROR", error: "批次不存在" } };
        }
        // 首次合并遇到 failNext 时模拟保存失败，失败后清除标记以便重试成功
        const willFail = simulateFailure || database.syncBatches[index].failNext;
        const result = mergeBatch(database, database.syncBatches[index], {
          simulateFailure: willFail,
        });
        database.syncBatches[index] = {
          ...result.batch,
          failNext: willFail ? false : result.batch.failNext,
        };
        if (!willFail) {
          // 合并可能补入证据/节点，对已固化快照执行影响复查
          runPostChangeRecheck(database, result.batch.caseId);
        }
        writeDatabase(database);
        if (willFail) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: result.batch.lastError ?? "保存失败，批次已保留。",
            },
          };
        }
        return {
          data: {
            batch: database.syncBatches[index],
            appliedCount: result.appliedCount,
          },
        };
      },
      invalidatesTags: (_result, _error, input) => {
        // 失败时 error 结果不携带 caseId，直接全量刷新相关标签
        return [
          "Sync",
          "Case",
          "Snapshot",
          "Audit",
          "Cases",
          "Dashboard",
        ];
      },
    }),
    resolveSyncConflict: builder.mutation<
      SyncConflictItem,
      {
        batchId: string;
        changeId: string;
        resolution: NonNullable<SyncConflictItem["resolution"]>;
      }
    >({
      queryFn: async ({ batchId, changeId, resolution }) => {
        await wait(100);
        const database = readDatabase();
        const batch = database.syncBatches.find((item) => item.id === batchId);
        if (!batch) {
          return { error: { status: "CUSTOM_ERROR", error: "批次不存在" } };
        }
        const conflict = batch.conflicts.find(
          (item) => item.changeId === changeId,
        );
        if (!conflict) {
          return { error: { status: "CUSTOM_ERROR", error: "冲突不存在" } };
        }
        conflict.resolution = resolution;
        appendAudit(database, {
          caseId: batch.caseId,
          actor: "林澜",
          action: "裁决离线冲突",
          detail:
            resolution === "keep_server"
              ? `基线冲突 ${changeId} 裁决为保留服务端版本。`
              : `基线冲突 ${changeId} 裁决为采用离线版本，将在下次合并落库。`,
        });
        writeDatabase(database);
        return { data: conflict };
      },
      invalidatesTags: ["Sync", "Audit"],
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
  useCreateSyncBatchMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useLinkAlertsToCaseMutation,
  useMergeSyncBatchMutation,
  useRecheckSnapshotsMutation,
  useResolveSyncConflictMutation,
  useResetMockDataMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
} = bankApi;

export type { RiskLevel };
