import { number } from './tables.mjs';

export const STAGE_ORDER = ['start', 'retain'];

export function policyIndex(tables) {
  const byEntity = new Map();
  const byName = new Map();
  for (const row of tables.policy) {
    const policy = {
      name: row.policy,
      scopes: row.scope === '-' || row.scope === '' ? [] : row.scope.split('|'),
      maxGap: number(row.max_gap) ?? 0,
      phases: (row.phase_days === '' ? '0' : row.phase_days).split('|').map(Number),
      awards: (row.award === '' ? '0' : row.award).split('|').map(Number),
      publishMinimum: number(row.publish_minimum) ?? 0,
    };
    byName.set(policy.name, policy);
    for (const scope of policy.scopes) byEntity.set(scope, policy);
  }
  return { byEntity, byName, policies: [...byName.values()] };
}

export function policyForEntity(index, entity) {
  return index.byEntity.get(entity) ?? null;
}

function overlapLength(intervals) {
  const sorted = intervals
    .map(([from, to]) => [from, to])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current = null;
  for (const [from, to] of sorted) {
    if (!current) {
      current = [from, to];
    } else if (from <= current[1] + 1) {
      current[1] = Math.max(current[1], to);
    } else {
      total += current[1] - current[0] + 1;
      current = [from, to];
    }
  }
  if (current) total += current[1] - current[0] + 1;
  return total;
}

function intersects(policy, leftEntity, rightEntity) {
  return policy.scopes.includes(leftEntity) && policy.scopes.includes(rightEntity);
}

function transitionPolicy(index, leftEntity, rightEntity) {
  if (leftEntity === rightEntity) return policyForEntity(index, leftEntity);
  const left = policyForEntity(index, leftEntity);
  const right = policyForEntity(index, rightEntity);
  if (left && right && left.name === right.name && intersects(left, leftEntity, rightEntity)) {
    return left;
  }
  return null;
}

/**
 * 可核验的任职记录：确认日已到，且未被确认的后续记录取代。
 * 被取代的记录不参与任职链；撤回后续记录后原记录重新可用。
 */
export function acceptableEmployments(tables, asOf) {
  const rows = tables.employment.map(row => ({
    id: row.employment,
    alias: row.alias,
    entity: row.entity,
    role: row.role,
    begin: number(row.begin),
    end: number(row.end),
    verifiedDay: number(row.verified_day),
    supersedes: row.supersedes === '-' || row.supersedes === '' ? null : row.supersedes,
    issues: [],
  }));

  const byId = new Map(rows.map(row => [row.id, row]));
  const accepted = [];
  const rejected = [];
  for (const row of rows) {
    if (row.verifiedDay === null) {
      rejected.push({ ...row, reason: '缺少可核验的入职证明' });
      continue;
    }
    if (row.verifiedDay > asOf) {
      rejected.push({ ...row, reason: '入职证明在统计时点尚未核验完成' });
      continue;
    }
    if (row.begin === null) {
      rejected.push({ ...row, reason: '缺少实际到岗日' });
      continue;
    }
    accepted.push(row);
  }

  const acceptedIds = new Set(accepted.map(row => row.id));
  const superseded = new Map();
  for (const row of accepted) {
    if (row.supersedes && acceptedIds.has(row.supersedes)) {
      const original = byId.get(row.supersedes);
      if (original) superseded.set(original.id, row.id);
    }
  }

  // 沿取代链传递：若 A 取代 B，C 又取代 A，则 B、A 均被 C 取代。
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, by] of superseded) {
      const child = byId.get(by);
      if (child && superseded.has(child.id)) {
        const replacement = superseded.get(child.id);
        if (superseded.get(id) !== replacement) {
          superseded.set(id, replacement);
          changed = true;
        }
      }
    }
  }

  const usable = [];
  for (const row of accepted) {
    if (superseded.has(row.id)) {
      rejected.push({
        ...row,
        reason: `已被后续记录 ${superseded.get(row.id)} 取代`,
        supersededBy: superseded.get(row.id),
      });
    } else {
      usable.push(row);
    }
  }

  return { accepted: usable, rejected, superseded, byId };
}

/**
 * 按人、岗位与时间形成任职链。跨法人只在同一合作政策且间隔不超过
 * max_gap 时承接；断档或范围外转岗重新起算。在岗天数按区间并集计算，
 * 重叠的跨法人过渡不重复计。
 */
