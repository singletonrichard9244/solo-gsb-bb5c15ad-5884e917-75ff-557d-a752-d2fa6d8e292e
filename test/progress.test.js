'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder } = require('../src/workorder');
const { progress, ProgressError } = require('../src/progress');

/** 构造真实排程 + 工单（多纸、多批、带 dependencies） */
function realWorkOrder(opts = {}) {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [
      { width: 150, height: 120, quantity: 24 },
      { width: 80, height: 60, quantity: 30 },
    ],
  });
  const schedule = stackSchedule({ stackLimit: opts.stackLimit || 2, sheets: r.sheets });
  const wo = workOrder({
    schedule,
    maxCutsPerShift: opts.maxCutsPerShift || 100,
    maxSheetsPerBatch: opts.maxSheetsPerBatch,
  });
  return { schedule, wo };
}

/** 一把刀（批次）的精简构造（与 workorder 测试同款） */
function batchNode(no, members, extra = {}) {
  return {
    batchNo: no,
    orient: 'h', kerf: 0, position: 1,
    region: { w: 100, h: 100 }, cutLength: 100,
    totalLength: 100 * members.length, sheetCount: members.length,
    capped: false,
    members: members.map(([si, cn]) => ({ sheetIndex: si, cutNo: cn })),
    ...extra,
  };
}

function runProgress(wo, schedule, completedCutNos, extra = {}) {
  return progress({
    schedule,
    maxCutsPerShift: extra.maxCutsPerShift != null ? extra.maxCutsPerShift : 100,
    maxSheetsPerBatch: extra.maxSheetsPerBatch,
    completedCutNos,
  });
}

/* ---------------- 初始状态与结构 ---------------- */

test('现场进度：空上报时根刀全部就绪、其余阻塞，完成率为 0', () => {
  const { schedule, wo } = realWorkOrder();
  const p = runProgress(wo, schedule, []);

  assert.strictEqual(p.summary.cutsTotal, wo.summary.batchesAssigned);
  assert.strictEqual(p.summary.completedCuts, 0);
  assert.ok(p.summary.readyCuts >= 1);
  assert.strictEqual(
    p.summary.readyCuts + p.summary.blockedCuts + p.summary.completedCuts,
    p.summary.cutsTotal
  );
  assert.strictEqual(p.summary.completionRate, 0);
  assert.strictEqual(p.summary.allDone, false);

  // 就绪刀无任何待完成父刀；阻塞刀至少有一条父刀待办
  p.readyCuts.forEach((c) => {
    assert.deepStrictEqual(c.pendingParents, []);
    assert.deepStrictEqual(c.unassignedParents, []);
  });
  p.blockedCuts.forEach((c) => {
    assert.ok(c.pendingParents.length + c.unassignedParents.length > 0);
  });

  // 班次完成率存在且恒为 0
  assert.strictEqual(p.summary.shifts.length, wo.shifts.length);
  p.summary.shifts.forEach((s) => {
    assert.strictEqual(s.completedCuts, 0);
    assert.strictEqual(s.completionRate, 0);
  });
});

/* ---------------- 完成父刀后解锁（合批语义） ---------------- */

test('现场进度：完成某刀后，以它为全部父刀的刀次转入就绪；依赖合批中任一成员未满足则整批不就绪', () => {
  const { schedule, wo } = realWorkOrder();

  // 初始就绪集合（通常为各纸根刀合批），完成第一刀
  const p0 = runProgress(wo, schedule, []);
  const first = p0.readyCuts[0].cutNo;
  const p1 = runProgress(wo, schedule, [first]);

  assert.strictEqual(p1.summary.completedCuts, 1);
  assert.ok(p1.completedCuts.some((c) => c.cutNo === first));
  assert.ok(!p1.readyCuts.some((c) => c.cutNo === first));
  assert.strictEqual(p1.summary.completionRate, 1 / wo.summary.batchesAssigned);

  // 被解锁刀：其全部父刀都在已完成集合中
  const doneSet = new Set(p1.completedCutNos);
  p1.readyCuts.forEach((c) => {
    c.pendingParents.forEach((pp) => assert.ok(doneSet.has(pp) === false));
    assert.deepStrictEqual(c.pendingParents, []);
  });

  // 构造合批场景：批次 2 合并了两张纸的刀，其中一张的父刀在批次 1、另一张在批次 3。
  // 只完成批次 1 时，合批刀次仍须阻塞，pendingParents 指向全局第 3 刀。
  const merged = {
    stackLimit: 2,
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2], [2, 2]]), // 合批：纸1 的父 1 已就绪；纸2 的父 1 同批 ✓
      batchNode(3, [[3, 1]]),
      batchNode(4, [[2, 3], [3, 2]]), // 合批：纸2#3 父 2（批2）、纸3#2 父 1（批3）
    ],
    dependencies: [
      [[2, 1]],
      [[2, 1], [3, 2]],
      [[2, 1]],
    ],
  };
  const wo2 = workOrder({ schedule: merged, maxCutsPerShift: 100 });
  // 完成批 1、批 2（全局 1、2 刀）后，批 4 仍因纸3#2 的父刀（全局 3 刀）未完成而阻塞
  const pm = runProgress(wo2, merged, [1, 2]);
  const cut4 = pm.blockedCuts.find((c) => c.batchNo === 4);
  assert.ok(cut4, '批内任一纸张父刀未完成时该合批刀次不可就绪');
  assert.deepStrictEqual(cut4.pendingParents, [3]);
  // 再完成全局第 3 刀即解锁
  const pm2 = runProgress(wo2, merged, [1, 2, 3]);
  assert.ok(pm2.readyCuts.some((c) => c.batchNo === 4));
});

