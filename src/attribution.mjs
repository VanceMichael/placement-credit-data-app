import { number, naturalCompare } from './tables.mjs';

export const OUTCOME = Object.freeze({
  shared: 'shared',
  withdrawn: 'withdrawn',
  primary: 'primary',
});

function disputeOf(tables, claimId) {
  return tables.disputes
    .filter(row => row.claim === claimId)
    .map(row => ({
      claim: row.claim,
      openedDay: number(row.opened_day),
      decisionDay: number(row.decision_day),
      outcome: row.outcome,
    }))
    .sort((a, b) => (a.openedDay ?? 0) - (b.openedDay ?? 0))[0] ?? null;
}

function claimInfo(row, tables, identity, asOf) {
  const nominationDay = number(row.nomination_day);
  const protectedDays = number(row.protected_days) ?? 0;
  return {
    id: row.claim,
    alias: row.alias,
    personId: identity?.id ?? null,
    agency: row.agency,
    role: row.role,
    nominationDay,
    protectedDays,
    windowEnd: nominationDay === null ? null : nominationDay + protectedDays,
    standardShare: number(row.share) ?? 0,
    dispute: disputeOf(tables, row.claim),
    asOf,
  };
}

function claimState(claim) {
  if (!claim.dispute) return 'none';
  if (claim.dispute.decisionDay === null || claim.dispute.decisionDay > claim.asOf) return 'pending';
  return claim.dispute.outcome;
}

function windowOverlaps(left, right) {
  return left.nominationDay !== null && right.nominationDay !== null
    && Math.max(left.nominationDay, right.nominationDay) <= Math.min(left.windowEnd, right.windowEnd);
}

function cluster(claims) {
  const clusters = [];
  const remaining = [...claims];
  while (remaining.length > 0) {
    const group = [remaining.shift()];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (group.some(item => windowOverlaps(item, remaining[index]))) {
          group.push(remaining.splice(index, 1)[0]);
          changed = true;
        }
      }
    }
    clusters.push(group.sort((a, b) => (a.nominationDay - b.nominationDay) || naturalCompare(a.id, b.id)));
  }
  return clusters;
}

function normalizeShares(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.share, 0);
  if (total <= 0) return { entries, normalized: false };
  if (total <= 1 + 1e-9) return { entries, normalized: false };
  return {
    entries: entries.map(entry => ({ ...entry, share: entry.share / total })),
    normalized: true,
  };
}

/**
 * 一组并行/重叠提名的折算。只有明确单项、已决 shared 或已决 primary
 * 能形成结算权利；重叠但未决的整项挂起。
 */
function resolveCluster(clusterClaims, tenure) {
  const withdrawn = clusterClaims.filter(claim => claimState(claim) === 'withdrawn');
  const active = clusterClaims.filter(claim => claimState(claim) !== 'withdrawn');
  const notes = [];
  if (withdrawn.length > 0) {
    notes.push(`撤回请求：${withdrawn.map(claim => claim.id).join('、')}`);
  }
  if (active.length === 0) {
    return {
      status: 'none',
      allocations: [],
      notes: [...notes, '提名机构已撤回，不再享有结算权利'],
      pending: [],
      withdrawn,
    };
  }

  const pending = active.filter(claim => claimState(claim) === 'pending');
  if (pending.length > 0) {
    return {
      status: 'pending',
      allocations: [],
      notes: [...notes, `争议待决，整项暂挂：${pending.map(claim => claim.id).join('、')}`],
      pending,
      withdrawn,
    };
  }

  const shared = active.filter(claim => claimState(claim) === 'shared');
  const primary = active.filter(claim => claimState(claim) === 'primary');
  const overlapping = clusterClaims.length > 1;

  if (shared.length > 0) {
    let participants = active;
    const total = participants.reduce((sum, claim) => sum + claim.standardShare, 0);
    if (total <= 0) {
      return {
        status: 'none',
        allocations: [],
        notes: [...notes, '共享决议但份额为零，无法形成结算权利'],
        pending: [],
        withdrawn,
      };
    }
    const normalized = normalizeShares(participants.map(claim => ({
      claim,
      share: claim.standardShare,
    })));
    notes.push('并行推荐按决议 shared 折算为各自标准份额');
    if (normalized.normalized) notes.push('份额合计超过 1，按比例归一到一笔批准金额');
    return {
      status: 'allocated',
      allocations: normalized.entries.map(({ claim, share }) => ({
        agency: claim.agency,
        share,
        claims: [claim.id],
        claimIds: [claim.id],
        basis: 'shared-decision',
      })),
      notes,
      pending: [],
      withdrawn,
      normalized: normalized.normalized,
    };
  }

  if (primary.length > 0) {
    const winner = primary[0];
    notes.push(`决议 primary 归 ${winner.agency}（${winner.id}）`);
    return {
      status: 'allocated',
      allocations: [{ agency: winner.agency, share: 1, claims: [winner.id], claimIds: [winner.id], basis: 'primary-decision' }],
      notes,
      pending: [],
      withdrawn,
    };
  }

  if (overlapping) {
    return {
      status: 'pending',
      allocations: [],
      notes: [...notes, '重叠提名没有决议，整项暂挂'],
      pending: active,
      withdrawn,
    };
  }

  // 明确单项且无不利决议：按该机构标准份额。
  const only = active[0];
  const share = only.standardShare;
  if (share <= 0) {
    return { status: 'none', allocations: [], notes: [...notes, '标准份额为零'], pending: [], withdrawn };
  }
  return {
    status: 'allocated',
    allocations: [{ agency: only.agency, share, claims: [only.id], claimIds: [only.id], basis: 'standard-share' }],
    notes: [...notes, `明确单项，按 ${only.agency} 标准份额 ${share}`],
    pending: [],
    withdrawn,
  };
}

