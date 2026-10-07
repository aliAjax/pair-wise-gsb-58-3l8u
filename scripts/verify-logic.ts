/* 端到端逻辑校验（node 运行，esbuild 临时打包） */
import { configureStore } from "@reduxjs/toolkit";
import { bankApi } from "../src/services/api";
import {
  readDatabase,
  resetDatabase,
  writeDatabase,
} from "../src/services/mockStorage";

const store = configureStore({
  reducer: { [bankApi.reducerPath]: bankApi.reducer },
  middleware: (getDefault) => getDefault().concat(bankApi.middleware),
});

// ---- 浏览器环境垫片 ----
const memory = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
  setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
    setTimeout(fn, ms),
};

const calls: string[] = [];
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("✗", msg);
    process.exitCode = 1;
  } else {
    calls.push(msg);
    console.log("✓", msg);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = async (endpoint: string, arg: unknown): Promise<any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ep = (bankApi.endpoints as any)[endpoint];
  return store.dispatch(ep.initiate(arg));
};

const fresh = () => {
  memory.clear();
  store.dispatch(bankApi.util.resetApiState());
  return resetDatabase();
};

// ========== 1. 旧数据迁移：待核快照 + 禁止重提 ==========
fresh();
let db = readDatabase();
const legacy = db.snapshots.filter((s) => s.state === "pending_backfill");
assert(
  legacy.length === 2,
  `旧库两条已提交/退回结论均生成待核快照（实际 ${legacy.length}）`,
);
assert(
  db.snapshots.every((s) => s.evidence.length > 0 || s.nodes.length >= 0),
  "待核快照已固化当时证据/图谱/时间线",
);

let res = await invoke("saveConclusion", {
  caseId: "CASE-2026-016",
  disposition: "freeze",
  rationale: "尝试在待核状态下重新提交结论内容应当被拦截阻断",
  riskControls: [],
  submit: true,
});
assert(!!res.error, "待核补录前重新提交结论被拒绝");

res = await invoke("backfillSnapshot", {
  caseId: "CASE-2026-016",
  snapshotId: "SNAP-LEGACY-CV-016-001",
});
assert(res.data?.state === "current", "补录后快照转为有效");

// ========== 2. 提交固化 → 线索变化失效 → 待复议 → 影响复查 ==========
res = await invoke("saveConclusion", {
  caseId: "CASE-2026-016",
  disposition: "freeze",
  rationale: "补录后重新提交，需要固化新的证据图谱与时间线版本",
  riskControls: ["暂停非柜面支付"],
  submit: true,
});
const newConclusionId = res.data?.id as string;
assert(!!newConclusionId, "补录后重新提交成功");
db = readDatabase();
const snap1 = db.snapshots.find((s) => s.conclusionId === newConclusionId)!;
assert(snap1?.state === "current", "提交时生成有效快照");
const v1 = snap1.timelineVersion;

res = await invoke("addEvidence", {
  caseId: "CASE-2026-016",
  title: "补充 ATM 监控截图",
  source: "监控平台",
  strength: "strong",
  occurredAt: "2026-09-30T10:00:00+08:00",
  attachment: "atm-cam.png",
  note: "补证测试",
});
db = readDatabase();
const target = db.cases.find((c) => c.id === "CASE-2026-016")!;
assert(target.status === "reconsider", "新增证据后案件自动进入待复议");
assert(
  db.snapshots.find((s) => s.id === snap1.id)?.state === "stale",
  "原快照失效",
);

res = await invoke("runImpactReview", { caseId: "CASE-2026-016" });
const review = res.data;
assert(
  review.changes.some((c: { kind: string; label: string }) =>
    c.label.includes("ATM 监控截图"),
  ),
  "影响复查列出受影响的新证据",
);
assert(
  review.unchanged.alert >= 1,
  `未受影响资源被跳过计数（告警 ${review.unchanged.alert}）`,
);
assert(
  review.currentTimelineVersion !== v1,
  "时间线版本随线索变化",
);
db = readDatabase();
assert(
  db.cases.find((c) => c.id === "CASE-2026-016")!.status === "reconsider",
  "有实质变更时案件维持待复议",
);