test('现场进度：按拓扑顺序完成全部刀次后整单完成率 100%，allDone=true', () => {
  const { schedule, wo } = realWorkOrder();
  // 工单本身是稳定拓扑序，全局刀号 1..N 即合法完成顺序
  const all = Array.from({ length: wo.summary.batchesAssigned }, (_, i) => i + 1);
  const p = runProgress(wo, schedule, all);
  assert.strictEqual(p.summary.completedCuts, all.length);
  assert.strictEqual(p.readyCuts.length, 0);
  assert.strictEqual(p.blockedCuts.length, 0);
  assert.strictEqual(p.summary.completionRate, 1);
  assert.strictEqual(p.summary.allDone, true);
  p.summary.shifts.forEach((s) => assert.strictEqual(s.completionRate, 1));
});

/* ---------------- 上报校验：未知刀号 ---------------- */

test('现场进度：未知刀号（越界/非正整数/非整数）返回 400，details 指出未知值', () => {
  const { schedule, wo } = realWorkOrder();
  try {
    runProgress(wo, schedule, [1, wo.summary.batchesAssigned + 5, 999]);
    assert.fail('应抛出 unknown-cut');
  } catch (err) {
    assert.ok(err instanceof ProgressError);
    assert.strictEqual(err.code, 'unknown-cut');
    assert.deepStrictEqual(err.details.unknownCutNos, [wo.summary.batchesAssigned + 5, 999]);
    assert.ok(/未知刀号/.test(err.message));
  }

  for (const bad of [0, -1, 1.5, '3', null]) {
    assert.throws(
      () => runProgress(wo, schedule, [bad]),
      (err) => err instanceof ProgressError && err.code === 'invalid-input'
    );
  }
});

test('现场进度：没有已分配刀次时任何上报都属未知刀号', () => {
  // 每批限 1 张：唯一批次是 2 张合批 → over-capacity，全部未分配
  const sched = {
    stackLimit: 2,
    dependencies: [[[2, 1]], [[2, 1]]],
    batches: [batchNode(1, [[1, 1], [2, 1]]), batchNode(2, [[1, 2], [2, 2]])],
  };
  const p = runProgress(null, sched, [], { maxSheetsPerBatch: 1 });
  assert.strictEqual(p.summary.cutsTotal, 0);
  assert.strictEqual(p.summary.completionRate, 0);
  assert.strictEqual(p.unassigned.length, 4);
  try {
    runProgress(null, sched, [1], { maxSheetsPerBatch: 1 });
    assert.fail('应抛出 unknown-cut');
  } catch (err) {
    assert.strictEqual(err.code, 'unknown-cut');
  }
});

/* ---------------- 上报校验：父刀未满足 ---------------- */

test('现场进度：未满足父刀先完成子刀返回 400，逐条指出缺失父刀', () => {
  const sched = {
    stackLimit: 2,
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
    ],
    dependencies: [[[2, 1]], [[2, 1]]],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 100 });
  assert.strictEqual(wo.summary.batchesAssigned, 2);
  try {
    progress({ schedule: sched, maxCutsPerShift: 100, completedCutNos: [2] });
    assert.fail('应抛出 parent-incomplete');
  } catch (err) {
    assert.ok(err instanceof ProgressError);
    assert.strictEqual(err.code, 'parent-incomplete');
    assert.ok(/全局第 2 刀/.test(err.message));
    assert.ok(/缺失父刀/.test(err.message));
    const v = err.details.violations[0];
    assert.strictEqual(v.cutNo, 2);
    assert.deepStrictEqual(v.pendingParents, [1]);
  }

  // 父刀也完成后合法
  const p = progress({ schedule: sched, maxCutsPerShift: 100, completedCutNos: [1, 2] });
  assert.strictEqual(p.summary.allDone, true);
});

