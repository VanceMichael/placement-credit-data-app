import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot } from '../src/engine.mjs';
import { parseTable } from '../src/tables.mjs';

const snapshot = await buildSnapshot();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withTables(mutate) {
  const tables = clone(snapshot.tables);
  mutate(tables);
  return buildSnapshot({ tables });
}

test('跨活动身份只由已确认关联连接，弱匹配保留为待核实', () => {
  const person = snapshot.identities.persons.find(item => item.aliases.includes('A01'));
  assert.deepEqual(person.aliases, ['A01', 'A02']);
  assert.deepEqual(person.confirmedLinks.map(link => link.id), ['I2']);
  assert.ok(snapshot.identities.pendingCandidates.some(item => item.link === 'I1'));
  // A03/A04 只有待核实关联，不能合并。
  const a03 = snapshot.identities.persons.find(item => item.aliases.includes('A03'));
  const a04 = snapshot.identities.persons.find(item => item.aliases.includes('A04'));
  assert.notEqual(a03.id, a04.id);
});

test('待核实关联在确认后才影响身份', async () => {
  const tables = clone(snapshot.tables);
  tables.identities.push({
    link: 'I4', left_alias: 'A03', right_alias: 'A04', status: 'confirmed', record_day: '20',
  });
  const later = await buildSnapshot({ tables, asOf: 25 });
  const merged = later.identities.persons.find(item => item.aliases.includes('A03'));
  assert.deepEqual(merged.aliases, ['A03', 'A04']);
});

test('被取代的任职不参与链，后续记录撤回后原记录恢复', () => {
  const tenure = snapshot.employment.tenures.find(item => item.id === 'TEN-J4');
  assert.ok(tenure);
  assert.deepEqual(tenure.employmentIds, ['J4']);
  assert.ok(snapshot.employment.rejected.some(row => row.id === 'J1' && row.supersededBy === 'J4'));
});

test('跨法人断档超过允许间隔则重新起算', () => {
  const breakRow = snapshot.employment.breaks.find(item => item.personId === 'PER-A01');
  assert.ok(breakRow);
  assert.equal(breakRow.reasons[0], 'gap');
  const second = snapshot.employment.tenures.find(item => item.id === 'TEN-J2');
  assert.equal(second.begin, 38);
  assert.equal(second.breakFromPrevious.gap, 7);
});

test('在岗天数按区间并集计算，重叠过渡不重复计', () => {
  const tenure = snapshot.employment.tenures.find(item => item.id === 'TEN-J4');
  // J4: 15–30，共 16 天，结束日含当日。
  assert.equal(tenure.serviceDays, 16);
});

test('重叠提名决为 shared 时按份额折算，入职前已受理争议约束归因', () => {
  const resolution = snapshot.resolutions.get('TEN-J4');
  assert.equal(resolution.status, 'allocated');
  const byAgency = Object.fromEntries(resolution.allocations.map(item => [item.agency, item.share]));
  assert.equal(byAgency.H1, 0.6);
  assert.equal(byAgency.H2, 0.4);
});

test('撤回提名使机构丧失结算权利，明确单项按标准份额', () => {
  assert.equal(snapshot.resolutions.get('TEN-J5').status, 'none');
  const single = snapshot.resolutions.get('TEN-J3');
  assert.equal(single.allocations[0].agency, 'H2');
  assert.equal(single.allocations[0].share, 1);
});

test('活动成效按窗口内首次符合的任职计，覆盖率分母为可跟踪登记人', () => {
  const e1 = snapshot.activity.events.find(event => event.event === 'E1');
  const e2 = snapshot.activity.events.find(event => event.event === 'E2');
  assert.equal(e1.registered, 14);
  assert.equal(e2.registered, 14);
  // 同一人只在最早接触的活动计成效一次。
  const counted = [...e1.people, ...e2.people].filter(person => person.counted);
  assert.equal(new Set(counted.map(person => person.personId)).size, counted.length);
  assert.ok(e2.assistedOnly.some(item => item.personId === 'PER-A01'));
});

test('联系不到的人仍出现在覆盖率分母里', () => {
  const e1 = snapshot.activity.events.find(event => event.event === 'E1');
  assert.ok(e1.unreachable.length > 0);
  for (const missing of e1.unreachable) {
    assert.ok(e1.people.some(person => person.personId === missing.personId));
  }
});

test('一条任职可解释地串起身份、接触、提名、任职与阶段', () => {
  const chain = snapshot.chains.find(item => item.tenureId === 'TEN-J4');
  assert.deepEqual(chain.steps.map(step => step.stage), ['identity', 'contacts', 'nomination', 'employment', 'stages']);
  const contacts = chain.steps.find(step => step.stage === 'contacts');
  assert.ok(contacts.touches.length > 0);
  assert.ok(contacts.touches.every(touch => touch.day <= chain.begin));
  assert.ok(chain.explain.length >= 4);
});

