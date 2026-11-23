import { number, naturalCompare } from './tables.mjs';

export const ADJUSTMENT_STATE = Object.freeze({
  proposed: 'proposed',
  confirmed: 'confirmed',
});

/**
 * 机构提交下一期的拟返还（负额）或补发（正额）确认。
 * 提交只登记确认与依据，不改动已结算期；实际冲抵由结账引擎在
 * 确认后按责任机构当期占额处理。
 */
export function proposeAdjustment({
  tables,
  settlement,
  agency,
  payment,
  amount,
  period,
  state = ADJUSTMENT_STATE.proposed,
  knownDay,
  reference,
}) {
  const target = settlement.rows.find(row => row.payment === payment);
  if (!target) {
    return { accepted: false, reason: `付款 ${payment} 不存在` };
  }
  if (target.agency !== agency) {
    return { accepted: false, reason: `付款 ${payment} 的责任机构是 ${target.agency}，${agency} 不能提交其调整` };
  }
  if (!['proposed', 'confirmed'].includes(state)) {
    return { accepted: false, reason: `未知调整状态 ${state}` };
  }
  if (amount === 0) {
    return { accepted: false, reason: '调整金额不能为零' };
  }
  const closedPeriods = new Set(tables.settlement
    .filter(row => row.status === 'paid')
    .map(row => number(row.period)));
  if (period <= Math.max(0, ...closedPeriods)) {
    return {
      accepted: false,
      reason: `第 ${period} 期已结账，调整只能落在后续期，已发款通过下一期调整体现`,
    };
  }
  const amountValue = Number(amount);
  if (!Number.isFinite(amountValue)) {
    return { accepted: false, reason: `调整金额 ${amount} 不是数值` };
  }

  const nextId = `A${tables.adjustments.length + 1}`;
  const record = {
    adjustment: reference ?? nextId,
    payment,
    amount: amountValue,
    known_day: String(knownDay ?? ''),
    period: String(period),
    state,
  };

  const preview = {
    ...record,
    agency,
    personId: target.personId,
    direction: amountValue < 0 ? '返还' : '补发',
    basis: amountValue < 0
      ? `拟从已支付 ${target.amount} 中返还算 ${-amountValue}`
      : `拟补发 ${amountValue}`,
    effect: state === 'confirmed'
      ? '确认后从责任机构当期占额冲抵（返还不得超过对应已支出）'
      : '仅登记为敞口，不占用额度',
  };

  return {
    accepted: true,
    record,
    preview,
    nextTables: {
      ...tables,
      adjustments: [...tables.adjustments, record],
    },
  };
}

/** 逐人分期对齐视图：按人列出已支付正额、调整与净额。 */
export function installmentAlignment({ reconciliation }) {
  return reconciliation.map(person => ({
    personId: person.personId,
    cumulative: person.cumulative,
    installments: person.periods.map(cell => ({
      period: cell.period,
      paid: cell.paid,
      committed: cell.committed,
      approved: cell.approved,
      adjustments: cell.adjustments,
      exposure: cell.exposure,
      net: cell.net,
      cumulative: cell.cumulative,
      entries: cell.entries.sort((a, b) => naturalCompare(
        a.payment ?? a.adjustment,
        b.payment ?? b.adjustment,
      )),
    })),
  }));
}