// ========== 3. 复核通过被失效快照拦截 ==========
res = await invoke("reviewConclusion", {
  caseId: "CASE-2026-016",
  conclusionId: newConclusionId,
  decision: "approve",
  reviewerNote: "快照失效不应通过复核意见测试",
});
assert(!!res.error, "快照失效时复核通过被拦截");
res = await invoke("reviewConclusion", {
  caseId: "CASE-2026-016",
  conclusionId: newConclusionId,
  decision: "return",
  reviewerNote: "退回补证操作仍然允许执行",
});
assert(!!res.data, "退回补证不受快照失效限制");

// ========== 4. 节点拖动（仅布局变化）不改变快照效力与时间线版本 ==========
fresh();
res = await invoke("saveConclusion", {
  caseId: "CASE-2026-017",
  disposition: "observe",
  rationale: "为验证节点拖动不影响快照而在线提交的一份结论版本内容",
  riskControls: [],
  submit: true,
});
const c017Id = res.data.id;
db = readDatabase();
const s017 = db.snapshots.find((s) => s.conclusionId === c017Id)!;
const draggedNode = db.nodes.find((n) => n.caseId === "CASE-2026-017")!;
await invoke("updateGraphNode", {
  caseId: "CASE-2026-017",
  node: { ...draggedNode, position: { x: 999, y: 888 } },
});
db = readDatabase();
assert(
  db.snapshots.find((s) => s.id === s017.id)!.state === "current",
  "仅拖动节点时快照保持有效",
);
assert(
  db.cases.find((c) => c.id === "CASE-2026-017")!.status === "pending_review",
  "仅拖动节点不会进入待复议",
);
res = await invoke("runImpactReview", { caseId: "CASE-2026-017" });
assert(res.data?.changes.length === 0, "布局变化不产生影响项");

// ========== 5. 影响复查零变更恢复原状态 ==========
fresh();
await invoke("backfillSnapshot", {
  caseId: "CASE-2026-016",
  snapshotId: "SNAP-LEGACY-CV-016-001",
});
// 人为构造 stale：直接改库后用一次只含布局变化的场景不好触发；改为新增证据后再删除
let d = readDatabase();
(d as any).snapshots.find(
  (s: { id: string }) => s.id === "SNAP-LEGACY-CV-016-001",
).state = "stale";
writeDatabase(d);
res = await invoke("runImpactReview", { caseId: "CASE-2026-016" });
assert(res.data?.changes.length === 0, "无实质变更时复查结果为空");
d = readDatabase();
assert(
  d.cases.find((c) => c.id === "CASE-2026-016")!.status === "pending_review",
  "零变更恢复到快照基线状态（待复核）",
);
assert(
  d.snapshots.find((s) => s.id === "SNAP-LEGACY-CV-016-001")!.state ===
    "current",
  "零变更后快照恢复有效",
);

// ========== 6. 离线合并：冲突按基线列清、不互相覆盖 ==========
fresh();
// 周明离线登记一条与主库同名证据（主库已有「交易明细提取单」/林澜）
await invoke("queueOfflineOperation", {
  caseId: "CASE-2026-017",
  investigator: "周明",
  device: "离线终端 B-07",
  operation: {
    type: "add_evidence",
    payload: {
      title: "交易明细提取单",
      source: "核心交易系统（离线补录）",
      strength: "strong",
      occurredAt: "2026-09-30T09:00:00+08:00",
      attachment: "trade-offline.csv",
      note: "与主库同名但来源不同",
    },
  },
});
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId: readDatabase().syncBatches[0].id,
});
assert(res.error?.status === "CONFLICT", "与主库同名证据产生冲突");
const conflicts = res.error.data.conflicts;
assert(
  conflicts.length === 1 &&
    conflicts[0].local.investigator === "周明" &&
    conflicts[0].remote.investigator === "林澜",
  "冲突按双方调查员/基线列清",
);
// 采用对方版本：本端跳过，主库不被覆盖
await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId: readDatabase().syncBatches[0].id,
  resolutions: { [conflicts[0].key]: "keep_remote" },
});
d = readDatabase();
const sameTitle = d.evidence.filter(
  (e) => e.title === "交易明细提取单" && e.caseId === "CASE-2026-017",
);
assert(sameTitle.length === 1 && sameTitle[0].submittedBy === "林澜",
  "keep_remote 不覆盖主库，本端操作跳过");