test('同一人同阶段只占一笔，且被驳的申请不挤掉后续批次', () => {
  const p2 = snapshot.settlement.rows.find(row => row.payment === 'P2');
  assert.ok(p2.issues.some(issue => issue.message.includes('同一个人同阶段只占一笔')));
  assert.ok(snapshot.settlement.displacements.some(item => item.displaced === 'P2' && item.occupant === 'P1'));
});

test('未到观察期的申请挂起；任职已结束的留任节点驳回', () => {
  const p6 = snapshot.settlement.rows.find(row => row.payment === 'P6');
  assert.equal(p6.decision, 'held');
  assert.ok(p6.issues.some(issue => issue.message.includes('观察期')));
  const p3 = snapshot.settlement.rows.find(row => row.payment === 'P3');
  assert.equal(p3.decision, 'blocked');
  assert.equal(p3.issues[0].category, '资格');
});

test('已承诺但归因不成立的款列为受阻，不从账上腾空', () => {
  const p5 = snapshot.settlement.rows.find(row => row.payment === 'P5');
  assert.equal(p5.decision, 'committed-blocked');
  assert.ok(snapshot.exposure.blockedApproved >= 900);
});

test('专属额度优先，余额可用共享额度；两园区共用季度总额', () => {
  const balances = snapshot.settlement.balances;
  const h1p1 = balances.find(item => item.period === 1 && item.scope === 'H1');
  const h2p1 = balances.find(item => item.period === 1 && item.scope === 'H2');
  const sharedP1 = balances.find(item => item.period === 1 && item.scope === 'shared');
  assert.equal(h1p1.capacity, 2000);
  assert.equal(h2p1.capacity, 2100);
  assert.equal(sharedP1.capacity, 3600);
  assert.equal(sharedP1.paid + sharedP1.committed, 0);
});

test('确认的负向调整从责任机构当期占额冲抵，且不超过对应支出', () => {
  const a2 = snapshot.settlement.adjustments.find(item => item.adjustment === 'A2');
  assert.equal(a2.state, 'confirmed');
  assert.equal(a2.applied, 100);
  const h2p2 = snapshot.settlement.balances.find(item => item.period === 2 && item.scope === 'H2');
  assert.equal(h2p2.freed, 100);
});

test('同一付款的多笔确认负向调整合计不超过对应支出', async () => {
  const tables = clone(snapshot.tables);
  tables.adjustments.push(
    { adjustment: 'A3', payment: 'P1', amount: '-1000', known_day: '55', period: '2', state: 'confirmed' },
    { adjustment: 'A4', payment: 'P1', amount: '-500', known_day: '56', period: '2', state: 'confirmed' },
  );
  const result = await buildSnapshot({ tables });
  const a3 = result.settlement.adjustments.find(item => item.adjustment === 'A3');
  const a4 = result.settlement.adjustments.find(item => item.adjustment === 'A4');
  assert.equal(a3.applied, 1000);
  assert.equal(a4.applied, 200);
  assert.equal(a4.exposure, 300);
  assert.equal(a3.applied + a4.applied, 1200);
});

test('已支付款无条件占住同阶段名额，防止争议中重复发放', async () => {
  const tables = clone(snapshot.tables);
  // 再加一笔与 P1 同人同阶段、且归因也成立的申请。
  tables.settlement.push({
    payment: 'P9', alias: 'A01', stage: 'start', agency: 'H1', amount: '500', period: '2', status: 'paid',
  });
  const result = await buildSnapshot({ tables });
  const p9 = result.settlement.rows.find(row => row.payment === 'P9');
  assert.ok(p9.issues.some(issue => issue.message.includes('不得再次发放')));
  assert.ok(result.settlement.displacements.some(item => item.displaced === 'P9' && item.duplicateSettlement));
});

test('暂提调整只列敞口，不进入净额与额度', () => {
  const a1 = snapshot.settlement.adjustments.find(item => item.adjustment === 'A1');
  assert.equal(a1.applied, 0);
  assert.equal(a1.exposure, 240);
  const person = snapshot.reconciliation.find(item => item.personId === 'PER-A01');
  const second = person.periods.find(cell => cell.period === 2);
  assert.equal(second.adjustments, 0);
  assert.equal(second.net, 0);
  assert.equal(person.exposure, 240);
});

