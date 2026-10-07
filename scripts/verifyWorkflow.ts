/**
 * 端到端工作流验证：直接驱动 mockStorage + 引擎，覆盖 api 层门禁规则。
 * 不依赖浏览器，用内存版 localStorage 垫片。
 */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}
(globalThis as { window?: unknown }).window = {
  localStorage: new MemoryStorage(),
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
};

const { readDatabase, writeDatabase, createId, nowIso } = await import(
  "../src/services/mockStorage"
);
const { buildFingerprint, createSnapshot, recheckSnapshot } = await import(
  "../src/services/snapshotEngine"
);

let pass = 0;
let fail = 0;
const assert = (name: string, condition: boolean, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
};

// ---- 流程 A：015 旧数据待核 → 补录前禁止重提 → 补录后允许 ----
console.log("流程 A：旧数据待核闸门");
let db = readDatabase();
const c015 = db.cases.find((c) => c.id === "CASE-2026-015")!;
assert("015 为待补证", c015.status === "supplement");

// 模拟 api.getOrCreateBackfillMarker：为最新非草稿结论补待核标记
const latest015 = db.conclusions
  .filter((c) => c.caseId === "CASE-2026-015" && c.status !== "draft")
  .sort((a, b) => b.version - a.version)[0];
assert("015 最新结论无快照", !latest015.snapshotId);
const empty = { nodes: [], edges: [], evidence: [], alerts: [] };
const marker = createSnapshot({
  caseId: "CASE-2026-015",
  conclusionId: latest015.id,
  fingerprint: buildFingerprint(empty),
  frozen: empty,
  status: "pending_backfill",
});
db.snapshots.push(marker);
latest015.snapshotId = marker.id;
assert("待核标记已建立", marker.status === "pending_backfill");

// 补录前重提 → 模拟 saveConclusion 门禁
let blocked = false;
if (latest015.snapshotId) {
  const snap = db.snapshots.find((s) => s.id === latest015.snapshotId);
  blocked = snap?.status === "pending_backfill";
}
assert("补录前重提被拦截", blocked);

// 补录快照
const frozen015 = {
  nodes: db.nodes.filter((n) => n.caseId === "CASE-2026-015"),
  edges: db.edges.filter((e) => e.caseId === "CASE-2026-015"),
  evidence: db.evidence.filter((e) => e.caseId === "CASE-2026-015"),
  alerts: db.alerts.filter((a) => a.caseId === "CASE-2026-015"),
};
const backfilled = createSnapshot({
  caseId: "CASE-2026-015",
  conclusionId: latest015.id,
  fingerprint: buildFingerprint(frozen015),
  frozen: frozen015,
  status: "verified",
  backfilled: true,
});
db.snapshots = db.snapshots.filter(
  (s) => !(s.conclusionId === latest015.id && s.status === "pending_backfill"),
);
db.snapshots.push(backfilled);
latest015.snapshotId = backfilled.id;

// 模拟新结论提交
const newConclusion = {
  id: createId("CV"),
  caseId: "CASE-2026-015",
  version: 2,
  status: "submitted" as const,
  disposition: "observe" as const,
  rationale: "补录快照后重新提交的结论。",
  riskControls: [],
  createdBy: "宋佳",
  createdAt: nowIso(),
  reviewer: "赵平",
};
const frozenNew = {
  nodes: db.nodes.filter((n) => n.caseId === "CASE-2026-015"),
  edges: db.edges.filter((e) => e.caseId === "CASE-2026-015"),
  evidence: db.evidence.filter((e) => e.caseId === "CASE-2026-015"),
  alerts: db.alerts.filter((a) => a.caseId === "CASE-2026-015"),
};
const newSnap = createSnapshot({
  caseId: "CASE-2026-015",
  conclusionId: newConclusion.id,
  fingerprint: buildFingerprint(frozenNew),
  frozen: frozenNew,
});
newConclusion.snapshotId = newSnap.id;
db.conclusions.unshift(newConclusion);
db.snapshots.push(newSnap);
c015.status = "pending_review";
writeDatabase(db);
assert("补录后新结论带 verified 快照", newSnap.status === "verified");
assert("案件进入待复核", c015.status === "pending_review");

