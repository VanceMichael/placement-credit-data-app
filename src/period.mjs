export const DAYS_PER_PERIOD = 30;

/** 交叉文件中的“期”为月度，首期第 1–30 日。 */
export function periodWindow(period) {
  const from = (period - 1) * DAYS_PER_PERIOD + 1;
  return { period, from, to: from + DAYS_PER_PERIOD - 1 };
}

export function periodOfDay(day) {
  return Math.floor((day - 1) / DAYS_PER_PERIOD) + 1;
}

/** 默认统计到最后一期资金覆盖的月末，使所有月度额度都已入账。 */
export function defaultAsOf(tables) {
  const last = Math.max(...tables.funds.map(row => Number(row.period)), 1);
  return last * DAYS_PER_PERIOD;
}

export function inWindow(day, window) {
  return day >= window.from && day <= window.to;
}

export function percent(part, whole) {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}
