export type RiskLevel = "high" | "medium" | "low";
export type AlertStatus = "new" | "triage" | "linked" | "dismissed";
export type CaseStatus =
  | "investigating"
  | "pending_review"
  | "supplement"
  | "reconsider"
  | "closed";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type NodeKind = "account" | "device" | "ip" | "merchant";
export type EdgeKind = "transfer" | "shared_device" | "shared_ip" | "payee";
export type CaseDisposition = "freeze" | "release" | "observe";
export type ConclusionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "returned";
export type SnapshotStatus = "verified" | "stale" | "pending_backfill";
export type OfflineChangeKind =
  | "add_evidence"
  | "add_node"
  | "update_summary"
  | "update_node_note";
export type SyncBatchState = "pending" | "merged" | "conflict" | "failed";

export interface Alert {
  id: string;
  title: string;
  account: string;
  counterparty: string;
  channel: string;
  amount: number;
  riskLevel: RiskLevel;
  score: number;
  status: AlertStatus;
  detectedAt: string;
  tags: string[];
  deviceId: string;
  ip: string;
  caseId?: string;
}

export interface GraphNodeData {
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
}

export interface InvestigationNode {
  id: string;
  caseId: string;
  position: { x: number; y: number };
  data: GraphNodeData;
  /** 离线合并时用于幂等去重的客户端临时标识 */
  clientId?: string;
}

export interface InvestigationEdge {
  id: string;
  caseId: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  version: number;
  /** 离线合并时用于幂等去重的客户端临时标识 */
  clientId?: string;
}

/** 快照影响复查条目：仅记录与结论相关、内容真正变化的线索 */
export interface SnapshotImpactItem {
  id: string;
  category: "evidence" | "node" | "edge" | "timeline";
  label: string;
  changeType: "added" | "removed" | "modified";
  detail: string;
}

/** 结论提交时固化的证据、图谱关系与时间线版本 */
export interface ConclusionSnapshot {
  id: string;
  caseId: string;
  conclusionId: string;
  status: SnapshotStatus;
  createdAt: string;
  recheckedAt?: string;
  /** 提交时各分类内容指纹，用于增量比对 */
  evidenceVersion: string;
  nodeVersion: string;
  edgeVersion: string;
  timelineVersion: string;
  evidenceCount: number;
  nodeCount: number;
  edgeCount: number;
  timelineCount: number;
  /** 最新一次影响复查结果；未受影响的线索不会出现 */
  impacts: SnapshotImpactItem[];
  recheckNote?: string;
  /** 旧结论补录快照后保留的说明 */
  backfilled?: boolean;
  /** 提交时刻固化的线索明细，作为后续影响复查的基线 */
  frozenEvidence: Evidence[];
  frozenNodes: InvestigationNode[];
  frozenEdges: InvestigationEdge[];
  frozenAlerts: Alert[];
}

export interface ConclusionVersion {
  id: string;
  caseId: string;
  version: number;
  status: ConclusionStatus;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  createdBy: string;
  createdAt: string;
  reviewer: string;
  reviewerNote?: string;
  /** 提交时生成的快照 ID；草稿与旧结论可能为空 */
  snapshotId?: string;
}

export interface InvestigationCase {
  id: string;
  title: string;
  status: CaseStatus;
  riskLevel: RiskLevel;
  owner: string;
  openedAt: string;
  updatedAt: string;
  summary: string;
  alertIds: string[];
  nextReviewAt: string;
  /** 案件线索版本号，离线批次每合并成功一次递增 */
  revision: number;
}

export interface AuditLog {
  id: string;
  caseId?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  /** 审计页按案件状态统一展示（取留痕时刻的案件状态） */
  caseStatus?: CaseStatus;
}

/** 离线调查员在本地产生的单条改动 */
export interface OfflineChange {
  id: string;
  kind: OfflineChangeKind;
  actor: string;
  /** 改动所基于的案件 revision */
  baseRevision: number;
  createdAt: string;
  payload: {
    title?: string;
    source?: string;
    strength?: EvidenceStrength;
    occurredAt?: string;
    attachment?: string;
    note?: string;
    nodeLabel?: string;
    nodeKind?: NodeKind;
    riskLevel?: RiskLevel;
    evidenceStrength?: EvidenceStrength;
    evidenceSource?: string;
    nodeId?: string;
    summary?: string;
    relationKind?: EdgeKind;
    relationLabel?: string;
    relationExplanation?: string;
    amount?: number;
    clientId?: string;
  };
}

export interface SyncConflictItem {
  changeId: string;
  kind: OfflineChangeKind;
  actor: string;
  baseRevision: number;
  /** 该调查员基线时的内容 */
  baseline: string;
  /** 服务端当前内容 */
  current: string;
  description: string;
  resolution?: "keep_server" | "apply_mine";
}

/** 离线合并批次：保存失败后保留，可重试；重复合并只补缺项 */
export interface SyncBatch {
  id: string;
  caseId: string;
  investigator: string;
  baseRevision: number;
  state: SyncBatchState;
  createdAt: string;
  mergedAt?: string;
  changes: OfflineChange[];
  /** 已成功落库的变更 ID，用于重试时只补缺项 */
  appliedChangeIds: string[];
  conflicts: SyncConflictItem[];
  lastError?: string;
  /** 演示用：下一次合并模拟保存失败 */
  failNext: boolean;
}

export interface AlertFilters {
  keyword: string;
  riskLevel: RiskLevel | "all";
  status: AlertStatus | "all";
  channel: string;
}

export interface CaseWorkspace {
  case: InvestigationCase;
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  snapshots: ConclusionSnapshot[];
  syncBatches: SyncBatch[];
}

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  totalExposure: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}