/**
 * 对一条任职，找出保护期覆盖到岗日的同岗位提名，按重叠与争议
 * 形成可结算分配。入职后才受理的争议只记录，不改变入职时的提名权。
 */
export function resolveTenureClaims(tenure, tables, identity, asOf) {
  const candidates = [];
  const rejected = [];
  for (const row of tables.claims) {
    if (!identity || !identity.aliases.includes(row.alias)) continue;
    if (row.role !== tenure.role) continue;
    const claim = claimInfo(row, tables, identity, asOf);
    if (claim.nominationDay === null) {
      rejected.push({ claim: claim.id, reason: '缺少提名日' });
      continue;
    }
    if (claim.nominationDay > tenure.begin) {
      rejected.push({ claim: claim.id, reason: '提名晚于入职' });
      continue;
    }
    if (tenure.begin > claim.windowEnd) {
      rejected.push({ claim: claim.id, reason: '入职晚于保护期' });
      continue;
    }
    candidates.push(claim);
  }

  if (candidates.length === 0) {
    return { status: 'none', allocations: [], notes: ['没有岗位匹配且在保护期内的有效提名'], pending: [], withdrawn: [], candidates: [], rejected };
  }

  const clusters = cluster(candidates);
  const allocations = [];
  const notes = [];
  const pending = [];
  const withdrawn = [];
  let pendingStatus = false;
  for (const group of clusters) {
    const resolved = resolveCluster(group, tenure);
    notes.push(...resolved.notes);
    pending.push(...resolved.pending);
    withdrawn.push(...resolved.withdrawn);
    if (resolved.status === 'pending') pendingStatus = true;
    for (const allocation of resolved.allocations) {
      allocations.push({ ...allocation, sourceClaims: group.map(claim => claim.id) });
    }
  }

  // 入职后受理的争议不影响入职时已形成的提名权，但必须在链上可见。
  const postHireDisputes = candidates
    .filter(claim => claim.dispute && claim.dispute.openedDay >= tenure.begin)
    .map(claim => ({ claim: claim.id, openedDay: claim.dispute.openedDay, outcome: claim.dispute.outcome }));

  return {
    status: pendingStatus ? 'pending' : (allocations.length > 0 ? 'allocated' : 'none'),
    allocations,
    notes,
    pending,
    withdrawn,
    candidates,
    rejected,
    postHireDisputes,
  };
}

