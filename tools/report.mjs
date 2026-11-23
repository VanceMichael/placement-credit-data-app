#!/usr/bin/env node
import { buildSnapshot } from '../src/engine.mjs';
import { checkMaterials } from '../src/tables.mjs';

const yuan = value => (value === null || value === undefined ? '-' : `${Math.round(value * 100) / 100}`);

function line(label, value) {
  return `${label.padEnd(22, ' ')} ${value}`;
}

function activitySection(snapshot) {
  const out = ['## 活动成效（窗口内首次符合的任职）'];
  for (const event of snapshot.activity.events) {
    out.push(`${event.event}：登记且可跟踪 ${event.registered} 人，成效 ${event.successes} 人，覆盖率 ${event.coverage ?? '-'}%`);
    if (event.unreachable.length > 0) out.push(`  联系不到：${event.unreachable.map(item => item.personId).join('、')}`);
    if (event.missingTracking.length > 0) out.push(`  缺跟踪登记：${event.missingTracking.map(item => item.personId).join('、')}`);
    if (event.assistedOnly.length > 0) {
      out.push(`  已在更早活动计入：${event.assistedOnly.map(item => `${item.personId}→${item.creditedEvent}`).join('、')}`);
    }
    if (event.untrackedSuccesses.length > 0) {
      out.push(`  有成效但无可用活动接触：${event.untrackedSuccesses.map(item => item.personId).join('、')}`);
    }
  }
  return out;
}

function settlementSection(snapshot) {
  const out = ['## 结账'];
  for (const row of snapshot.settlement.rows) {
    out.push(line(
      `${row.payment} ${row.agency} ${row.stage}`,
      `${row.alias}/${row.personId ?? '?'} 申请 ${row.amount} → ${row.decision} ${yuan(row.approvedAmount)}`,
    ));
    for (const issue of row.issues) out.push(`  · [${issue.category}] ${issue.message}`);
  }
  out.push('## 额度');
  for (const balance of snapshot.settlement.balances) {
    out.push(line(
      `第 ${balance.period} 期 ${balance.scope}`,
      `额度 ${balance.capacity} 已用 ${balance.used} 可用 ${balance.available} 挂起 ${balance.heldAmount}`,
    ));
  }
  return out;
}

function chainSection(snapshot) {
  const out = ['## 任职接触链'];
  for (const chain of snapshot.chains) {
    out.push(`${chain.tenureId} ${chain.personId} ${chain.role} 第 ${chain.begin} 日`);
    for (const step of chain.explain) out.push(`  · ${step}`);
    const nomination = chain.steps.find(step => step.stage === 'nomination');
    if (nomination.pending.length > 0) out.push(`  · 待决提名：${nomination.pending.join('、')}`);
    if (nomination.withdrawn.length > 0) out.push(`  · 已撤回提名：${nomination.withdrawn.join('、')}`);
    if (nomination.postHireDisputes.length > 0) {
      out.push(`  · 入职后受理争议：${nomination.postHireDisputes.map(item => item.claim).join('、')}`);
    }
  }
  return out;
}

function exposureSection(snapshot) {
  const out = ['## 敞口与可另拨'];
  out.push(line('暂提/受阻敞口', yuan(snapshot.exposure.exposure)));
  out.push(line('挂起申请', yuan(snapshot.exposure.reserved)));
  out.push(line('受阻未占额', yuan(snapshot.exposure.blockedApproved)));
  out.push(line('已承诺未支撑', yuan(snapshot.exposure.committedUnbacked)));
  out.push(line('可另拨余额', yuan(snapshot.exposure.availableForReallocation)));
  for (const followUp of snapshot.settlement.followUps) {
    out.push(line(
      `下一期建议 ${followUp.payment}`,
      `${followUp.agency} 第 ${followUp.period} 期 拟返还 ${yuan(followUp.suggestedAmount)}（需机构确认）`,
    ));
  }
  for (const person of snapshot.reconciliation) {
    out.push(line(
      `逐人 ${person.personId}`,
      person.periods.map(cell => `第${cell.period}期净 ${yuan(cell.net)}`).join('；') + `，累计 ${yuan(person.cumulative)}`
        + (person.exposure > 0 ? `，敞口 ${yuan(person.exposure)}` : ''),
    ));
  }
  return out;
}

function comparisonSection(snapshot) {
  const out = ['## 公开比较'];
  for (const metric of snapshot.comparison.metrics) {
    out.push(metric.publishable
      ? `${metric.event}：覆盖率 ${metric.coverage}%（有效观察 ${metric.observedPersons} 人）`
      : `${metric.event}：不发布（${metric.suppressedReason}）`);
  }
  out.push(`总数：${snapshot.comparison.total.published
    ? `覆盖率 ${snapshot.comparison.total.coverage}%`
    : `不发布（${snapshot.comparison.total.note}）`}`);
  return out;
}

function querySection(snapshot) {
  const scopes = [...new Set(snapshot.tables.claims.map(row => row.agency))].sort();
  const out = ['## 园区查询'];
  for (const scope of scopes) {
    const query = snapshot.scopeQuery(scope);
    out.push(`${scope}：${query.openApplications} 项阻塞`);
    for (const app of query.applications.filter(row => row.blocking)) {
      out.push(`  ${app.payment} ${app.stage} [${app.categories.join('/')}] ${app.reasons.map(item => item.message).join('；')}`);
    }
    for (const item of query.evidence) out.push(`  → ${item.payment} ${item.action}（${item.canSubmit ? '可提交' : '无需提交'}）`);
  }
  return out;
}

export async function report(source) {
  const snapshot = await buildSnapshot({ source });
  return [
    '# 人才对接成果归因与补贴结账',
    line('统计时点', `第 ${snapshot.asOf} 日`),
    line('身份', `${snapshot.identities.persons.length} 人，待核实弱匹配 ${snapshot.identities.pendingCandidates.length} 条`),
    line('可核验任职', `${snapshot.employment.tenures.length} 段，断档重判 ${snapshot.employment.breaks.length} 次`),
    '',
    ...activitySection(snapshot),
    '',
    ...settlementSection(snapshot),
    '',
    ...chainSection(snapshot),
    '',
    ...exposureSection(snapshot),
    '',
    ...comparisonSection(snapshot),
    '',
    ...querySection(snapshot),
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('report.mjs')) {
  const counts = await checkMaterials();
  const text = await report();
  console.log(text);
  console.error(`\n资料记录：${JSON.stringify(counts)}`);
}