/* ---------------- 未分配父刀：持续阻塞且标明原因 ---------------- */

test('现场进度：依赖未分配刀次的刀持续阻塞，unassignedParents 携带原因且不可完成', () => {
  // 纸1#3 父 9（父刀缺失）；纸1#4 父 3（上游阻断）
  const sched = {
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[1, 2]]),
      batchNode(3, [[1, 3]]),
      batchNode(4, [[1, 4]]),
    ],
    dependencies: [[[2, 1], [3, 9], [4, 3]]],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });
  assert.strictEqual(wo.summary.batchesAssigned, 2);

  const p = progress({ schedule: sched, maxCutsPerShift: 10, completedCutNos: [] });
  assert.strictEqual(p.summary.cutsTotal, 2);
  assert.strictEqual(p.unassigned.length, 2);
  // 全局第 1 刀（批1）就绪，第 2 刀（批2，纸1#2 父 #1）初始阻塞
  assert.deepStrictEqual(p.readyCuts.map((c) => c.cutNo), [1]);
  assert.ok(p.blockedCuts.some((c) => c.cutNo === 2 && c.pendingParents.includes(1)));

  // 完成第 1 刀后第 2 刀就绪；#3/#4 永远不在已分配列表中（试图上报即 unknown-cut）
  const p2 = progress({ schedule: sched, maxCutsPerShift: 10, completedCutNos: [1] });
  assert.deepStrictEqual(p2.readyCuts.map((c) => c.cutNo), [2]);
  assert.strictEqual(p2.unassigned[0].reason === 'missing-parent', true);

  // 超容量父刀：批 1 整批超容量未分配，批 2 唯一成员纸1#2 以批 1 的纸1#1 为父
  // → 批 2 沿父刀链 blocked，所有刀次都未分配，unassigned 同时含 over-capacity 与 blocked
  const cap = {
    stackLimit: 2,
    dependencies: [[[2, 1]]],
    batches: [
      batchNode(1, [[1, 1], [2, 1]]),
      batchNode(2, [[1, 2]]),
    ],
  };
  const pc = progress({
    schedule: cap, maxCutsPerShift: 10, maxSheetsPerBatch: 1, completedCutNos: [],
  });
  assert.strictEqual(pc.summary.cutsTotal, 0); // 两批均未分配
  assert.ok(pc.unassigned.some((u) => u.reason === 'over-capacity'));
  assert.ok(pc.unassigned.some((u) => u.reason === 'blocked'));
  // 未分配集合外的刀号仍属未知
  assert.throws(
    () => progress({ schedule: cap, maxCutsPerShift: 10, maxSheetsPerBatch: 1, completedCutNos: [1] }),
    (err) => err instanceof ProgressError && err.code === 'unknown-cut'
  );
});

test('现场进度：上报已完成一把“父刀未分配”的子刀属未知刀号（该刀根本未分配）', () => {
  const sched = {
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[1, 2]]),
    ],
    dependencies: [[[2, 9]]], // 纸1#2 父 9 缺失 → 批 2 未分配
  };
  assert.throws(
    () => progress({ schedule: sched, maxCutsPerShift: 10, completedCutNos: [2] }),
    (err) => err instanceof ProgressError && err.code === 'unknown-cut'
  );
});

/* ---------------- 合批成员中一张父刀未分配 ---------------- */