/** 一条任职的完整接触链：身份 → 活动接触 → 提名/争议 → 任职 → 阶段。 */
export function buildChains({ tables, identities, tenures, claimByTenure }) {
  const byPerson = new Map();
  for (const tenure of tenures) {
    if (!byPerson.has(tenure.personId)) byPerson.set(tenure.personId, []);
    byPerson.get(tenure.personId).push(tenure);
  }

  return tenures.map(tenure => {
    const person = identities.persons.find(item => item.id === tenure.personId);
    const personTenures = (byPerson.get(tenure.personId) ?? [])
      .sort((a, b) => (a.begin - b.begin) || naturalCompare(a.id, b.id));
    const position = personTenures.findIndex(item => item.id === tenure.id);
    const previous = position > 0 ? personTenures[position - 1] : null;
    // 接触链只接住前一段任职结束之后、本段到岗之前的接触；跨段不重复归属。
    const previousEnd = previous ? previous.end : -Infinity;

    const touches = tables.contacts
      .filter(row => person?.aliases.includes(row.alias))
      .filter(row => Number(row.day) <= tenure.begin && Number(row.day) > previousEnd)
      .map(row => ({
        touch: row.touch,
        alias: row.alias,
        event: row.event,
        day: Number(row.day),
        followConsent: row.follow_consent === 'true',
        org: row.org,
        tracking: trackingOf(tables, row.touch),
      }))
      .sort((a, b) => (a.day - b.day) || naturalCompare(a.touch, b.touch));

    const claims = claimByTenure.get(tenure.id) ?? { allocations: [], candidates: [], notes: [], pending: [], withdrawn: [] };
    const confusing = identities.pendingCandidates.filter(candidate => person?.aliases.some(alias => candidate.aliases.includes(alias)));

    const steps = [
      {
        stage: 'identity',
        person: person?.id ?? tenure.personId,
        aliases: person?.aliases ?? [tenure.alias],
        confirmedLinks: person?.confirmedLinks.map(link => link.id) ?? [],
        pendingLinks: confusing.map(link => link.link),
        note: confusing.length > 0
          ? '弱匹配未确认，接触链只使用已确认关联'
          : '身份只由已确认关联记录连接',
      },
      {
        stage: 'contacts',
        touches,
        note: '按同一人的活动接触、岗位与到岗时间连接；接触必须早于到岗',
      },
      {
        stage: 'nomination',
        candidates: claims.candidates.map(claim => ({
          claim: claim.id,
          agency: claim.agency,
          nominationDay: claim.nominationDay,
          protectedThrough: claim.windowEnd,
          standardShare: claim.standardShare,
          dispute: claim.dispute,
        })),
        allocations: claims.allocations.map(allocation => ({
          agency: allocation.agency,
          share: allocation.share,
          claimIds: allocation.claimIds,
          basis: allocation.basis,
        })),
        notes: claims.notes,
        pending: claims.pending.map(claim => claim.id),
        withdrawn: claims.withdrawn.map(claim => claim.id),
        postHireDisputes: claims.postHireDisputes ?? [],
      },
      {
        stage: 'employment',
        employmentIds: tenure.employmentIds,
        entity: tenure.entities,
        role: tenure.role,
        begin: tenure.begin,
        end: tenure.ongoing ? null : tenure.end,
        verifiedDays: tenure.records.map(row => row.verifiedDay),
        supersedes: tenure.records.map(row => row.supersedes).filter(Boolean),
        serviceDays: tenure.serviceDays,
        note: '结束日含当日；确认日在开始日之后不代表入职更晚；在岗天数不重复计跨法人重叠',
      },
      {
        stage: 'stages',
        items: tenure.stages.map(stage => ({
          stage: stage.stage,
          anchor: stage.anchor,
          award: stage.award,
          status: stage.status,
        })),
      },
    ];

    return {
      tenureId: tenure.id,
      personId: tenure.personId,
      role: tenure.role,
      begin: tenure.begin,
      end: tenure.ongoing ? null : tenure.end,
      policy: tenure.policyName,
      entities: tenure.entities,
      breakFromPrevious: tenure.breakFromPrevious,
      steps,
      explain: [
        `${person?.id ?? tenure.personId} 于第 ${tenure.begin} 日入职 ${tenure.entities.join('→')} 的 ${tenure.role}`,
        touches.length > 0
          ? `入职前接触：${touches.map(touch => `${touch.event}/${touch.touch}@${touch.day}`).join('、')}`
          : '入职前没有可用接触',
        claims.allocations.length > 0
          ? `推荐折算：${claims.allocations.map(item => `${item.agency} ${Math.round(item.share * 1000) / 10}%`).join('、')}`
          : '没有形成结算权利的有效提名',
        tenure.breakFromPrevious ? `与前段任职断开：${tenure.breakFromPrevious.message}` : '无跨法人承接问题',
      ],
    };
  });
}

function trackingOf(tables, touch) {
  const row = tables.tracking.find(item => item.contact === touch);
  return row ? { reviewDay: Number(row.review_day), status: row.status } : null;
}

/**
 * 活动成效按“人在统计窗口内首次符合的任职”计：先按人取窗口内最早的
 * 可核验任职，再取该任职之前最早的可跟踪接触所在活动。跨活动不重复计，
 * 其余活动只能看到该人是由更早活动带来的。
 */
