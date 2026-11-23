import { number, naturalCompare } from './tables.mjs';

export const BLOCK = Object.freeze({
  qualification: '资格',
  attribution: '归因',
  payment: '付款',
});

const STATUS_RANK = { paid: 0, committed: 1, requested: 2 };

function key(period, scope) {
  return `${period}|${scope}`;
}

function shareFor(resolution, agency) {
  return (resolution?.allocations ?? [])
    .filter(item => item.agency === agency)
    .reduce((sum, item) => sum + item.share, 0);
}

function tenureForAlias(tenures, alias) {
  return tenures.find(tenure => tenure.records.some(record => record.alias === alias)) ?? null;
}

function stageFor(tenure, stage) {
  return tenure?.stages.find(item => item.stage === stage) ?? null;
}

function isHardIssue(issue) {
  return issue.category === BLOCK.qualification || issue.category === BLOCK.payment;
}

function isSubstantiveAttribution(issue) {
  return issue.category === BLOCK.attribution && issue.code !== 'post-hire-dispute';
}

/**
 * 同一人同阶段只占一笔批准金额。团队分摊是同一任职内不同机构
 * 按各自份额共占一笔；跨任职的各机构申请不构成分摊，仍只留一笔。
 */
function isTeamSplit(left, right, resolutions) {
  if (left.tenureId === null || left.tenureId !== right.tenureId) return false;
  if (left.agency === right.agency) return false;
  const resolution = resolutions.get(left.tenureId);
  if (!resolution || resolution.status !== 'allocated') return false;
  return shareFor(resolution, left.agency) > 0 && shareFor(resolution, right.agency) > 0;
}

function priority(row) {
  return [STATUS_RANK[row.status] ?? 3, naturalCompare(row.payment)];
}

function cellAvailable(cell) {
  if (!cell) return 0;
  return Math.max(0, cell.capacity - cell.paid - cell.committed - cell.approved + cell.freed);
}

function emptyLedger(periods, scopes) {
  const ledger = new Map();
  for (const period of periods) {
    for (const scope of scopes) {
      ledger.set(key(period, scope), {
        period,
        scope,
        capacity: 0,
        paid: 0,
        committed: 0,
        approved: 0,
        freed: 0,
        entries: [],
      });
    }
  }
  return ledger;
}

export function evaluateSettlement({ tables, identities, tenures, resolutions, periods }) {
  const scopes = ['shared', ...new Set(tables.funds.map(row => row.scope).filter(scope => scope !== 'shared'))].sort();
  const ledger = emptyLedger(periods, scopes);
  for (const row of tables.funds) {
    const cell = ledger.get(key(Number(row.period), row.scope));
    if (cell) cell.capacity += Number(row.amount);
  }

  const rows = tables.settlement.map(row => {
    const person = identities.personOf.get(row.alias) ?? null;
    const tenure = tenureForAlias(tenures, row.alias);
    const stage = stageFor(tenure, row.stage);
    const resolution = tenure ? resolutions.get(tenure.id) : null;
    const amount = number(row.amount) ?? 0;
    return {
      payment: row.payment,
      alias: row.alias,
      personId: person?.id ?? null,
      tenureId: tenure?.id ?? null,
      stage: row.stage,
      agency: row.agency,
      amount,
      approvedAmount: amount,
      entitlement: stage ? stage.award * shareFor(resolution, row.agency) : null,
      period: number(row.period),
      status: row.status,
      stageInfo: stage,
      resolution,
      issues: [],
      decision: null,
    };
  });

  // 历史支付与已承诺先占实际额度；它们不会因后续复核从账上腾空。
  for (const row of rows) {
    if (row.status !== 'paid' && row.status !== 'committed') continue;
    const cell = ledger.get(key(row.period, row.agency));
    if (!cell) continue;
    if (row.status === 'paid') cell.paid += row.amount;
    else cell.committed += row.amount;
    cell.entries.push({ payment: row.payment, kind: row.status, amount: row.amount, agency: row.agency });
  }

  const adjustments = applyAdjustments({ tables, rows, ledger });
  inspectRows(rows);
  const displacements = applyStageUniqueness(rows, resolutions);
  allocateRequested({ rows, ledger });

  for (const row of rows) {
    if (row.status === 'paid') {
      row.decision = 'paid';
      if (row.issues.some(issue => isHardIssue(issue) || isSubstantiveAttribution(issue))) {
        row.issues.push({
          category: BLOCK.payment,
          code: 'settled-no-reclaim',
          message: '已结算款不回溯腾空，只能通过下一期调整处理',
        });
      }
    } else if (row.status === 'committed') {
      const blocked = row.issues.some(issue => isHardIssue(issue) || isSubstantiveAttribution(issue));
      row.decision = blocked ? 'committed-blocked' : 'committed';
    }
  }

  const balances = buildBalances({ ledger, rows });
  const followUps = proposeFollowUps({ rows, adjustments, periods });
  return { rows: sortRows(rows), adjustments, displacements, followUps, balances, ledger };
}

