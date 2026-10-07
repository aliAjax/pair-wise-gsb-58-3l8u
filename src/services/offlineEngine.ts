import type {
  Evidence,
  InvestigationCase,
  InvestigationNode,
  OfflineChange,
  SyncBatch,
  SyncConflictItem,
} from "../models/types";
import type { MockDatabase } from "./mockStorage";
import { appendAudit, createId, nowIso } from "./mockStorage";

export interface MergeResult {
  batch: SyncBatch;
  appliedCount: number;
  conflictCount: number;
  bumped: boolean;
}

const changeDescription = (change: OfflineChange): string => {
  switch (change.kind) {
    case "add_evidence":
      return `登记证据「${change.payload.title ?? "未命名证据"}」`;
    case "add_node":
      return `加入节点「${change.payload.nodeLabel ?? "未命名节点"}」`;
    case "update_summary":
      return "修改案件摘要";
    case "update_node_note":
      return `更新节点说明（${change.payload.nodeId ?? "未知节点"}）`;
  }
};

const summarize = (text: string | undefined): string =>
  text && text.trim() ? text.trim() : "（空）";

/**
 * 按各自基线列出冲突：
 * - 新增类（证据、节点）按 clientId / 业务键幂等，重复合并只补缺项，不产生覆盖；
 * - 修改类（摘要、节点说明）在基线落后且服务端内容已被他人改动时产生冲突。
 */
export const detectConflict = (
  database: MockDatabase,
  caseRecord: InvestigationCase,
  change: OfflineChange,
): SyncConflictItem | null => {
  if (change.baseRevision >= caseRecord.revision) {
    return null;
  }

  if (change.kind === "update_summary") {
    const baseline = summarize(change.payload.summary);
    const current = summarize(caseRecord.summary);
    if (baseline !== current) {
      return {
        changeId: change.id,
        kind: change.kind,
        actor: change.actor,
        baseRevision: change.baseRevision,
        baseline,
        current,
        description: "案件摘要已被另一名调查员修改",
      };
    }
  }

  if (change.kind === "update_node_note") {
    const node = database.nodes.find(
      (item) => item.id === change.payload.nodeId,
    );
    const baseline = summarize(change.payload.note);
    const current = node ? summarize(node.data.note) : "（节点不存在）";
    if (node && baseline !== current) {
      return {
        changeId: change.id,
        kind: change.kind,
        actor: change.actor,
        baseRevision: change.baseRevision,
        baseline,
        current,
        description: `节点「${node.data.label}」说明已被另一名调查员修改`,
      };
    }
  }

  return null;
};

const isAlreadyApplied = (
  database: MockDatabase,
  caseId: string,
  change: OfflineChange,
): boolean => {
  const clientId = change.payload.clientId;
  if (!clientId) {
    return false;
  }
  if (change.kind === "add_evidence") {
    return database.evidence.some(
      (item) => item.caseId === caseId && item.clientId === clientId,
    );
  }
  if (change.kind === "add_node") {
    return database.nodes.some(
      (item) => item.caseId === caseId && item.clientId === clientId,
    );
  }
  return false;
};

const applyChange = (
  database: MockDatabase,
  caseRecord: InvestigationCase,
  change: OfflineChange,
): void => {
  switch (change.kind) {
    case "add_evidence": {
      const evidence: Evidence = {
        id: createId("EV"),
        caseId: caseRecord.id,
        title: change.payload.title ?? "未命名证据",
        source: change.payload.source ?? "离线补录",
        strength: change.payload.strength ?? "medium",
        occurredAt: change.payload.occurredAt ?? nowIso(),
        submittedAt: nowIso(),
        submittedBy: change.actor,
        attachment: change.payload.attachment ?? "offline-attachment",
        note: change.payload.note ?? "离线调查批次合并补录。",
        version: 1,
        clientId: change.payload.clientId,
      };
      database.evidence.unshift(evidence);
      break;
    }
    case "add_node": {
      const nodeId = createId("NODE");
      const node: InvestigationNode = {
        id: nodeId,
        caseId: caseRecord.id,
        position: { x: 360 + Math.round(Math.random() * 240), y: 220 },
        clientId: change.payload.clientId,
        data: {
          label: change.payload.nodeLabel ?? "未命名节点",
          kind: change.payload.nodeKind ?? "account",
          riskLevel: change.payload.riskLevel ?? "medium",
          note: change.payload.note ?? "离线调查登记，需结合来源材料复核。",
          evidenceStrength: change.payload.evidenceStrength ?? "medium",
          source: change.payload.evidenceSource ?? "离线登记",
          occurredAt: change.payload.occurredAt ?? nowIso(),
        },
      };
      database.nodes.push(node);
      if (change.payload.relationLabel) {
        database.edges.push({
          id: createId("E"),
          caseId: caseRecord.id,
          source: change.payload.nodeId ?? nodeId,
          target: nodeId,
          kind: change.payload.relationKind ?? "transfer",
          label: change.payload.relationLabel,
          amount: change.payload.amount,
          occurredAt: node.data.occurredAt,
          explanation:
            change.payload.relationExplanation ?? "离线批次补录的关系。",
        });
      }
      break;
    }
    case "update_summary":
      caseRecord.summary = change.payload.summary ?? caseRecord.summary;
      break;
    case "update_node_note": {
      const node = database.nodes.find(
        (item) => item.id === change.payload.nodeId,
      );
      if (node) {
        node.data.note = change.payload.note ?? node.data.note;
      }
      break;
    }
  }

  appendAudit(database, {
    caseId: caseRecord.id,
    actor: change.actor,
    action: "离线批次合并",
    detail: `${changeDescription(change)}（基线 R${change.baseRevision}）。`,
    caseStatus: caseRecord.status,
  });
};

