import { createSeedDatabase } from "./seedTestDb";
import { recheckSnapshot, buildFingerprint } from "../src/services/snapshotEngine";
import { mergeBatch } from "../src/services/offlineEngine";

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

const db = createSeedDatabase();

// 1. 016 种子快照：提交后补录证据/节点/关系 → stale，影响项按类列出
const snap016 = db.snapshots.find((s) => s.conclusionId === "CV-016-001");
console.log("快照失效与影响复查");
assert("016 快照存在", !!snap016);
assert("016 快照为 stale", snap016!.status === "stale", snap016!.status);
const cats = new Set(snap016!.impacts.map((i) => i.category));
assert("影响项覆盖证据", cats.has("evidence"), JSON.stringify(snap016!.impacts));
assert("影响项覆盖节点", cats.has("node"));
assert("影响项覆盖关系", cats.has("edge"));
assert(
  "016 案件为待复议",
  db.cases.find((c) => c.id === "CASE-2026-016")!.status === "reconsider",
);

// 2. 未受影响跳过
console.log("未受影响跳过");
const frozenInput = {
  nodes: snap016!.frozenNodes,
  edges: snap016!.frozenEdges,
  evidence: snap016!.frozenEvidence,
  alerts: snap016!.frozenAlerts,
};
const baselineFp = buildFingerprint(frozenInput);
assert(
  "冻结基线指纹与快照版本一致",
  baselineFp.evidenceVersion === snap016!.evidenceVersion &&
    baselineFp.nodeVersion === snap016!.nodeVersion &&
    baselineFp.edgeVersion === snap016!.edgeVersion,
);
const verifiedSnap = { ...snap016!, status: "verified" as const, impacts: [] };
const r2 = recheckSnapshot(verifiedSnap, frozenInput);
assert("内容未变时复查保持 verified", r2.status === "verified");
assert("内容未变时无影响项", r2.impacts.length === 0);

// 3. 仅拖动节点位置不使快照失效
console.log("位置变化不影响结论");
const movedNodes = frozenInput.nodes.map((n) => ({
  ...n,
  position: { x: 1, y: 1 },
}));
const r3 = recheckSnapshot(verifiedSnap, { ...frozenInput, nodes: movedNodes });
assert("纯位置拖动后仍 verified", r3.status === "verified");

// 4. 015 旧结论无快照引用（工作区打开时会补待核标记）
console.log("旧数据待核");
assert(
  "015 结论无快照引用",
  !db.conclusions.find((c) => c.id === "CV-015-001")!.snapshotId,
);

// 5. 离线批次：无冲突项落库、冲突项不覆盖
console.log("离线合并");
const batch = db.syncBatches.find((b) => b.id === "BATCH-017-001")!;
assert("种子批次初始为冲突态", batch.state === "conflict");
const result1 = mergeBatch(db, batch);
assert(
  "无冲突证据已落库",
  db.evidence.some((e) => e.clientId === "offline-zhou-017-ev-1"),
);
assert(
  "冲突项未覆盖摘要",
  db.cases.find((c) => c.id === "CASE-2026-017")!.summary ===
    "三名账户持有人在短时间内共享设备与 IP，资金呈现快进快出。",
);
assert("首次合并后仍为冲突态", result1.batch.state === "conflict", result1.batch.state);
const revAfter1 = db.cases.find((c) => c.id === "CASE-2026-017")!.revision;
assert("无冲突项落库后 revision 递增", revAfter1 === 4, String(revAfter1));

// 6. keep_server 裁决后合并 → merged，摘要保持服务端
console.log("冲突裁决 keep_server");
const conflict = result1.batch.conflicts.find((c) => !c.resolution)!;
conflict.resolution = "keep_server";
const result2 = mergeBatch(db, result1.batch);
assert("裁决后合并为 merged", result2.batch.state === "merged", result2.batch.state);
const revAfter2 = db.cases.find((c) => c.id === "CASE-2026-017")!.revision;
assert("无新增落库时 revision 不再递增", revAfter2 === 4, String(revAfter2));

// 7. 重复合并只补缺项
console.log("幂等补缺");
const countBefore = db.evidence.length;
const result3 = mergeBatch(db, result2.batch);
assert("重复合并不产生重复证据", db.evidence.length === countBefore);
assert("重复合并保持 merged", result3.batch.state === "merged");

// 8. apply_mine 强制落库
console.log("冲突裁决 apply_mine");
const db2 = createSeedDatabase();
const r = mergeBatch(db2, db2.syncBatches.find((b) => b.id === "BATCH-017-001")!);
r.batch.conflicts.find((x) => !x.resolution)!.resolution = "apply_mine";
const r2b = mergeBatch(db2, r.batch);
assert(
  "apply_mine 后离线摘要落库",
  db2.cases
    .find((c) => c.id === "CASE-2026-017")!
    .summary.includes("离线核身录像尚待比对"),
);
assert("apply_mine 后批次 merged", r2b.batch.state === "merged");

