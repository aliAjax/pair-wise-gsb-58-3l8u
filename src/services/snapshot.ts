import type {
  Alert,
  ConclusionSnapshot,
  Evidence,
  ImpactChange,
  ImpactReview,
  InvestigationEdge,
  InvestigationNode,
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotNode,
} from "../models/types";

/**
 * 时间线版本：对案件中参与时间线的线索（证据 + 图谱关系 + 关联告警）
 * 做稳定序列化后取 FNV-1a 哈希。节点拖动只改布局、不参与时间线，
 * 因此不会改变版本号。
 */
export function computeTimelineVersion(input: {
  evidence: Pick<Evidence, "id" | "occurredAt" | "version" | "strength">[];
  edges: Pick<InvestigationEdge, "id" | "occurredAt" | "label" | "kind">[];
  alertIds: string[];
}): string {
  const evidencePart = input.evidence
    .map(
      (item) =>
        `ev:${item.id}|${item.occurredAt}|v${item.version}|${item.strength}`,
    )
    .sort();
  const edgePart = input.edges
    .map(
      (item) =>
        `e:${item.id}|${item.occurredAt}|${item.kind}|${item.label}`,
    )
    .sort();
  const alertPart = [...input.alertIds].sort().map((id) => `al:${id}`);
  return fnv1a([...evidencePart, ...edgePart, ...alertPart].join("\n"));
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function freezeEvidence(evidence: Evidence): SnapshotEvidence {
  return {
    id: evidence.id,
    title: evidence.title,
    strength: evidence.strength,
    occurredAt: evidence.occurredAt,
    version: evidence.version,
  };
}

export function freezeNode(
  node: InvestigationNode,
): SnapshotNode {
  return {
    id: node.id,
    label: node.data.label,
    kind: node.data.kind,
    riskLevel: node.data.riskLevel,
    evidenceStrength: node.data.evidenceStrength,
    note: node.data.note,
    occurredAt: node.data.occurredAt,
  };
}

export function freezeEdge(edge: InvestigationEdge): SnapshotEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    label: edge.label,
    amount: edge.amount,
    occurredAt: edge.occurredAt,
    explanation: edge.explanation,
  };
}

interface DiffInput {
  snapshot: ConclusionSnapshot;
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  alerts: Alert[];
}

const evidenceSignature = (
  item: SnapshotEvidence | Evidence,
): string =>
  [
    item.title,
    item.strength,
    item.occurredAt,
    "version" in item ? item.version : 1,
  ].join("|");

const nodeSignature = (
  item: SnapshotNode | InvestigationNode,
): string => {
  const data = "data" in item ? item.data : item;
  return [
    data.label,
    data.kind,
    data.riskLevel,
    data.evidenceStrength,
    data.note,
    data.occurredAt,
  ].join("|");
};

const edgeSignature = (
  item: SnapshotEdge | InvestigationEdge,
): string =>
  [
    item.source,
    item.target,
    item.kind,
    item.label,
    item.amount ?? "",
    item.occurredAt,
    item.explanation,
  ].join("|");

/**
 * 影响复查：逐项比对快照与当前线索，只列出受影响资源；
 * 未变化的资源仅计数、跳过明细。
 */