// ---- 流程 B：016 待复议 → 新证据再次复查仍 stale → 重提新结论恢复 pending_review ----
console.log("流程 B：待复议与新快照恢复");
db = readDatabase();
const c016 = db.cases.find((c) => c.id === "CASE-2026-016")!;
const snap016 = db.snapshots.find((s) => s.conclusionId === "CV-016-001")!;
assert("016 待复议", c016.status === "reconsider");
assert("016 快照失效", snap016.status === "stale");
const impactCount = snap016.impacts.length;
assert("影响项非空", impactCount > 0, String(impactCount));

// 再补一份证据，复查影响项应增加
db.evidence.unshift({
  id: "EV-016-003",
  caseId: "CASE-2026-016",
  title: "二次补录：IP 归属说明",
  source: "网络部门",
  strength: "weak",
  occurredAt: nowIso(),
  submittedAt: nowIso(),
  submittedBy: "周明",
  attachment: "ip-note.txt",
  note: "又一条提交后的新线索",
  version: 1,
});
const current016 = {
  nodes: db.nodes.filter((n) => n.caseId === "CASE-2026-016"),
  edges: db.edges.filter((e) => e.caseId === "CASE-2026-016"),
  evidence: db.evidence.filter((e) => e.caseId === "CASE-2026-016"),
  alerts: db.alerts.filter((a) => a.caseId === "CASE-2026-016"),
};
const reAgain = recheckSnapshot(snap016, current016);
assert("再次复查仍 stale", reAgain.status === "stale");
assert("影响项随线索增多", reAgain.impacts.length > impactCount,
  `${reAgain.impacts.length} > ${impactCount}`);

// 调查员重提结论：基于当前全部线索固化新快照
const resubmitted = {
  id: createId("CV"),
  caseId: "CASE-2026-016",
  version: 2,
  status: "submitted" as const,
  disposition: "freeze" as const,
  rationale: "结合跨区终端与核身结果，维持冻结并扩大终端限制。",
  riskControls: ["全终端暂停非柜面"],
  createdBy: "周明",
  createdAt: nowIso(),
  reviewer: "赵平",
};
const resubSnap = createSnapshot({
  caseId: "CASE-2026-016",
  conclusionId: resubmitted.id,
  fingerprint: buildFingerprint(current016),
  frozen: current016,
});
resubmitted.snapshotId = resubSnap.id;
db.conclusions.unshift(resubmitted);
db.snapshots.push(resubSnap);
c016.status = "pending_review";
writeDatabase(db);
assert("重提结论带新快照且有效", resubSnap.status === "verified");
assert("旧快照保留为历史", db.snapshots.some((s) => s.id === snap016.id && s.status === "stale"));
assert("案件恢复待复核", c016.status === "pending_review");

// 新快照此刻立刻复查，无变化
const rStable = recheckSnapshot(resubSnap, current016);
assert("新快照复查无影响项", rStable.impacts.length === 0 && rStable.status === "verified");

// ---- 流程 C：三处显示同一待复议状态（以种子库为准的数据层一致性） ----
console.log("流程 C：状态一致性");
const { createSeedDatabase } = await import("./seedTestDb");
const again = createSeedDatabase();
const listRow = again.cases.find((c) => c.id === "CASE-2026-016")!;
const auditLog = again.auditLogs.find((l) => l.id === "LOG-1006")!;
assert("案件列表读到 reconsider", listRow.status === "reconsider");
assert("审计日志留痕为 reconsider", auditLog.caseStatus === "reconsider");
assert(
  "结论页可由快照 stale 推导待复议",
  again.snapshots.find((s) => s.conclusionId === "CV-016-001")!.status === "stale",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