test('现场进度：合批刀次中任一成员的父刀未分配时整批持续阻塞并标明未分配父刀', () => {
  // 批 2 合批：纸1#2（父 1，已分配）+ 纸2#2（父 7，缺失）。
  // 工单仍把批 2 整体分配（members 保留两个成员），但纸2#2 记 missing-parent；
  // 因批内任一纸张父刀未完成，即使父刀 1 已切完，合批刀次仍持续阻塞。
  const sched = {
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[1, 2], [2, 2]]),
    ],
    dependencies: [
      [[2, 1]],
      [[2, 7]],
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });
  assert.strictEqual(wo.summary.batchesAssigned, 2);
  assert.ok(wo.unassigned.some((u) => u.sheetIndex === 2 && u.reason === 'missing-parent'));

  // 初始：批 1 就绪，批 2 同时等待全局第 1 刀与未分配父刀
  const p0 = progress({ schedule: sched, maxCutsPerShift: 10, completedCutNos: [] });
  assert.deepStrictEqual(p0.readyCuts.map((c) => c.cutNo), [1]);
  const b0 = p0.blockedCuts.find((c) => c.cutNo === 2);
  assert.deepStrictEqual(b0.pendingParents, [1]);
  assert.strictEqual(b0.unassignedParents.length, 1);
  assert.strictEqual(b0.unassignedParents[0].sheetIndex, 2);
  assert.strictEqual(b0.unassignedParents[0].reason, 'missing-parent');

  // 即使完成批 1，批 2 仍因纸2#2 的父刀未分配而不可就绪
  const p = progress({ schedule: sched, maxCutsPerShift: 10, completedCutNos: [1] });
  assert.ok(!p.readyCuts.some((c) => c.cutNo === 2));
  const cut2 = p.blockedCuts.find((c) => c.cutNo === 2);
  assert.ok(cut2);
  assert.deepStrictEqual(cut2.pendingParents, []);
  assert.strictEqual(cut2.unassignedParents.length, 1);
  assert.ok(/第 2 张纸第 7 号刀/.test(cut2.unassignedParents[0].detail));
});

/* ---------------- inferred 依赖 / sheets 直传 ---------------- */

test('现场进度：精简 schedule（无 dependencies）按批次先后推断同纸链', () => {
  const { schedule } = realWorkOrder();
  delete schedule.dependencies;
  const p = progress({
    schedule,
    maxCutsPerShift: 3,
    completedCutNos: [],
  });
  assert.strictEqual(p.dependencySource, 'inferred');
  // 推断链下先完成后批仍会被拦截
  const firstReady = p.readyCuts[0].cutNo;
  // 找一个阻塞刀尝试直接完成
  const blocked = p.blockedCuts[0].cutNo;
  if (blocked !== firstReady) {
    assert.throws(
      () => progress({ schedule, maxCutsPerShift: 3, completedCutNos: [blocked] }),
      (err) => err instanceof ProgressError && err.code === 'parent-incomplete'
    );
  }
});

test('现场进度：未带 schedule 时以 sheets+stackLimit 先排程再算进度', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 3, maxSheets: 4,
    products: [{ width: 100, height: 80, quantity: 24 }],
  });
  const p = progress({ sheets: r.sheets, stackLimit: 3, maxCutsPerShift: 4, completedCutNos: [] });
  assert.strictEqual(p.dependencySource, 'dependencies');
  assert.ok(p.summary.readyCuts >= 1);
});

/* ---------------- 去重乱序与确定性 ---------------- */

test('现场进度：completedCutNos 乱序/重复被规范化，同输入两次结果一致', () => {
  const { schedule, wo } = realWorkOrder();
  const a = runProgress(wo, schedule, [1, 1, 2]);
  const b = runProgress(wo, schedule, [2, 1]);
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.deepStrictEqual(a.completedCutNos, [1, 2]);
});

test('现场进度：缺少输入与缺排程时抛出 ProgressError', () => {
  assert.throws(() => progress(null), (e) => e instanceof ProgressError);
  assert.throws(
    () => progress({ maxCutsPerShift: 5, completedCutNos: [] }),
    (e) => e instanceof ProgressError && /排程/.test(e.message)
  );
  assert.throws(
    () => progress({ schedule: {}, completedCutNos: [] }),
    (e) => e instanceof ProgressError
  );
  assert.throws(
    () => progress({ schedule: {}, completedCutNos: 'x' }),
    (e) => e instanceof ProgressError && e.code === 'invalid-input'
  );
});

/* ---------------- 班次完成率 ---------------- */

test('现场进度：各班完成率独立统计且与整单完成率一致', () => {
  const { schedule, wo } = realWorkOrder({ maxCutsPerShift: 3 });
  assert.ok(wo.shifts.length >= 2);
  // 完成第一班全部刀次
  const firstShiftNos = wo.shifts[0].cuts.map((c) => c.cutNo);
  const p = runProgress(wo, schedule, firstShiftNos, { maxCutsPerShift: 3 });
  assert.strictEqual(p.summary.shifts[0].completionRate, 1);
  assert.strictEqual(
    p.summary.shifts[0].completedCuts,
    p.summary.shifts[0].cutsTotal
  );
  if (p.summary.shifts.length > 1) assert.ok(p.summary.shifts[1].completionRate < 1);
  // 整单完成率 = 各班完成数之和 / 总数
  const sumDone = p.summary.shifts.reduce((n, s) => n + s.completedCuts, 0);
  assert.strictEqual(sumDone, p.summary.completedCuts);
  assert.strictEqual(
    p.summary.completionRate,
    p.summary.completedCuts / p.summary.cutsTotal
  );
});
