'use strict';

/**
 * 现场进度（shop-floor progress）
 *
 * 在执行工单（workOrder）之上跟踪车间实际完成情况：操作者上报**已完成的全局刀号**
 * （`completedCutNos`），服务端为工单中每个**已分配刀次**汇总其全部纸张成员
 * （members）对应的父刀依赖，判定该刀次当前是“已完成 / 可立即执行 / 仍阻塞”，
 * 并统计各班次与整单完成率。
 *
 * 关键规则：
 *  - 合批刀次是“一叠纸一刀”：**批内任一纸张的父刀未完成，该合批刀次都不可就绪**。
 *    父刀来自排程 `dependencies`（显式）；排程无该字段时与工单一致地按来源批次先后
 *    推断同纸链（`dependencySource: 'inferred'`）。
 *  - 已完成的父刀按全局刀号在“已分配且已上报完成”中查找；父刀本身未分配
 *    （over-capacity / missing-parent / blocked）时，子刀持续阻塞并携带该父刀的
 *    未分配原因。
 *  - 上报校验（不合法整体拒绝，HTTP 400）：
 *      ① 含未知全局刀号（非正整数或超出 1..已分配刀数）→ unknown-cut，列出未知刀号；
 *      ② 未满足父刀却先完成子刀 → parent-incomplete，逐刀列出缺失父刀
 *         （未完成的全局父刀号 / 未分配父刀及其原因）。
 *
 * 输入与执行工单同源：`schedule`（叠纸排程返回）或 `sheets`+`stackLimit`，
 * 加工单容量 `maxCutsPerShift` / `maxSheetsPerBatch`，另加 `completedCutNos`。
 * 工单由同一份输入确定性重算，因此前端只需保存已完成刀号即可随时恢复进度。
 */

const { workOrder } = require('./workorder');

/** 带机器可读 code 的进度校验错误（服务端透传到 400 响应） */
class ProgressError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProgressError';
    this.code = code;
    this.details = details;
  }
}

const uniqSort = (arr) => [...new Set(arr)].sort((a, b) => a - b);

/**
 * 现场进度主入口。
 *
 * @param {object} input 与 workOrder 相同的工单输入，另加：
 *   - completedCutNos?：已完成全局刀号数组（正整数，可重复/乱序，内部去重排序）。
 * @returns {object} 进度结果（见文件末尾输出组装）。
 */
