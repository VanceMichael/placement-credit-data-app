import { BLOCK } from './funding.mjs';
import { naturalCompare } from './tables.mjs';

function reasonCategories(issues) {
  const categories = new Set(issues.map(issue => issue.category));
  const labels = [];
  if (categories.has(BLOCK.qualification)) labels.push('资格');
  if (categories.has(BLOCK.attribution)) labels.push('归因');
  if (categories.has(BLOCK.payment)) labels.push('付款');
  return labels;
}

const OPEN_DECISIONS = new Set(['held', 'blocked', 'partial', 'committed-blocked']);

/**
 * 园区自助查询：只看与本园区相关的申请，逐条说明阻塞发生在资格、
 * 归因还是付款环节，并给出可提交或纠正的证据类型。
 */
export function scopeQuery({ scope, settlement, disputes, claims, asOf }) {
  const applications = settlement.rows
    .filter(row => row.agency === scope)
    .map(row => {
      const blocking = OPEN_DECISIONS.has(row.decision)
        || (row.decision === 'paid' && row.issues.some(issue => issue.category === BLOCK.payment));
      return {
        payment: row.payment,
        personId: row.personId,
        alias: row.alias,
        tenureId: row.tenureId,
        stage: row.stage,
        period: row.period,
        status: row.status,
        decision: row.decision,
        amount: row.amount,
        approvedAmount: row.approvedAmount,
        blocking,
        categories: reasonCategories(row.issues),
        reasons: row.issues,
      };
    });

  const evidence = [];
  for (const row of applications) {
    if (!row.blocking) continue;
    if (row.status === 'paid' && row.reasons.some(reason => reason.code === 'settled-no-reclaim')) {
      evidence.push({
        payment: row.payment,
        action: '提交下一期调整',
        what: '已结算款不回溯腾空；证据撤回或纠正后，只能在下一期以返还/补发调整对齐',
        canSubmit: true,
      });
      continue;
    }
    const codes = new Set(row.reasons.map(reason => reason.code).filter(Boolean));
    const attribution = row.reasons.some(reason => reason.category === BLOCK.attribution
      && reason.code !== 'post-hire-dispute');
    const qualification = row.reasons.some(reason => reason.category === BLOCK.qualification
      && !['stage-ended', 'no-stage', 'no-tenure'].includes(reason.code));
    const payment = row.reasons.some(reason => reason.category === BLOCK.payment);

    // 每个申请只给首要动作，避免“等待观察期”和“补件”同时出现。
    if ((codes.has('stage-not-observed') || codes.has('quota-exhausted')) && !attribution
      && !codes.has('no-tenure') && !codes.has('no-stage') && !codes.has('stage-ended')
      && !codes.has('duplicate-settlement') && !codes.has('stage-taken')) {
      evidence.push({
        payment: row.payment,
        action: codes.has('stage-not-observed') ? '等待观察期' : '等待额度释放',
        what: codes.has('stage-not-observed')
          ? '该阶段尚未到观察期，到点后重新运行即可，无需补件'
          : '本期额度已排满，结账释放后重新运行，无需补件',
        canSubmit: false,
      });
      continue;
    }
    if (codes.has('stage-ended') || codes.has('no-stage') || codes.has('no-tenure')) {
      evidence.push({
        payment: row.payment,
        action: '核对任职与阶段',
        what: codes.has('stage-ended')
          ? '该节点到达前任职已结束，无法靠补件补出在岗，需更正任职记录或撤回申请'
          : '当前没有可核验的任职或阶段记录，需先更正资料',
        canSubmit: true,
      });
      continue;
    }
    if (attribution) {
      evidence.push({
        payment: row.payment,
        action: '提交提名或争议决议材料',
        what: '归因阻塞只能由有效提名、保护期或已决争议纠正，补充工作证明不能替代',
        canSubmit: true,
      });
      continue;
    }
    if (codes.has('duplicate-settlement') || codes.has('stage-taken')) {
      evidence.push({
        payment: row.payment,
        action: '核对同阶段唯一性',
        what: '同一个人同阶段只能占一笔；如认为占位错误，提交结账复议而非新申请',
        canSubmit: true,
      });
      continue;
    }
    if (qualification) {
      evidence.push({
        payment: row.payment,
        action: '提交可核验的入职或留任证明',
        what: '资格阻塞在证明核验通过后按当前证据重算',
        canSubmit: true,
      });
      continue;
    }
    if (payment) {
      evidence.push({
        payment: row.payment,
        action: '更正金额',
        what: '金额超过批准份额时只能下调到份额以内，不能靠增加证据绕过',
        canSubmit: true,
      });
    }
  }

  const balances = settlement.balances
    .filter(balance => balance.scope === scope)
    .map(balance => ({
      period: balance.period,
      scope: balance.scope,
      capacity: balance.capacity,
      used: balance.used,
      available: balance.available,
      heldAmount: balance.heldAmount,
    }));

  const claimIds = new Set(claims.filter(claim => claim.agency === scope).map(claim => claim.claim));
  const relevantDisputes = disputes
    .filter(dispute => claimIds.has(dispute.claim))
    .sort((a, b) => naturalCompare(a.claim, b.claim));

  return {
    scope,
    asOf,
    applications,
    evidence,
    balances,
    disputes: relevantDisputes,
    openApplications: applications.filter(row => row.blocking).length,
  };
}