test('逐人分期对齐把已支付正额与确认调整落在同一人同一期', () => {
  const rows = snapshot.installmentAlignment();
  const a01 = rows.find(item => item.personId === 'PER-A01');
  const p1 = a01.installments.find(cell => cell.period === 1);
  assert.equal(p1.paid, 1200);
  const a04 = rows.find(item => item.personId === 'PER-A04');
  const p2 = a04.installments.find(cell => cell.period === 2);
  assert.equal(p2.adjustments, -100);
  assert.equal(a04.cumulative, 1900);
});

test('园区查询能看到阻塞环节并可提交纠正证据', () => {
  const h1 = snapshot.scopeQuery('H1');
  assert.ok(h1.applications.every(app => app.alias === 'A01' || app.alias === 'A05'));
  assert.ok(h1.evidence.some(item => item.action.includes('提名')));
  const h2 = snapshot.scopeQuery('H2');
  assert.ok(h2.applications.every(app => app.alias !== 'A05'));
  assert.ok(h2.evidence.some(item => item.canSubmit));
});

test('公开比较只发布达到样本门槛的指标', async () => {
  const result = await withTables(tables => {
    for (const row of tables.contacts) {
      if (row.event === 'E1') row.follow_consent = 'false';
    }
  });
  const e1 = result.comparison.metrics.find(metric => metric.event === 'E1');
  assert.equal(e1.publishable, false);
  assert.equal(e1.coverage, undefined);
  // 只剩一组被压时，总数也不能发布，否则可反推。
  assert.equal(result.comparison.total.published, false);
});

test('跨法人转岗按合作范围与允许间隔承接', () => {
  const analysis = snapshot.transferAnalysis('PER-A01');
  assert.equal(analysis.transfers.length, 1);
  assert.equal(analysis.transfers[0].carried, false);
  assert.equal(analysis.transfers[0].decision, '断档重新判断');
  assert.ok(analysis.transfers[0].occupiedStages.some(stage => stage.stage === 'start'));
});

test('接续间隔在允许范围内时不重算在岗天数', async () => {
  const tables = clone(snapshot.tables);
  // J4 结束于第 30 日，把 J2 提前到第 32 日：间隔 1 天不超过 2 天，应为同一段任职。
  const j2 = tables.employment.find(row => row.employment === 'J2');
  j2.begin = '32';
  const result = await buildSnapshot({ tables, asOf: 60 });
  const tenure = result.employment.tenures.find(item => item.employmentIds.includes('J2'));
  assert.deepEqual(tenure.entities, ['Y1', 'Y2']);
  assert.equal(tenure.breakFromPrevious, null);
});

test('下一期拟返还只登记敞口，不能落在已结账期', () => {
  // P4 在第 1 期已支付，调整必须落在后续期。
  const rejected = snapshot.proposeAdjustment({
    agency: 'H2', payment: 'P4', amount: -50, period: 1, state: 'proposed', knownDay: 55,
  });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /已结账/);
  const valid = snapshot.proposeAdjustment({
    agency: 'H2', payment: 'P4', amount: -50, period: 2, state: 'proposed', knownDay: 55,
  });
  assert.equal(valid.accepted, true);
  assert.equal(valid.preview.direction, '返还');
  assert.equal(valid.preview.effect.includes('敞口'), true);
  assert.equal(valid.record.adjustment, 'A3');
});

test('非责任机构不能提交他人的调整', () => {
  const rejected = snapshot.proposeAdjustment({
    agency: 'H1', payment: 'P4', amount: -50, period: 3, state: 'confirmed', knownDay: 55,
  });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /责任机构/);
});

test('撤回原始证明后原记录恢复，已发款只通过下一期调整修正', async () => {
  const tables = clone(snapshot.tables);
  const j4 = tables.employment.find(row => row.employment === 'J4');
  j4.verified_day = '';
  const restored = await buildSnapshot({ tables, asOf: 60 });
  // J4 不再可核验，J1 撤销取代关系后重新可用，A01 仍有一段可解释任职。
  assert.ok(restored.employment.tenures.some(item => item.employmentIds.includes('J1')));
  const p1Restored = restored.settlement.rows.find(row => row.payment === 'P1');
  assert.equal(p1Restored.decision, 'paid');

  // 再把 J1 也撤回，A01 只剩第 38 日起的任职，第 1 期已发款需要下一期调整。
  const j1 = tables.employment.find(row => row.employment === 'J1');
  j1.verified_day = '';
  const result = await buildSnapshot({ tables, asOf: 60 });
  const p1 = result.settlement.rows.find(row => row.payment === 'P1');
  assert.equal(p1.status, 'paid');
  assert.equal(p1.decision, 'paid');
  assert.ok(p1.issues.some(issue => issue.message.includes('下一期调整')));
});