function progress(input) {
  if (!input || typeof input !== 'object') {
    throw new ProgressError('invalid-input', '缺少进度输入');
  }

  /* ---------------- 入参规范化 ---------------- */

  let completed = [];
  if (input.completedCutNos !== undefined && input.completedCutNos !== null) {
    if (!Array.isArray(input.completedCutNos)) {
      throw new ProgressError('invalid-input', '已完成刀次（completedCutNos）必须是数组');
    }
    const bad = [];
    for (const v of input.completedCutNos) {
      if (Number.isInteger(v) && v >= 1) {
        completed.push(v);
      } else {
        bad.push(v);
      }
    }
    if (bad.length) {
      throw new ProgressError(
        'invalid-input',
        `已完成刀次必须是正整数，非法取值：${bad.map((v) => String(v)).join('、')}`
      );
    }
  }
  completed = uniqSort(completed);

  /* ---------------- 同输入重算工单（确定性） ---------------- */

  let schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object') {
    if (!Array.isArray(input.sheets)) {
      throw new ProgressError(
        'invalid-input',
        '缺少排程结果（schedule 或 sheets）——请先生成叠纸裁切排程'
      );
    }
    try {
      // eslint-disable-next-line global-require
      schedule = require('./stack').stackSchedule(input);
    } catch (err) {
      throw new ProgressError('invalid-input', err.message || '排程输入无效');
    }
  }

  let wo;
  try {
    wo = workOrder({
      schedule,
      maxCutsPerShift: input.maxCutsPerShift,
      maxSheetsPerBatch: input.maxSheetsPerBatch,
    });
  } catch (err) {
    throw new ProgressError('invalid-input', err.message || '工单输入无效');
  }

  /* ---------------- 刀次索引：token → 全局刀号 / 未分配记录 ---------------- */

  const cuts = []; // 展平的已分配刀次（按全局刀号升序）
  const cutOfToken = new Map(); // "sheetIndex:cutNo" → 全局刀号
  wo.shifts.forEach((shift) => {
    shift.cuts.forEach((c) => {
      cuts.push(c);
      c.members.forEach((m) => cutOfToken.set(`${m.sheetIndex}:${m.cutNo}`, c.cutNo));
    });
  });
  const totalAssigned = cuts.length;

  const unassignedOfToken = new Map(); // token → 未分配记录
  wo.unassigned.forEach((u) => {
    unassignedOfToken.set(`${u.sheetIndex}:${u.cutNo}`, u);
  });

  /* ---------------- 未知刀号 ---------------- */

  const unknown = completed.filter((n) => n > totalAssigned);
  if (unknown.length) {
    const range = totalAssigned > 0
      ? `有效全局刀号为 1～${totalAssigned}`
      : '本工单没有任何已分配刀次（所有刀均未分配）';
    throw new ProgressError(
      'unknown-cut',
      `已完成刀次中存在未知刀号：${unknown.join('、')}（${range}）`,
      { unknownCutNos: unknown, cutsTotal: totalAssigned }
    );
  }

  /* ---------------- 每张纸的父刀边（token → 父 token 列表） ---------------- */
  // 与 workOrder 的建边逻辑保持一致：显式 dependencies 优先，否则按来源批次推断同纸链。

  const parentsByToken = new Map(); // token → Set(parentToken)
  const addParent = (sheetIndex, childCut, parentCut) => {
    const childToken = `${sheetIndex}:${childCut}`;
    const parentToken = `${sheetIndex}:${parentCut}`;
    if (!parentsByToken.has(childToken)) parentsByToken.set(childToken, new Set());
    parentsByToken.get(childToken).add(parentToken);
  };

  if (wo.dependencySource === 'dependencies' && Array.isArray(schedule.dependencies)) {
    schedule.dependencies.forEach((list, si) => {
      list.forEach(([childCut, parentCut]) => {
        addParent(si + 1, childCut, parentCut);
      });
    });
  } else {
    // 推断：同一张纸上按来源批次先后把相邻刀连成链（含未分配批次，与工单阻断传播一致）
    const batchNoByToken = new Map();
    wo.shifts.forEach((shift) => {
      shift.cuts.forEach((c) => {
        c.members.forEach((m) => batchNoByToken.set(`${m.sheetIndex}:${m.cutNo}`, c.batchNo));
      });
    });
    wo.unassigned.forEach((u) => {
      if (u.batchNo != null) batchNoByToken.set(`${u.sheetIndex}:${u.cutNo}`, u.batchNo);
    });
    const bySheet = new Map();
    for (const [token, batchNo] of batchNoByToken) {
      const [sheetStr, cutStr] = token.split(':');
      const sheetIndex = Number(sheetStr);
      if (!bySheet.has(sheetIndex)) bySheet.set(sheetIndex, []);
      bySheet.get(sheetIndex).push({ batchNo, sheetIndex, cutNo: Number(cutStr) });
    }
    for (const list of bySheet.values()) {
      list.sort((a, b) => a.batchNo - b.batchNo || a.cutNo - b.cutNo);
      for (let k = 1; k < list.length; k += 1) {
        addParent(list[k].sheetIndex, list[k].cutNo, list[k - 1].cutNo);
      }
    }
  }

  /** 解析某成员刀的父刀：返回 { pending:[全局刀号...], unassigned:[未分配记录...] } */
  const resolveParents = (memberToken) => {
    const pendingSet = new Set();
    const unassignedMap = new Map(); // token → record（去重）
    for (const parentToken of parentsByToken.get(memberToken) || []) {
      if (cutOfToken.has(parentToken)) {
        const parentCutNo = cutOfToken.get(parentToken);
        if (!completedSet.has(parentCutNo)) pendingSet.add(parentCutNo);
      } else if (unassignedOfToken.has(parentToken)) {
        unassignedMap.set(parentToken, unassignedOfToken.get(parentToken));
      } else {
        // 理论上不会到达：显式依赖中父刀缺失时子刀已被工单记为 missing-parent，
        // 而未分配成员不会出现在已分配刀次内。防御性地合成一条未分配父刀记录。
        const [ps, pc] = parentToken.split(':');
        unassignedMap.set(parentToken, {
          sheetIndex: Number(ps),
          cutNo: Number(pc),
          reason: 'missing-parent',
          detail: `父刀（第 ${ps} 张纸第 ${pc} 号刀）未出现在排程批次中，本刀缺少前置裁切`,
          batchNo: null,
        });
      }
    }
    return {
      pending: uniqSort([...pendingSet]),
      unassigned: [...unassignedMap.values()],
    };
  };

  const completedSet = new Set(completed);

  /* ---------------- 汇总每个已分配刀次的全部父刀 ---------------- */
  // 合批规则：批内任一纸张的父刀未完成（或父刀未分配），整批不可就绪。

  const cutInfos = cuts.map((c) => {
    const pendingSet = new Set();
    const unassignedMap = new Map();
    c.members.forEach((m) => {
      const r = resolveParents(`${m.sheetIndex}:${m.cutNo}`);
      r.pending.forEach((p) => pendingSet.add(p));
      r.unassigned.forEach((u) => unassignedMap.set(`${u.sheetIndex}:${u.cutNo}`, u));
    });
    return {
      cut: c,
      pendingParents: uniqSort([...pendingSet]),
      unassignedParents: [...unassignedMap.values()].sort(
        (a, b) => (a.sheetIndex - b.sheetIndex) || (a.cutNo - b.cutNo)
      ),
    };
  });
  const infoByCutNo = new Map(cutInfos.map((info) => [info.cut.cutNo, info]));

  /* ---------------- 先完成子刀却缺父刀：整体 400 ---------------- */

  const violations = [];
  completed.forEach((cutNo) => {
    const info = infoByCutNo.get(cutNo);
    if (!info) return; // 已在 unknown 分支拦截
    const missing = [];
    info.pendingParents.forEach((p) => {
      missing.push(`全局第 ${p} 刀尚未完成`);
    });
    info.unassignedParents.forEach((u) => {
      missing.push(`第 ${u.sheetIndex} 张纸第 ${u.cutNo} 号父刀未分配（${u.detail}）`);
    });
    if (missing.length) {
      violations.push({
        cutNo,
        shiftNo: info.cut.shiftNo,
        batchNo: info.cut.batchNo,
        pendingParents: info.pendingParents,
        unassignedParents: info.unassignedParents,
        message: `全局第 ${cutNo} 刀（第 ${info.cut.shiftNo} 班、来源批次 ${info.cut.batchNo}）`
          + `在父刀未满足时被标记完成，缺失父刀：${missing.join('；')}`,
      });
    }
  });

  if (violations.length) {
    throw new ProgressError(
      'parent-incomplete',
      `已完成记录不合法，存在“父刀未完成却先完成子刀”：${violations.map((v) => v.message).join('；')}`,
      { violations: violations.map(({ message, ...rest }) => rest) }
    );
  }

  /* ---------------- 分类：已完成 / 可立即执行 / 仍阻塞 ---------------- */

  const shape = (info) => ({
    shiftNo: info.cut.shiftNo,
    cutInShift: info.cut.cutInShift,
    cutNo: info.cut.cutNo,
    batchNo: info.cut.batchNo,
    orient: info.cut.orient,
    kerf: info.cut.kerf,
    position: info.cut.position,
    region: info.cut.region,
    cutLength: info.cut.cutLength,
    totalLength: info.cut.totalLength,
    sheetCount: info.cut.sheetCount,
    capped: info.cut.capped,
    members: info.cut.members.map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
    // 仍待完成的父刀（全局刀号）与未分配父刀（含原因）；两者皆空即可立即执行
    pendingParents: info.pendingParents,
    unassignedParents: info.unassignedParents,
  });

  const completedCuts = [];
  const readyCuts = [];
  const blockedCuts = [];
  cutInfos.forEach((info) => {
    if (completedSet.has(info.cut.cutNo)) {
      completedCuts.push(shape(info));
    } else if (info.pendingParents.length === 0 && info.unassignedParents.length === 0) {
      readyCuts.push(shape(info));
    } else {
      blockedCuts.push(shape(info));
    }
  });

  /* ---------------- 班次 / 整单完成率 ---------------- */

  const rate = (done, total) => (total > 0 ? done / total : 0);
  const shifts = wo.shifts.map((shift) => {
    const done = shift.cuts.filter((c) => completedSet.has(c.cutNo)).length;
    return {
      shiftNo: shift.shiftNo,
      cutsTotal: shift.cutsTotal,
      completedCuts: done,
      completionRate: rate(done, shift.cutsTotal),
    };
  });

  return {
    source: wo.source,
    stackLimit: wo.stackLimit,
    dependencySource: wo.dependencySource,
    maxCutsPerShift: wo.maxCutsPerShift,
    maxSheetsPerBatch: wo.maxSheetsPerBatch,
    completedCutNos: completed,
    summary: {
      cutsTotal: totalAssigned,
      completedCuts: completedCuts.length,
      readyCuts: readyCuts.length,
      blockedCuts: blockedCuts.length,
      unassignedCuts: wo.unassigned.length,
      completionRate: rate(completedCuts.length, totalAssigned),
      allDone: totalAssigned > 0 && completedCuts.length === totalAssigned,
      shifts,
    },
    completedCuts,
    readyCuts,
    blockedCuts,
    // 工单中从未分配的刀（持续阻塞项的根因一览，内容与执行工单 unassigned 一致）
    unassigned: wo.unassigned,
  };
}

module.exports = { progress, ProgressError };