/**
 * 已发款在复核后失去支撑时，不回冲原期，只形成下一期的建议调整。
 * 建议需机构以 confirmed 状态提交后才落账，避免自动扣款或重复发放。
 */
function proposeFollowUps({ rows, adjustments, periods }) {
  const lastPeriod = Math.max(0, ...periods);
  const nextPeriod = lastPeriod + 1;
  const existing = new Set(adjustments.map(item => item.payment));
  return rows
    .filter(row => row.status === 'paid')
    .filter(row => row.issues.some(issue => isHardIssue(issue) || isSubstantiveAttribution(issue)))
    .filter(row => !existing.has(row.payment))
    .map(row => ({
      payment: row.payment,
      personId: row.personId,
      agency: row.agency,
      period: nextPeriod,
      suggestedAmount: -row.amount,
      state: 'proposed',
      basis: `第 ${row.period} 期已支付 ${row.amount}，按当前证据已失去支撑：${row.issues
        .filter(issue => (isHardIssue(issue) || isSubstantiveAttribution(issue)) && issue.code !== 'settled-no-reclaim')
        .map(issue => issue.message)
        .join('；')}`,
      note: '只作为下一期拟返还建议，需机构确认后重新运行才落账',
    }));
}

/** 资格与归因检查：决定申请能否进入额度排位。 */
function inspectRows(rows) {
  for (const row of rows) {
    const add = (category, code, message) => row.issues.push({ category, code, message });
    if (!row.personId) add(BLOCK.qualification, 'unknown-alias', `别名 ${row.alias} 不在联系记录中`);
    if (!row.tenureId) add(BLOCK.qualification, 'no-tenure', '找不到与该别名对应的可核验任职');
    if (row.tenureId && !row.stageInfo) add(BLOCK.qualification, 'no-stage', `任职 ${row.tenureId} 没有阶段 ${row.stage}`);
    if (row.stageInfo) {
      if (!row.stageInfo.observed) {
        add(BLOCK.qualification, 'stage-not-observed', `第 ${row.stageInfo.anchor} 日才到观察期，先挂起`);
      } else if (!row.stageInfo.supported) {
        add(BLOCK.qualification, 'stage-ended', `任职在第 ${row.stageInfo.anchor} 日前已结束，未达该节点`);
      }
    }
    if (!row.tenureId) continue;
    const resolution = row.resolution;
    const share = shareFor(resolution, row.agency);
    if (!resolution || resolution.status === 'none') {
      add(BLOCK.attribution, 'no-claim', '没有有效提名或提名已撤回，机构不享有结算权利');
    } else if (resolution.status === 'pending') {
      add(BLOCK.attribution, 'dispute-pending', '重叠提名争议未决，整项暂挂');
    } else if (share <= 0) {
      add(BLOCK.attribution, 'no-share', `${row.agency} 未在该任职的折算份额内`);
    } else if (row.entitlement !== null && row.amount > row.entitlement + 1e-9) {
      add(BLOCK.payment, 'over-entitlement', `金额 ${row.amount} 超过该机构批准份额 ${Math.round(row.entitlement * 100) / 100}`);
      row.approvedAmount = row.entitlement;
    }
    if (resolution?.postHireDisputes?.length > 0) {
      add(
        BLOCK.attribution,
        'post-hire-dispute',
        `入职后受理争议：${resolution.postHireDisputes.map(item => item.claim).join('、')}（不影响入职时提名权，需持续复核）`,
      );
    }
  }
}