export function buildImpactReview({
  snapshot,
  nodes,
  edges,
  evidence,
  alerts,
}: DiffInput): ImpactReview {
  const changes: ImpactChange[] = [];
  const alertIds = alerts.map((item) => item.id);
  const currentTimelineVersion = computeTimelineVersion({
    evidence,
    edges,
    alertIds,
  });

  const frozenNodeMap = new Map(snapshot.nodes.map((item) => [item.id, item]));
  const liveNodeMap = new Map(nodes.map((item) => [item.id, item]));
  const frozenEdgeMap = new Map(snapshot.edges.map((item) => [item.id, item]));
  const liveEdgeMap = new Map(edges.map((item) => [item.id, item]));
  const frozenEvidenceMap = new Map(
    snapshot.evidence.map((item) => [item.id, item]),
  );
  const liveEvidenceMap = new Map(evidence.map((item) => [item.id, item]));

  evidence.forEach((item) => {
    const before = frozenEvidenceMap.get(item.id);
    if (!before) {
      changes.push({
        kind: "evidence",
        changeType: "added",
        label: item.title,
        resourceId: item.id,
        detail: `快照后新增证据，来源 ${item.source}，强度 ${item.strength}。`,
      });
    } else if (evidenceSignature(before) !== evidenceSignature(item)) {
      changes.push({
        kind: "evidence",
        changeType: "modified",
        label: item.title,
        resourceId: item.id,
        detail: `证据由 V${before.version} 更新为 V${item.version}。`,
      });
    }
  });
  snapshot.evidence.forEach((item) => {
    if (!liveEvidenceMap.has(item.id)) {
      changes.push({
        kind: "evidence",
        changeType: "removed",
        label: item.title,
        resourceId: item.id,
        detail: "快照引用的证据已从台账移除。",
      });
    }
  });

  nodes.forEach((item) => {
    const before = frozenNodeMap.get(item.id);
    if (!before) {
      changes.push({
        kind: "node",
        changeType: "added",
        label: item.data.label,
        resourceId: item.id,
        detail: `新增 ${item.data.kind} 节点，来源 ${item.data.source}。`,
      });
    } else if (nodeSignature(before) !== nodeSignature(item)) {
      changes.push({
        kind: "node",
        changeType: "modified",
        label: item.data.label,
        resourceId: item.id,
        detail: "节点风险、证据强度或说明发生变化。",
      });
    }
  });
  snapshot.nodes.forEach((item) => {
    if (!liveNodeMap.has(item.id)) {
      changes.push({
        kind: "node",
        changeType: "removed",
        label: item.label,
        resourceId: item.id,
        detail: "节点已从图谱移除。",
      });
    }
  });

  edges.forEach((item) => {
    const before = frozenEdgeMap.get(item.id);
    if (!before) {
      changes.push({
        kind: "edge",
        changeType: "added",
        label: item.label,
        resourceId: item.id,
        detail: `新增关系：${item.source} → ${item.target}。`,
      });
    } else if (edgeSignature(before) !== edgeSignature(item)) {
      changes.push({
        kind: "edge",
        changeType: "modified",
        label: item.label,
        resourceId: item.id,
        detail: "关系方向、金额或解释发生变化。",
      });
    }
  });
  snapshot.edges.forEach((item) => {
    if (!liveEdgeMap.has(item.id)) {
      changes.push({
        kind: "edge",
        changeType: "removed",
        label: item.label,
        resourceId: item.id,
        detail: "关系已从图谱移除。",
      });
    }
  });

  const frozenAlerts = new Set(snapshot.alertIds);
  const liveAlerts = new Set(alertIds);
  alertIds.forEach((id) => {
    if (!frozenAlerts.has(id)) {
      const alert = alerts.find((item) => item.id === id);
      changes.push({
        kind: "alert",
        changeType: "added",
        label: alert?.title ?? id,
        resourceId: id,
        detail: "结论提交后又关联了新告警。",
      });
    }
  });
  snapshot.alertIds.forEach((id) => {
    if (!liveAlerts.has(id)) {
      changes.push({
        kind: "alert",
        changeType: "removed",
        label: id,
        resourceId: id,
        detail: "快照中的告警已解除关联。",
      });
    }
  });

  const changedIds = new Set(changes.map((item) => item.resourceId));
  const countUnchanged = <T>(list: T[], idOf: (item: T) => string) =>
    list.filter((item) => !changedIds.has(idOf(item))).length;

  return {
    snapshotId: snapshot.id,
    caseId: snapshot.caseId,
    state: snapshot.state,
    timelineVersion: snapshot.timelineVersion,
    currentTimelineVersion,
    changes,
    unchanged: {
      evidence: countUnchanged(evidence, (item) => item.id),
      node: countUnchanged(nodes, (item) => item.id),
      edge: countUnchanged(edges, (item) => item.id),
      alert: countUnchanged(alerts, (item) => item.id),
      timeline:
        snapshot.timelineVersion === currentTimelineVersion ? 1 : 0,
    },
  };
}