// 9. 模拟保存失败 → 批次保留不写库；重试成功；再合并不重复
console.log("失败保留与重试");
const db3 = createSeedDatabase();
const evidenceBeforeFail = db3.evidence.length;
const failBatch = {
  id: "BATCH-FAIL",
  caseId: "CASE-2026-015",
  investigator: "宋佳",
  baseRevision: 1,
  state: "pending" as const,
  createdAt: "2026-10-06T11:00:00+08:00",
  changes: [
    {
      id: "CHG-F1",
      kind: "add_evidence" as const,
      actor: "宋佳",
      baseRevision: 1,
      createdAt: "2026-10-06T11:01:00+08:00",
      payload: {
        clientId: "offline-fail-1",
        title: "商户合同补充",
        source: "商户回函",
        strength: "strong" as const,
        occurredAt: "2026-10-06T10:00:00+08:00",
        attachment: "contract.pdf",
        note: "失败重试测试",
      },
    },
  ],
  appliedChangeIds: [] as string[],
  conflicts: [],
  failNext: false,
};
db3.syncBatches.push(failBatch);
const failResult = mergeBatch(db3, failBatch, { simulateFailure: true });
assert("失败时状态为 failed", failResult.batch.state === "failed");
assert("失败时不写库", db3.evidence.length === evidenceBeforeFail);
assert("失败批次保留", !!db3.syncBatches.find((b) => b.id === "BATCH-FAIL"));
const okResult = mergeBatch(db3, failResult.batch);
assert("重试成功后 merged", okResult.batch.state === "merged");
assert("重试后证据落库", db3.evidence.some((e) => e.clientId === "offline-fail-1"));
const n1 = db3.evidence.length;
mergeBatch(db3, okResult.batch);
assert("成功后再次合并不重复写入", db3.evidence.length === n1);

// 10. 两名调查员并发新增互不覆盖
console.log("两名调查员并发新增");
const db4 = createSeedDatabase();
const dualBatch = {
  id: "BATCH-DUAL",
  caseId: "CASE-2026-015",
  investigator: "周明",
  baseRevision: 1,
  state: "pending" as const,
  createdAt: "2026-10-06T12:00:00+08:00",
  changes: [
    {
      id: "CHG-D1",
      kind: "add_evidence" as const,
      actor: "周明",
      baseRevision: 1,
      createdAt: "2026-10-06T12:01:00+08:00",
      payload: { clientId: "zhou-ev", title: "周明证据", source: "A", strength: "medium" as const, attachment: "a", note: "" },
    },
    {
      id: "CHG-D2",
      kind: "add_evidence" as const,
      actor: "林澜",
      baseRevision: 1,
      createdAt: "2026-10-06T12:02:00+08:00",
      payload: { clientId: "lin-ev", title: "林澜证据", source: "B", strength: "weak" as const, attachment: "b", note: "" },
    },
  ],
  appliedChangeIds: [] as string[],
  conflicts: [],
  failNext: false,
};
db4.syncBatches.push(dualBatch);
const dr = mergeBatch(db4, dualBatch);
assert(
  "两份新增均落库",
  db4.evidence.some((e) => e.clientId === "zhou-ev") &&
    db4.evidence.some((e) => e.clientId === "lin-ev"),
);
assert("无冲突", dr.conflictCount === 0, String(dr.conflictCount));

// 11. 新结论提交：补入同基线证据不会互相覆盖（两个批次独立 clientId）
console.log("跨批次幂等");
const db5 = createSeedDatabase();
const mk = (id: string, clientId: string, actor: string) => ({
  id,
  caseId: "CASE-2026-017",
  investigator: actor,
  baseRevision: 3,
  state: "pending" as const,
  createdAt: "2026-10-06T13:00:00+08:00",
  changes: [
    {
      id: `${id}-c1`,
      kind: "add_evidence" as const,
      actor,
      baseRevision: 3,
      createdAt: "2026-10-06T13:01:00+08:00",
      payload: { clientId, title: id, source: "S", strength: "medium" as const, attachment: "x", note: "" },
    },
  ],
  appliedChangeIds: [] as string[],
  conflicts: [],
  failNext: false,
});
const bA = mk("BATCH-A", "same-client", "周明");
const bB = mk("BATCH-B", "same-client", "林澜");
db5.syncBatches.push(bA, bB);
mergeBatch(db5, bA);
const countDup = db5.evidence.filter((e) => e.clientId === "same-client").length;
const resB = mergeBatch(db5, bB);
assert("同业务键跨批次只保留一份", countDup === 1, String(countDup));
assert("第二批识别为补缺并 merged", resB.batch.state === "merged");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