/**
 * 同一个人同阶段只占一笔。已支付/已承诺的款项无条件占位，防止争议中或
 * 已结算的款被再次发放；其余申请只有通过资格与归因检查才有占位资格，
 * 因此被资格驳回的申请不会挤掉后续有效批次。
 */
function applyStageUniqueness(rows, resolutions) {
  const groups = new Map();
  for (const row of rows) {
    const id = `${row.personId ?? row.alias}|${row.stage}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const displacements = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    // 已支付/已承诺无条件占位；其余只有通过资格与归因检查才有占位资格。
    const candidates = group.filter(row => row.status === 'paid' || row.status === 'committed'
      || !row.issues.some(issue => isHardIssue(issue) || isSubstantiveAttribution(issue)));
    if (candidates.length === 0) continue;
    const sorted = [...candidates].sort((a, b) => priority(a)[0] - priority(b)[0] || priority(a)[1] - priority(b)[1]);
    const occupant = sorted[0];
    for (const row of sorted.slice(1)) {
      if (isTeamSplit(occupant, row, resolutions)) continue;
      // 已支付/已承诺的款不算“被挤掉”，它们只是不能重复占额。
      const settled = row.status === 'paid' || row.status === 'committed';
      row.issues.push({
        category: BLOCK.payment,
        code: settled ? 'duplicate-settlement' : 'stage-taken',
        message: settled
          ? `同一个人同阶段只占一笔：已由 ${occupant.payment}（${occupant.status}，${occupant.agency}）占位，已结算款不得再次发放`
          : `同一个人同阶段只占一笔：已由 ${occupant.payment}（${occupant.status}，${occupant.agency}）占位`,
      });
      displacements.push({
        personId: row.personId ?? row.alias,
        stage: row.stage,
        displaced: row.payment,
        displacedAgency: row.agency,
        displacedStatus: row.status,
        occupant: occupant.payment,
        occupantAgency: occupant.agency,
        occupantStatus: occupant.status,
        recovered: settled,
        duplicateSettlement: settled,
        note: settled
          ? '已结算款不因同阶段重分从账上腾空，且不能再次发放，需通过下一期调整处理'
          : '后续批次不再占用本期额度',
      });
    }
  }
  return displacements;
}

function allocateRequested({ rows, ledger }) {
  const requested = rows
    .filter(row => row.status === 'requested')
    .sort((a, b) => (a.period - b.period) || naturalCompare(a.payment, b.payment));

  for (const row of requested) {
    const hard = row.issues.filter(isHardIssue);
    const attribution = row.issues.filter(isSubstantiveAttribution);
    if (hard.length > 0) {
      row.decision = hard.some(issue => issue.code === 'stage-not-observed') ? 'held' : 'blocked';
      continue;
    }
    if (attribution.length > 0) {
      row.decision = 'blocked';
      continue;
    }

    const local = ledger.get(key(row.period, row.agency));
    const shared = ledger.get(key(row.period, 'shared'));
    const want = row.approvedAmount;
    let granted = 0;

    const fromLocal = Math.min(want, cellAvailable(local));
    if (fromLocal > 0) {
      local.approved += fromLocal;
      local.entries.push({ payment: row.payment, kind: 'approved', amount: fromLocal, agency: row.agency, from: 'local' });
      granted += fromLocal;
    }
    const remaining = want - granted;
    if (remaining > 0) {
      const fromShared = Math.min(remaining, cellAvailable(shared));
      if (fromShared > 0) {
        shared.approved += fromShared;
        shared.entries.push({ payment: row.payment, kind: 'approved', amount: fromShared, agency: row.agency, from: 'shared' });
        granted += fromShared;
      }
    }

    if (granted >= want - 1e-9) {
      row.decision = 'approved';
    } else if (granted > 0) {
      row.decision = 'partial';
      row.approvedAmount = granted;
      row.issues.push({
        category: BLOCK.payment,
        code: 'insufficient-quota',
        message: `额度不足：批准 ${granted}，缺口 ${want - granted}`,
      });
    } else {
      row.decision = 'held';
      row.issues.push({
        category: BLOCK.payment,
        code: 'quota-exhausted',
        message: '专属与共享额度均已用尽，暂未排入本期',
      });
    }
  }
}

/**
 * 调整：确认的负向调整从实际责任机构当期占额冲抵，冲抵不超过对应已支出；
 * 暂提调整只列敞口。正额确认形成本期应补发占额。
 */
function applyAdjustments({ tables, rows, ledger }) {
  const adjustments = [];
  // 同一付款的多笔确认负向调整合计不得超过对应已支出。
  const appliedByPayment = new Map();
  const ordered = [...tables.adjustments].sort((a, b) => naturalCompare(a.adjustment, b.adjustment));
  for (const row of ordered) {
    const payment = rows.find(item => item.payment === row.payment);
    const amount = number(row.amount) ?? 0;
    const period = number(row.period);
    const adjustment = {
      adjustment: row.adjustment,
      payment: row.payment,
      amount,
      knownDay: number(row.known_day),
      period,
      state: row.state,
      agency: payment?.agency ?? null,
      personId: payment?.personId ?? null,
      applied: 0,
      exposure: 0,
      netEffect: 0,
      note: '',
    };

    if (!payment) {
      adjustment.note = `付款 ${row.payment} 不存在`;
      adjustments.push(adjustment);
      continue;
    }
    if (row.state !== 'confirmed') {
      const exposure = Math.abs(amount);
      adjustment.exposure = exposure;
      adjustment.netEffect = -exposure;
      adjustment.note = '暂提调整，仅列敞口，不占用额度';
      adjustments.push(adjustment);
      continue;
    }

    const cell = ledger.get(key(period, payment.agency));
    if (!cell) {
      adjustment.note = '调整期或机构不在资金表内';
      adjustments.push(adjustment);
      continue;
    }

    if (amount < 0) {
      const spent = payment.status === 'paid' || payment.status === 'committed' ? payment.amount : 0;
      const already = appliedByPayment.get(payment.payment) ?? 0;
      const room = Math.max(0, spent - already);
      const applied = Math.min(-amount, room);
      appliedByPayment.set(payment.payment, already + applied);
      cell.freed += applied;
      cell.entries.push({ payment: payment.payment, kind: 'adjustment', amount: -applied, agency: payment.agency });
      adjustment.applied = applied;
      adjustment.netEffect = -applied;
      if (applied < -amount) {
        adjustment.exposure = -amount - applied;
        adjustment.note = already > 0
          ? `对应支出 ${spent} 已冲抵 ${already}，本次仅冲 ${applied}，余 ${adjustment.exposure} 不从账上腾空`
          : `冲抵上限为对应支出 ${spent}，未冲部分不从账上腾空`;
      } else {
        adjustment.note = `从 ${payment.agency} 第 ${period} 期占额冲抵`;
      }
    } else {
      cell.approved += amount;
      cell.entries.push({ payment: payment.payment, kind: 'adjustment', amount, agency: payment.agency });
      adjustment.applied = amount;
      adjustment.netEffect = amount;
      adjustment.note = '正向补发，计入本期占额';
    }
    adjustments.push(adjustment);
  }
  return adjustments;
}

function buildBalances({ ledger, rows }) {
  return [...ledger.values()]
    .map(cell => {
      const used = cell.paid + cell.committed + cell.approved;
      const pendingHeld = rows.filter(row => row.decision === 'held'
        && row.period === cell.period
        && (cell.scope === 'shared' || row.agency === cell.scope));
      return {
        period: cell.period,
        scope: cell.scope,
        capacity: cell.capacity,
        paid: cell.paid,
        committed: cell.committed,
        approved: cell.approved,
        freed: cell.freed,
        used,
        available: cellAvailable(cell),
        heldAmount: pendingHeld.reduce((sum, row) => sum + row.approvedAmount, 0),
        entries: cell.entries,
      };
    })
    .sort((a, b) => (a.period - b.period) || naturalCompare(a.scope, b.scope));
}

function sortRows(rows) {
  return rows.sort((a, b) => (a.period - b.period) || naturalCompare(a.payment, b.payment));
}

/**
 * 逐人分期对齐：历史正额支付、本期申请与确认调整按同一人分期呈现，
 * 净额带符号，便于财务把已发款与下一期调整对齐。
 */
export function reconcileSettlement({ settlement }) {
  const byPerson = new Map();
  const cellFor = (personId, period) => {
    if (!byPerson.has(personId)) byPerson.set(personId, new Map());
    const periods = byPerson.get(personId);
    if (!periods.has(period)) {
      periods.set(period, { period, paid: 0, committed: 0, approved: 0, adjustments: 0, exposure: 0, net: 0, cumulative: 0, entries: [] });
    }
    return periods.get(period);
  };

  for (const row of settlement.rows) {
    if (!row.personId) continue;
    const cell = cellFor(row.personId, row.period);
    if (row.status === 'paid') cell.paid += row.amount;
    else if (row.status === 'committed') cell.committed += row.amount;
    else if (row.decision === 'approved' || row.decision === 'partial') cell.approved += row.approvedAmount;
    cell.entries.push({
      payment: row.payment,
      stage: row.stage,
      status: row.status,
      decision: row.decision,
      amount: row.amount,
      approvedAmount: row.approvedAmount,
    });
  }

  for (const adjustment of settlement.adjustments) {
    if (!adjustment.personId) continue;
    const cell = cellFor(adjustment.personId, adjustment.period);
    if (adjustment.state === 'confirmed') {
      // 只有已确认调整进入净额；暂提调整保留为敞口，不影响对齐。
      cell.adjustments += adjustment.netEffect;
    } else {
      cell.exposure += adjustment.exposure;
    }
    cell.entries.push({
      adjustment: adjustment.adjustment,
      payment: adjustment.payment,
      state: adjustment.state,
      amount: adjustment.amount,
      applied: adjustment.applied,
      exposure: adjustment.exposure,
      netEffect: adjustment.state === 'confirmed' ? adjustment.netEffect : 0,
    });
  }

  return [...byPerson.entries()].map(([personId, periods]) => {
    const list = [...periods.values()].sort((a, b) => a.period - b.period);
    let cumulative = 0;
    let exposure = 0;
    for (const cell of list) {
      cell.net = cell.paid + cell.committed + cell.approved + cell.adjustments;
      cumulative += cell.net;
      cell.cumulative = cumulative;
      exposure += cell.exposure;
    }
    return { personId, periods: list, cumulative, exposure };
  }).sort((a, b) => (a.personId < b.personId ? -1 : 1));
}

/**
 * 财务口径：暂留（挂起申请）与敞口（争议未决、暂提调整）不得视为可另拨余额。
 * 已承诺未支撑的款已经占用额度，只单列说明而不重复扣减；受阻款项从未占额，
 * 单列提醒需先纠正证据，而不是把它当作可动用余额。
 */
export function exposureSummary({ settlement }) {
  const proposed = settlement.adjustments.filter(item => item.state !== 'confirmed');
  const adjustmentExposure = proposed.reduce((sum, item) => sum + item.exposure, 0);
  const disputed = settlement.rows.filter(row => row.issues.some(issue => issue.code === 'dispute-pending'));
  const disputedAmount = disputed.reduce((sum, row) => sum + row.approvedAmount, 0);
  // 挂起：阶段未到观察期或额度尚未排入，属于暂留。
  const reserved = settlement.rows
    .filter(row => row.decision === 'held')
    .reduce((sum, row) => sum + row.approvedAmount, 0);
  // 受阻：资格/归因不成立而未占额度；这不是账上余额，重新获得资格后才会占用。
  const blocked = settlement.rows.filter(row => row.decision === 'blocked');
  const blockedApproved = blocked.reduce((sum, row) => sum + row.amount, 0);
  const committedUnbacked = settlement.rows
    .filter(row => row.decision === 'committed-blocked')
    .reduce((sum, row) => sum + row.amount, 0);
  const exposure = adjustmentExposure + disputedAmount;
  const remainingCapacity = settlement.balances.reduce((sum, balance) => sum + balance.available, 0);
  const trulyFree = Math.max(0, remainingCapacity - reserved - exposure);
  return {
    exposure,
    adjustmentExposure,
    disputedAmount,
    reserved,
    blockedApproved,
    committedUnbacked,
    remainingCapacity,
    availableForReallocation: Math.round(trulyFree * 100) / 100,
    note: '暂留（挂起申请）与敞口（争议未决、暂提调整）不得视为可另拨余额；受阻款项需先纠正证据，已承诺未支撑的款不重复计入敞口',
  };
}