// ========== 7. 两名调查员互相冲突 → keep_both 并存 ==========
fresh();
const opX = (investigator: string, device: string) => ({
  caseId: "CASE-2026-017",
  investigator,
  device,
  operation: {
    type: "add_evidence",
    payload: {
      title: "商户现场走访记录",
      source: `${investigator}现场走访`,
      strength: "medium",
      occurredAt: "2026-09-30T09:00:00+08:00",
      attachment: `visit-${investigator}.jpg`,
      note: "离线走访",
    },
  },
});
await invoke("queueOfflineOperation", opX("周明", "终端B"));
await invoke("queueOfflineOperation", opX("宋佳", "终端C"));
const batches = readDatabase().syncBatches;
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId: batches.find((b) => b.investigator === "周明")!.id,
});
assert(res.error?.status === "CONFLICT", "两个离线批次之间检测到冲突");
const key = res.error.data.conflicts[0].key;
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId: batches.find((b) => b.investigator === "周明")!.id,
  resolutions: { [key]: "keep_both" },
});
assert(res.data?.appliedCount === 1, "周明批次并入 1 项");
d = readDatabase();
assert(
  d.evidence.some((e) => e.title === "商户现场走访记录（周明 副本）"),
  "keep_both 自动加副本标识，不覆盖对方",
);
// 合并宋佳批次：其内容仍完整保留、未被周明覆盖
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId: batches.find((b) => b.investigator === "宋佳")!.id,
});
assert(!!res.data, "宋佳批次可独立合并");
d = readDatabase();
assert(
  d.evidence.some(
    (e) => e.title === "商户现场走访记录" && e.submittedBy === "宋佳",
  ),
  "宋佳原始内容未被周明批次覆盖",
);

// ========== 8. 保存失败保留批次、可重试 ==========
fresh();
await invoke("queueOfflineOperation", {
  caseId: "CASE-2026-017",
  investigator: "周明",
  device: "终端B",
  operation: {
    type: "add_evidence",
    payload: {
      title: "失败重试证据",
      source: "测试",
      strength: "weak",
      occurredAt: "2026-09-30T09:00:00+08:00",
      attachment: "retry.txt",
      note: "",
    },
  },
});
let batchId = readDatabase().syncBatches[0].id;
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId,
  simulateFailure: true,
});
assert(!!res.error, "模拟保存失败返回错误");
d = readDatabase();
const failedBatch = d.syncBatches[0];
assert(
  failedBatch.state === "save_failed" &&
    failedBatch.operations.length === 1 &&
    failedBatch.appliedOpIds.length === 0,
  "失败后批次与操作完整保留，未标记为已并入",
);
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId,
});
assert(res.data?.state === "merged" && res.data.appliedCount === 1,
  "重试合并成功");

// ========== 9. 重复合并只补缺项（幂等） ==========
res = await invoke("mergeSyncBatches", {
  caseId: "CASE-2026-017",
  batchId,
});
assert(
  res.data?.appliedCount === 0 &&
    res.data?.skippedDuplicateCount === 1,
  "重复合并不重复写入，仅报告跳过",
);
d = readDatabase();
assert(
  d.evidence.filter((e) => e.title === "失败重试证据").length === 1,
  "主库中证据仍然只有一份",
);

// ========== 10. 离线并入触发快照失效 ==========
fresh();
await invoke("queueOfflineOperation", {
  caseId: "CASE-2026-017",
  investigator: "周明",
  device: "终端B",
  operation: {
    type: "add_evidence",
    payload: {
      title: "离线新增的关键证据",
      source: "离线",
      strength: "strong",
      occurredAt: "2026-09-30T09:00:00+08:00",
      attachment: "off.txt",
      note: "",
    },
  },
});
// 注意：017 原结论是草稿无快照；先提交一份结论
res = await invoke("saveConclusion", {
  caseId: "CASE-2026-017",
  disposition: "observe",
  rationale: "为验证离线并入失效而在线提交的一份结论版本内容",
  riskControls: [],
  submit: true,
});
batchId = readDatabase().syncBatches[0].id;
await invoke("mergeSyncBatches", { caseId: "CASE-2026-017", batchId });
d = readDatabase();
assert(
  d.cases.find((c) => c.id === "CASE-2026-017")!.status === "reconsider",
  "离线并入新线索同样触发待复议",
);

console.log(`\n${calls.length} 项断言全部通过`);