export function buildTenures(tables, personOf, index, asOf) {
  const { accepted, rejected, superseded } = acceptableEmployments(tables, asOf);
  const grouped = new Map();
  for (const row of accepted) {
    const person = personOf.get(row.alias);
    if (!person) {
      rejected.push({ ...row, reason: `别名 ${row.alias} 不在联系记录中` });
      continue;
    }
    if (!grouped.has(person.id)) grouped.set(person.id, []);
    grouped.get(person.id).push(row);
  }

  const tenures = [];
  const breaks = [];
  for (const [personId, rows] of grouped) {
    rows.sort((a, b) => (a.begin - b.begin) || (a.id < b.id ? -1 : 1));
    let current = null;

    const startTenure = row => {
      const policy = policyForEntity(index, row.entity);
      current = {
        id: `TEN-${row.id}`,
        personId,
        role: row.role,
        entities: [row.entity],
        employmentIds: [row.id],
        records: [row],
        begin: row.begin,
        end: row.end ?? asOf,
        ongoing: row.end === null,
        policy,
        breakFromPrevious: null,
      };
      tenures.push(current);
    };

    for (const row of rows) {
      if (!current) {
        startTenure(row);
        continue;
      }
      const last = current.records[current.records.length - 1];
      const lastEnd = current.end;
      const gap = row.begin - lastEnd - 1;
      const transition = transitionPolicy(index, last.entity, row.entity);
      const problems = [];
      if (row.role !== current.role) {
        problems.push({ code: 'role-change', message: `岗位由 ${current.role} 变为 ${row.role}，重新判断任职` });
      }
      if (!transition) {
        problems.push({
          code: 'scope',
          message: `${last.entity} 至 ${row.entity} 不在同一合作范围，不能承接任职`,
        });
      } else if (gap > transition.maxGap) {
        problems.push({
          code: 'gap',
          message: `断档 ${gap} 天超过允许间隔 ${transition.maxGap} 天，重新判断任职`,
        });
      }

      if (problems.length > 0) {
        const previous = current;
        startTenure(row);
        current.breakFromPrevious = {
          fromTenure: previous.id,
          fromEntity: last.entity,
          toEntity: row.entity,
          gap,
          reason: problems.map(problem => problem.code),
          message: problems.map(problem => problem.message).join('；'),
        };
        breaks.push({
          personId,
          from: previous.id,
          to: current.id,
          gap,
          reasons: problems.map(problem => problem.code),
          message: current.breakFromPrevious.message,
        });
        continue;
      }

      current.records.push(row);
      current.employmentIds.push(row.id);
      if (!current.entities.includes(row.entity)) current.entities.push(row.entity);
      if (row.end === null) {
        current.end = asOf;
        current.ongoing = true;
      } else {
        current.end = Math.max(current.end, row.end);
        current.ongoing = false;
      }
      if (!current.policy) current.policy = transition;
    }
  }

  for (const tenure of tenures) {
    tenure.serviceDays = overlapLength(
      tenure.records.map(row => [row.begin, row.end ?? asOf]),
    );
    tenure.policyName = tenure.policy?.name ?? null;
    tenure.policyScope = tenure.policy?.scopes ?? [];
    tenure.stages = buildStages(tenure, asOf);
    tenure.chain = [];
  }

  return { tenures, rejected, superseded, breaks };
}

export function buildStages(tenure, asOf) {
  const phases = tenure.policy?.phases ?? [0];
  const awards = tenure.policy?.awards ?? [0];
  return phases.map((offset, position) => {
    const stage = STAGE_ORDER[position] ?? `stage-${position + 1}`;
    const anchor = tenure.begin + offset;
    const observed = anchor <= asOf;
    const supported = anchor <= tenure.end;
    let status = 'reached';
    if (!observed) status = 'not-observed';
    else if (!supported) status = 'not-reached';
    return {
      stage,
      offset,
      anchor,
      award: awards[position] ?? 0,
      observed,
      supported,
      status,
    };
  });
}

export function stageOf(tenure, stage) {
  return tenure.stages.find(item => item.stage === stage) ?? null;
}

/** 返回某人最早的可核验任职（用于“人在窗口内首次符合的任职”）。 */
export function firstTenure(tenures, personId) {
  return tenures
    .filter(item => item.personId === personId)
    .sort((a, b) => (a.begin - b.begin) || (a.id < b.id ? -1 : 1))[0] ?? null;
}