function thresholdFor(event, tenuresByPerson, policyIndex) {
  const values = [];
  for (const person of event.people) {
    if (!person.tenureId) continue;
    const tenure = tenuresByPerson.get(person.tenureId);
    if (tenure?.policy?.publishMinimum) values.push(tenure.policy.publishMinimum);
  }
  if (values.length > 0) return Math.max(...values);
  return Math.max(0, ...policyIndex.policies.map(policy => policy.publishMinimum));
}

/**
 * 公开比较：只发布达到有效观察不同人门槛的分层指标。
 * 若被压住的组恰好只有一个，分层加总数可反推该组，于是总数一并压住；
 * 不做会泄漏小组的差补发布。
 */
export function publishComparison({ activity, tenures, policyIndex, asOf }) {
  const tenuresByPerson = new Map(tenures.map(tenure => [tenure.id, tenure]));
  const metrics = activity.events.map(event => {
    const observed = new Set(event.people
      .filter(person => person.tenureId && person.begin !== null && person.begin <= asOf)
      .map(person => person.personId));
    const minimum = thresholdFor(event, tenuresByPerson, policyIndex);
    const publishable = observed.size >= minimum;
    return {
      event: event.event,
      window: event.window,
      observedPersons: observed.size,
      minimum,
      publishable,
      registered: event.registered,
      successes: event.successes,
      coverage: publishable ? event.coverage : null,
      suppressedReason: publishable
        ? null
        : `有效观察不同人 ${observed.size} 少于发布门槛 ${minimum}`,
    };
  });

  const published = metrics.filter(metric => metric.publishable);
  const suppressed = metrics.filter(metric => !metric.publishable);
  const totals = published.reduce((sum, metric) => ({
    registered: sum.registered + metric.registered,
    successes: sum.successes + metric.successes,
  }), { registered: 0, successes: 0 });

  // 只压住一个分组时，总数 − 已发布分层 = 该组，即使该组为空也会暴露
  // 它的计数为零，因此总数一并压住；有两个以上被压组时只能得到合计。
  const inferable = suppressed.length === 1;
  const total = {
    published: !inferable && published.length > 0,
    events: published.length,
    registered: inferable ? null : totals.registered,
    successes: inferable ? null : totals.successes,
    coverage: inferable || totals.registered === 0
      ? null
      : Math.round((totals.successes / totals.registered) * 1000) / 10,
    suppressedEvents: suppressed.map(metric => metric.event),
    note: inferable
      ? '仅一个非空分层被压住，总数可反推该组，总数一并压住'
      : (suppressed.length > 1 ? '多处分层被压住，只能得到合计，不能分离到单个小组' : null),
  };

  return {
    asOf,
    metrics: metrics.map(metric => (metric.publishable ? metric : {
      event: metric.event,
      window: metric.window,
      observedPersons: metric.observedPersons,
      minimum: metric.minimum,
      publishable: false,
      suppressedReason: metric.suppressedReason,
    })),
    total,
  };
}
