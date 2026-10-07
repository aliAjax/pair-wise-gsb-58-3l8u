import type {
  Alert,
  ConclusionSnapshot,
  Evidence,
  InvestigationEdge,
  InvestigationNode,
  SnapshotImpactItem,
} from "../models/types";
import { createId, nowIso } from "./id";

/** 稳定序列化：键排序后输出，避免字段顺序造成的伪差异 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

/** 轻量内容哈希（FNV-1a 32 位），仅用于本地版本比对 */
export const contentHash = (value: unknown): string => {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** 证据指纹：来源、强度、发生时间、附件与说明等内容均参与，纯展示字段不排除 */
const evidenceEntry = (item: Evidence) => ({
  id: item.id,
  title: item.title,
  source: item.source,
  strength: item.strength,
  occurredAt: item.occurredAt,
  attachment: item.attachment,
  note: item.note,
  version: item.version,
});

/** 节点内容指纹：刻意排除 position —— 仅拖动布局不影响结论依据 */
const nodeEntry = (item: InvestigationNode) => ({
  id: item.id,
  label: item.data.label,
  kind: item.data.kind,
  riskLevel: item.data.riskLevel,
  note: item.data.note,
  evidenceStrength: item.data.evidenceStrength,
  source: item.data.source,
  occurredAt: item.data.occurredAt,
});

const edgeEntry = (item: InvestigationEdge) => ({
  id: item.id,
  source: item.source,
  target: item.target,
  kind: item.kind,
  label: item.label,
  amount: item.amount ?? null,
  occurredAt: item.occurredAt,
  explanation: item.explanation,
});

export interface CaseFingerprintInput {
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  alerts: Alert[];
}

export interface CaseFingerprint {
  evidenceVersion: string;
  nodeVersion: string;
  edgeVersion: string;
  timelineVersion: string;
  evidenceCount: number;
  nodeCount: number;
  edgeCount: number;
  timelineCount: number;
}

/** 时间线版本：告警、关系交易、证据按时间合并后的条目集合 */
export const buildTimelineEntries = (
  input: CaseFingerprintInput,
): Array<{ key: string; at: string; title: string; kind: string }> => {
  const events = [
    ...input.alerts.map((item) => ({
      key: `alert:${item.id}`,
      at: item.detectedAt,
      title: item.title,
      kind: "alert",
    })),
    ...input.edges.map((item) => ({
      key: `edge:${item.id}`,
      at: item.occurredAt,
      title: item.label,
      kind: item.kind,
    })),
    ...input.evidence.map((item) => ({
      key: `evidence:${item.id}`,
      at: item.occurredAt,
      title: item.title,
      kind: item.strength,
    })),
  ];
  return events.sort(
    (a, b) => a.key.localeCompare(b.key) || a.at.localeCompare(b.at),
  );
};

export const buildFingerprint = (input: CaseFingerprintInput): CaseFingerprint => {
  const evidence = input.evidence.map(evidenceEntry).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const nodes = input.nodes.map(nodeEntry).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const edges = input.edges.map(edgeEntry).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const timeline = buildTimelineEntries(input);
  return {
    evidenceVersion: contentHash(evidence),
    nodeVersion: contentHash(nodes),
    edgeVersion: contentHash(edges),
    timelineVersion: contentHash(timeline),
    evidenceCount: evidence.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    timelineCount: timeline.length,
  };
};

export interface CreateSnapshotInput {
  caseId: string;
  conclusionId: string;
  fingerprint: CaseFingerprint;
  frozen: CaseFingerprintInput;
  status?: ConclusionSnapshot["status"];
  backfilled?: boolean;
  recheckNote?: string;
  impacts?: SnapshotImpactItem[];
  createdAt?: string;
  recheckedAt?: string;
}

/** 提交结论时固化证据、图谱关系与时间线版本 */
export const createSnapshot = (
  input: CreateSnapshotInput,
): ConclusionSnapshot => ({
  id: createId("SNAP"),
  caseId: input.caseId,
  conclusionId: input.conclusionId,
  status: input.status ?? "verified",
  createdAt: input.createdAt ?? nowIso(),
  recheckedAt: input.recheckedAt,
  evidenceVersion: input.fingerprint.evidenceVersion,
  nodeVersion: input.fingerprint.nodeVersion,
  edgeVersion: input.fingerprint.edgeVersion,
  timelineVersion: input.fingerprint.timelineVersion,
  evidenceCount: input.fingerprint.evidenceCount,
  nodeCount: input.fingerprint.nodeCount,
  edgeCount: input.fingerprint.edgeCount,
  timelineCount: input.fingerprint.timelineCount,
  impacts: input.impacts ?? [],
  backfilled: input.backfilled,
  recheckNote: input.recheckNote,
  frozenEvidence: structuredClone(input.frozen.evidence),
  frozenNodes: structuredClone(input.frozen.nodes),
  frozenEdges: structuredClone(input.frozen.edges),
  frozenAlerts: structuredClone(input.frozen.alerts),
});

interface CompareOptions {
  beforeNodes: InvestigationNode[];
  currentNodes: InvestigationNode[];
  beforeEdges: InvestigationEdge[];
  currentEdges: InvestigationEdge[];
  beforeEvidence: Evidence[];
  currentEvidence: Evidence[];
  beforeTimeline: CaseFingerprint;
  current: CaseFingerprint;
}

const byId = <T extends { id: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

/**
 * 影响复查：逐类比对快照基线与当前线索。
 * 未受影响的分类直接跳过；节点位置变化不构成影响，不会产生条目。
 */
export const compareFingerprints = (options: CompareOptions) => {
  const impacts: SnapshotImpactItem[] = [];

  if (options.beforeTimeline.evidenceVersion !== options.current.evidenceVersion) {
    const before = byId(options.beforeEvidence);
    const current = byId(options.currentEvidence);
    current.forEach((item, id) => {
      const old = before.get(id);
      if (!old) {
        impacts.push({
          id: createId("IMP"),
          category: "evidence",
          label: item.title,
          changeType: "added",
          detail: `新增证据：${item.source}（${item.strength === "strong" ? "强" : item.strength === "medium" ? "中" : "弱"}证据）`,
        });
      } else if (contentHash(evidenceEntry(old)) !== contentHash(evidenceEntry(item))) {
        const fields: string[] = [];
        if (old.strength !== item.strength) fields.push("证据强度");
        if (old.source !== item.source) fields.push("来源");
        if (old.occurredAt !== item.occurredAt) fields.push("发生时间");
        if (old.note !== item.note) fields.push("说明");
        if (old.attachment !== item.attachment) fields.push("附件");
        impacts.push({
          id: createId("IMP"),
          category: "evidence",
          label: item.title,
          changeType: "modified",
          detail: `证据内容变更：${fields.join("、") || "内容"}`,
        });
      }
    });
    before.forEach((item, id) => {
      if (!current.has(id)) {
        impacts.push({
          id: createId("IMP"),
          category: "evidence",
          label: item.title,
          changeType: "removed",
          detail: "证据已从台账移除",
        });
      }
    });
  }

  if (options.beforeTimeline.nodeVersion !== options.current.nodeVersion) {
    const before = byId(options.beforeNodes);
    const current = byId(options.currentNodes);
    current.forEach((item, id) => {
      const old = before.get(id);
      if (!old) {
        impacts.push({
          id: createId("IMP"),
          category: "node",
          label: item.data.label,
          changeType: "added",
          detail: `新增${item.data.kind === "account" ? "账户" : item.data.kind === "device" ? "设备" : item.data.kind === "ip" ? "IP" : "商户"}节点，来源：${item.data.source}`,
        });
      } else if (contentHash(nodeEntry(old)) !== contentHash(nodeEntry(item))) {
        const fields: string[] = [];
        if (old.data.note !== item.data.note) fields.push("节点说明");
        if (old.data.evidenceStrength !== item.data.evidenceStrength)
          fields.push("证据强度");
        if (old.data.riskLevel !== item.data.riskLevel) fields.push("风险等级");
        if (old.data.source !== item.data.source) fields.push("证据来源");
        if (old.data.occurredAt !== item.data.occurredAt) fields.push("发生时间");
        if (old.data.label !== item.data.label) fields.push("名称");
        impacts.push({
          id: createId("IMP"),
          category: "node",
          label: item.data.label,
          changeType: "modified",
          detail: `节点内容变更：${fields.join("、") || "内容"}`,
        });
      }
    });
    before.forEach((item, id) => {
      if (!current.has(id)) {
        impacts.push({
          id: createId("IMP"),
          category: "node",
          label: item.data.label,
          changeType: "removed",
          detail: "节点已从图谱移除",
        });
      }
    });
  }

  if (options.beforeTimeline.edgeVersion !== options.current.edgeVersion) {
    const before = byId(options.beforeEdges);
    const current = byId(options.currentEdges);
    current.forEach((item, id) => {
      const old = before.get(id);
      if (!old) {
        impacts.push({
          id: createId("IMP"),
          category: "edge",
          label: item.label,
          changeType: "added",
          detail: `新增图谱关系（${item.kind}）：${item.explanation}`,
        });
      } else if (contentHash(edgeEntry(old)) !== contentHash(edgeEntry(item))) {
        impacts.push({
          id: createId("IMP"),
          category: "edge",
          label: item.label,
          changeType: "modified",
          detail: "关系解释、金额或时间已修改",
        });
      }
    });
    before.forEach((item, id) => {
      if (!current.has(id)) {
        impacts.push({
          id: createId("IMP"),
          category: "edge",
          label: item.label,
          changeType: "removed",
          detail: "关系已从图谱移除",
        });
      }
    });
  }

  // 时间线版本独立复查：前述三类已记录的变化不再重复罗列
  if (
    options.beforeTimeline.timelineVersion !== options.current.timelineVersion &&
    impacts.length === 0
  ) {
    impacts.push({
      id: createId("IMP"),
      category: "timeline",
      label: "联动时间线",
      changeType: "modified",
      detail: `时间线条目数 ${options.beforeTimeline.timelineCount} → ${options.current.timelineCount}，版本已变化`,
    });
  }

  return impacts;
};

/**
 * 对已固化快照执行一次影响复查：
 * 证据、图谱关系或时间线任一版本变化 → stale；否则保持原状态（未受影响直接跳过）。
 */
export const recheckSnapshot = (
  snapshot: ConclusionSnapshot,
  currentInput: CaseFingerprintInput,
): { status: ConclusionSnapshot["status"]; impacts: SnapshotImpactItem[] } => {
  const baselineFingerprint = buildFingerprint({
    nodes: snapshot.frozenNodes,
    edges: snapshot.frozenEdges,
    evidence: snapshot.frozenEvidence,
    alerts: snapshot.frozenAlerts,
  });
  const current = buildFingerprint(currentInput);
  const unchanged =
    baselineFingerprint.evidenceVersion === current.evidenceVersion &&
    baselineFingerprint.nodeVersion === current.nodeVersion &&
    baselineFingerprint.edgeVersion === current.edgeVersion &&
    baselineFingerprint.timelineVersion === current.timelineVersion;

  if (unchanged) {
    return { status: snapshot.status, impacts: [] };
  }

  const impacts = compareFingerprints({
    beforeNodes: snapshot.frozenNodes,
    currentNodes: currentInput.nodes,
    beforeEdges: snapshot.frozenEdges,
    currentEdges: currentInput.edges,
    beforeEvidence: snapshot.frozenEvidence,
    currentEvidence: currentInput.evidence,
    beforeTimeline: baselineFingerprint,
    current,
  });
  return { status: "stale", impacts };
};