test('团队分摊按各机构承担的批准金额分别计，不重复占同阶段', async () => {
  const tables = clone(snapshot.tables);
  // H1 已有 P1（start，A01），再让 H2 对同一任职同一阶段递交分摊申请。
  tables.settlement = tables.settlement.filter(row => row.payment !== 'P2');
  tables.settlement.push({
    payment: 'P2', alias: 'A01', stage: 'start', agency: 'H2', amount: '800', period: '1', status: 'requested',
  });
  const result = await buildSnapshot({ tables });
  const p1 = result.settlement.rows.find(row => row.payment === 'P1');
  const p2 = result.settlement.rows.find(row => row.payment === 'P2');
  // P-A start 奖励 2000：H1 0.6 → 1200，H2 0.4 → 800。
  assert.equal(p1.entitlement, 1200);
  assert.equal(p2.entitlement, 800);
  assert.ok(!p2.issues.some(issue => issue.code === 'stage-taken' || issue.code === 'duplicate-settlement'));
  assert.equal(p2.decision, 'approved');
  assert.equal(p2.approvedAmount, 800);
  // 两笔合计正好一笔批准金额，不重复占额。
  assert.equal(p1.approvedAmount + p2.approvedAmount, 2000);
});

test('结账后身份确认会改变成效比较，而不是改写已发款', async () => {
  const before = await buildSnapshot({ asOf: 46 });
  const after = await buildSnapshot({ asOf: 60 });
  const beforeCount = before.activity.qualifying.length;
  const afterCount = after.activity.qualifying.length;
  // A01/A02 在第 48 日确认合并，此后同一个人只计一次成效。
  assert.notEqual(beforeCount, afterCount);
  assert.ok(after.activity.qualifying.some(item => item.personId === 'PER-A01'));
  // 已发款仍留在原期，只能通过下一期调整处理。
  const paid = after.settlement.rows.filter(row => row.status === 'paid');
  assert.ok(paid.length > 0);
});

test('活动成效口径不替代推荐结算权利', () => {
  // A04 在 E2 计成效，但结算归因看的是 C3 的保护期与 share。
  const e2 = snapshot.activity.events.find(event => event.event === 'E2');
  assert.ok(e2.people.some(person => person.personId === 'PER-A04' && person.counted));
  const resolution = snapshot.resolutions.get('TEN-J3');
  assert.equal(resolution.allocations[0].agency, 'H2');
  // A05 在 E1 计成效，但提名已撤回，结算权利仍为零。
  const e1 = snapshot.activity.events.find(event => event.event === 'E1');
  assert.ok(e1.people.some(person => person.personId === 'PER-A05' && person.counted));
  assert.equal(snapshot.resolutions.get('TEN-J5').status, 'none');
});

test('多处分层被压住时合计可发布但不能分离到单个小组', async () => {
  const tables = clone(snapshot.tables);
  for (const row of tables.contacts) {
    if (row.event === 'E1' && !['T1', 'T5', 'T6'].includes(row.touch)) row.follow_consent = 'false';
    if (row.event === 'E2' && !['T2', 'T4'].includes(row.touch)) row.follow_consent = 'false';
  }
  for (let index = 0; index < 10; index += 1) {
    tables.contacts.push({
      touch: `X${index}`,
      alias: `A${20 + index}`,
      event: 'E3',
      day: '2',
      follow_consent: 'true',
      org: 'H1',
    });
  }
  const result = await buildSnapshot({ tables });
  const total = result.comparison.total;
  assert.equal(total.published, true);
  assert.equal(total.registered, 10);
  assert.deepEqual(total.suppressedEvents, ['E1', 'E2']);
  assert.match(total.note, /不能分离/);
});

test('复核后失去支撑的已发款形成下一期建议调整，需确认才落账', async () => {
  const tables = clone(snapshot.tables);
  tables.adjustments = [];
  const j1 = tables.employment.find(row => row.employment === 'J1');
  const j4 = tables.employment.find(row => row.employment === 'J4');
  j1.verified_day = '';
  j4.verified_day = '';
  const result = await buildSnapshot({ tables });
  const followUp = result.settlement.followUps.find(item => item.payment === 'P1');
  assert.ok(followUp);
  assert.equal(followUp.period, 3);
  assert.equal(followUp.suggestedAmount, -1200);
  assert.equal(followUp.state, 'proposed');
  // 尚未落账：原期净额不变。
  const person = result.reconciliation.find(item => item.personId === 'PER-A01');
  assert.equal(person.periods.find(cell => cell.period === 1).net, 1200);
});

test('解析空字段保留为空，格式错误报出行号', () => {
  assert.deepEqual(parseTable('id,note\nX,\n', ['id', 'note'], '交接'), [{ id: 'X', note: '' }]);
  assert.throws(() => parseTable('id,note\nX\n', ['id', 'note'], '交接'), /第 2 行/);
});