/**
 * 合并离线批次：
 * 1. 已落库的变更（appliedChangeIds 或业务键命中）直接跳过 —— 重复合并只补缺项；
 * 2. 基线冲突按双方内容列清；裁决 keep_server 即跳过该项，apply_mine 在下次合并强制落库，
 *    未裁决前绝不互相覆盖；
 * 3. 无冲突变更全部落库后才递增 revision；
 * 4. simulateFailure 为真时不写库，批次保留 failed 可整体重试。
 */
export const mergeBatch = (
  database: MockDatabase,
  batch: SyncBatch,
  options: { simulateFailure?: boolean } = {},
): MergeResult => {
  const caseRecord = database.cases.find((item) => item.id === batch.caseId);
  if (!caseRecord) {
    throw new Error("案件不存在");
  }

  const pending = batch.changes.filter(
    (change) => !batch.appliedChangeIds.includes(change.id),
  );

  const resolutionByChange = new Map(
    batch.conflicts.map((item) => [item.changeId, item.resolution]),
  );
  const conflicts: SyncConflictItem[] = [];
  const toApply: OfflineChange[] = [];
  const toSkip: string[] = [];
  let duplicateCount = 0;

  pending.forEach((change) => {
    // 已裁决保留服务端版本：该缺项不再补入
    if (resolutionByChange.get(change.id) === "keep_server") {
      toSkip.push(change.id);
      return;
    }
    if (isAlreadyApplied(database, caseRecord.id, change)) {
      duplicateCount += 1;
      toSkip.push(change.id);
      return;
    }
    // 裁决采用我的版本：跳过基线冲突检测，强制落库
    if (resolutionByChange.get(change.id) !== "apply_mine") {
      const conflict = detectConflict(database, caseRecord, change);
      if (conflict) {
        conflicts.push(conflict);
        return;
      }
    }
    toApply.push(change);
  });

  if (options.simulateFailure) {
    const failed: SyncBatch = {
      ...batch,
      state: "failed",
      lastError: "模拟保存失败：本地存储写入被拒绝，批次已保留，可重试。",
      conflicts: mergeConflictList(batch.conflicts, conflicts),
      appliedChangeIds: [...batch.appliedChangeIds],
    };
    return {
      batch: failed,
      appliedCount: 0,
      conflictCount: mergeConflictList(batch.conflicts, conflicts).length,
      bumped: false,
    };
  }

  let appliedCount = duplicateCount;
  toApply.forEach((change) => {
    applyChange(database, caseRecord, change);
    batch.appliedChangeIds.push(change.id);
    appliedCount += 1;
  });
  toSkip.forEach((id) => {
    if (!batch.appliedChangeIds.includes(id)) {
      batch.appliedChangeIds.push(id);
      appliedCount += 1;
    }
  });

  const remaining = batch.changes.filter(
    (change) => !batch.appliedChangeIds.includes(change.id),
  );
  const mergedConflicts = mergeConflictList(batch.conflicts, conflicts);
  const hasOpenConflicts = mergedConflicts.some(
    (item) => item.resolution === undefined,
  );

  let bumped = false;
  if (toApply.length > 0) {
    caseRecord.revision += 1;
    caseRecord.updatedAt = nowIso();
    bumped = true;
  }

  appendAudit(database, {
    caseId: caseRecord.id,
    actor: batch.investigator,
    action: "执行离线合并",
    detail:
      `基线 R${batch.baseRevision} → 当前 R${caseRecord.revision}，` +
      `本次处理 ${pending.length} 项：落库 ${toApply.length} 项` +
      (duplicateCount > 0 ? `，重复跳过 ${duplicateCount} 项` : "") +
      (conflicts.length > 0 ? `，冲突 ${conflicts.length} 项待裁决` : "") +
      "。",
    caseStatus: caseRecord.status,
  });

  const nextState: SyncBatch["state"] =
    hasOpenConflicts || remaining.length > 0 ? "conflict" : "merged";

  const merged: SyncBatch = {
    ...batch,
    state: nextState,
    mergedAt: nextState === "merged" ? nowIso() : batch.mergedAt,
    lastError: undefined,
    conflicts: mergedConflicts,
    appliedChangeIds: [...batch.appliedChangeIds],
  };

  return {
    batch: merged,
    appliedCount,
    conflictCount: mergedConflicts.length,
    bumped,
  };
};

/** 合并已裁决冲突与本轮新冲突，保留用户的裁决结果 */
const mergeConflictList = (
  previous: SyncConflictItem[],
  detected: SyncConflictItem[],
): SyncConflictItem[] => {
  const previousByChange = new Map(
    previous.map((item) => [item.changeId, item]),
  );
  const seen = new Set<string>();
  const result: SyncConflictItem[] = [];
  [...previous, ...detected].forEach((item) => {
    if (seen.has(item.changeId)) {
      return;
    }
    seen.add(item.changeId);
    const old = previousByChange.get(item.changeId);
    result.push(old ? { ...item, resolution: old.resolution } : item);
  });
  return result;
};
