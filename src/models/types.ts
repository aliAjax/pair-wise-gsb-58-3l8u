export type RiskLevel = "high" | "medium" | "low";
export type AlertStatus = "new" | "triage" | "linked" | "dismissed";
export type CaseStatus =
  | "investigating"
  | "pending_review"
  | "supplement"
  | "reconsider"
  | "closed";
export type SnapshotState = "current" | "stale" | "pending_backfill";
export type SyncBatchState = "pending" | "save_failed" | "merged";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type NodeKind = "account" | "device" | "ip" | "merchant";
export type EdgeKind = "transfer" | "shared_device" | "shared_ip" | "payee";
export type CaseDisposition = "freeze" | "release" | "observe";
export type ConclusionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "returned";

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
}

export type SnapshotResourceKind =
  | "evidence"
  | "node"
  | "edge"
  | "alert"
  | "timeline";

export interface SnapshotEvidence {
  id: string;
  title: string;
  strength: EvidenceStrength;
  occurredAt: string;
  version: number;
}

export interface SnapshotNode {
  id: string;
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  evidenceStrength: EvidenceStrength;
  note: string;
  occurredAt: string;
}

export interface SnapshotEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
}

export interface ConclusionSnapshot {
  id: string;
  caseId: string;
  conclusionId: string;
  version: number;
  state: SnapshotState;
  createdAt: string;
  /** 固化时案件状态，影响复查确认无实质变更时恢复 */
  baseCaseStatus: CaseStatus;
  /** 快照固化时间线版本（证据 + 关系 + 告警的稳定摘要） */
  timelineVersion: string;
  evidence: SnapshotEvidence[];
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  alertIds: string[];
  /** 旧数据补录记录 */
  backfilledAt?: string;
  backfilledBy?: string;
}

export interface ImpactChange {
  kind: SnapshotResourceKind;
  changeType: "added" | "removed" | "modified";
  label: string;
  resourceId: string;
  detail: string;
}

export interface ImpactReview {
  snapshotId: string;
  caseId: string;
  state: SnapshotState;
  timelineVersion: string;
  currentTimelineVersion: string;
  changes: ImpactChange[];
  unchanged: Record<SnapshotResourceKind, number>;
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
}

export interface AuditLog {
  id: string;
  caseId?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export type OfflineOperationType =
  | "add_evidence"
  | "add_node"
  | "add_relation";

export interface OfflineOperation {
  id: string;
  caseId: string;
  investigator: string;
  type: OfflineOperationType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SyncBatch {
  id: string;
  caseId: string;
  investigator: string;
  device: string;
  state: SyncBatchState;
  /** 批次创建（首个离线操作登记）时的图谱/证据基线 */
  baseline: {
    nodeCount: number;
    edgeCount: number;
    evidenceCount: number;
    timelineVersion: string;
  };
  operations: OfflineOperation[];
  createdAt: string;
  mergedAt?: string;
  /** 已成功并入主库的操作 id，重复合并时据此只补缺项 */
  appliedOpIds: string[];
  lastError?: string;
}

export type MergeConflictResolution = "keep_remote" | "keep_local" | "keep_both";

export interface MergeConflict {
  key: string;
  kind: "evidence" | "relation";
  label: string;
  local: { investigator: string; device: string; summary: string };
  remote: { investigator: string; summary: string };
  localBaselineSummary: string;
  remoteBaselineSummary: string;
  resolution?: MergeConflictResolution;
}

export interface SyncBatchMergeResult {
  batchId: string;
  caseId: string;
  state: SyncBatchState;
  appliedCount: number;
  skippedDuplicateCount: number;
  conflicts: MergeConflict[];
  mergedAt?: string;
  lastError?: string;
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
  timelineVersion: string;
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