export function buildActivity({ tables, identities, tenures, chains, window }) {
  const events = [...new Set(tables.contacts.map(row => row.event))].sort();
  const chainByTenure = new Map(chains.map(chain => [chain.tenureId, chain]));
  const firstInWindow = new Map();
  const outsideWindow = [];
  const ordered = [...tenures].sort((a, b) => (a.begin - b.begin) || naturalCompare(a.id, b.id));
  for (const tenure of ordered) {
    const inWindow = tenure.begin >= window.from && tenure.begin <= window.to;
    if (!inWindow) {
      outsideWindow.push(tenure);
      continue;
    }
    if (!firstInWindow.has(tenure.personId)) firstInWindow.set(tenure.personId, tenure);
  }

  const qualifying = new Map();
  const untracked = [];
  for (const [personId, tenure] of firstInWindow) {
    const chain = chainByTenure.get(tenure.id);
    const touches = chain?.steps.find(step => step.stage === 'contacts')?.touches ?? [];
    const consenting = touches.filter(touch => touch.followConsent);
    const credited = consenting[0] ?? null;
    const record = {
      personId,
      tenureId: tenure.id,
      role: tenure.role,
      begin: tenure.begin,
      creditedEvent: credited?.event ?? null,
      creditedTouch: credited?.touch ?? null,
      assistedEvents: [...new Set(touches.map(touch => touch.event))],
      reason: credited
        ? `窗口内首次符合的任职，最早可跟踪接触为 ${credited.event}/${credited.touch}@${credited.day}`
        : '窗口内首次符合的任职，但没有可跟踪的活动接触',
    };
    qualifying.set(personId, record);
    if (!credited) untracked.push(record);
  }

  const activity = events.map(event => {
    const registered = new Map();
    for (const contact of tables.contacts.filter(row => row.event === event)) {
      const person = identities.personOf.get(contact.alias);
      if (!person || contact.follow_consent !== 'true') continue;
      if (!registered.has(person.id)) registered.set(person.id, []);
      registered.get(person.id).push(contact);
    }

    const detail = [...registered.entries()].map(([personId, contacts]) => {
      const statuses = contacts.map(contact => trackingOf(tables, contact.touch)).filter(Boolean).map(item => item.status);
      const contactStatus = statuses.includes('reached')
        ? 'reached'
        : (statuses.includes('unreachable') ? 'unreachable' : 'missing');
      return {
        personId,
        aliases: identities.persons.find(person => person.id === personId)?.aliases ?? [],
        contacts: contacts.map(contact => contact.touch),
        tracking: contactStatus,
        firstTenure: qualifying.get(personId) ?? null,
        counted: qualifying.get(personId)?.creditedEvent === event,
      };
    });

    const successes = detail.filter(item => item.counted);
    const unreachable = detail.filter(item => item.tracking === 'unreachable');
    const missing = detail.filter(item => item.tracking === 'missing');
    const assistedOnly = detail.filter(item => !item.counted
      && item.firstTenure
      && item.firstTenure.assistedEvents.includes(event));

    return {
      event,
      window,
      registered: detail.length,
      successes: successes.length,
      coverage: detail.length === 0 ? null : Math.round((successes.length / detail.length) * 1000) / 10,
      unreachable: unreachable.map(item => ({ personId: item.personId, aliases: item.aliases, contacts: item.contacts })),
      missingTracking: missing.map(item => ({ personId: item.personId, aliases: item.aliases, contacts: item.contacts })),
      assistedOnly: assistedOnly.map(item => ({
        personId: item.personId,
        aliases: item.aliases,
        creditedEvent: item.firstTenure.creditedEvent,
        tenureId: item.firstTenure.tenureId,
        reason: '同一人已在更早接触的活动计入，跨活动不重复计成效',
      })),
      people: detail.map(item => ({
        personId: item.personId,
        aliases: item.aliases,
        tracking: item.tracking,
        counted: item.counted,
        tenureId: item.firstTenure?.tenureId ?? null,
        role: item.firstTenure?.role ?? null,
        begin: item.firstTenure?.begin ?? null,
      })),
      untrackedSuccesses: untracked.filter(item => item.assistedEvents.includes(event)),
      outsideWindow: outsideWindow
        .filter(tenure => tenure.personId && (
          chainByTenure.get(tenure.id)?.steps.find(step => step.stage === 'contacts')
            ?.touches.some(touch => touch.event === event)
        ))
        .map(tenure => ({ personId: tenure.personId, tenureId: tenure.id, begin: tenure.begin })),
    };
  });

  return {
    window,
    events: activity,
    qualifying: [...qualifying.values()],
    untracked,
  };
}
