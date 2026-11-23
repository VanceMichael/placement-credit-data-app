import { policyForEntity } from './employment.mjs';

/**
 * 跨法人转岗承接分析。只有同一合作政策、岗位不变、间隔不超过
 * max_gap 才能承接；否则断档重新判断。这里同时给出原法人已占阶段、
 * 补充证明能支持的后继阶段，供结账前核对。园区额度另行按 park 查看。
 */
export function transferAnalysis({ tables, tenures, personId, index }) {
  const ordered = tenures
    .filter(tenure => tenure.personId === personId)
    .sort((a, b) => (a.begin - b.begin) || (a.id < b.id ? -1 : 1));
  if (ordered.length === 0) return { personId, transfers: [], note: '没有可核验任职' };

  const transfers = [];
  for (let position = 1; position < ordered.length; position += 1) {
    const from = ordered[position - 1];
    const to = ordered[position];
    const fromEntity = from.entities[from.entities.length - 1];
    const toEntity = to.entities[0];
    if (fromEntity === toEntity) continue;
    const fromPolicy = policyForEntity(index, fromEntity);
    const toPolicy = policyForEntity(index, toEntity);
    const samePolicy = fromPolicy && toPolicy && fromPolicy.name === toPolicy.name;
    const gap = to.begin - from.end - 1;
    const maxGap = fromPolicy?.maxGap ?? 0;
    const carried = Boolean(samePolicy && gap <= maxGap && from.role === to.role);

    const occupied = from.stages
      .filter(stage => stage.status === 'reached')
      .map(stage => ({ stage: stage.stage, anchor: stage.anchor, award: stage.award }));

    // 后继阶段：补充证明能支持到的新任任职节点，以新任职起点重新计。
    const supportedLater = to.stages
      .filter(stage => stage.observed && stage.supported)
      .map(stage => ({ stage: stage.stage, anchor: stage.anchor, award: stage.award }));

    transfers.push({
      fromTenure: from.id,
      toTenure: to.id,
      fromEntity,
      toEntity,
      samePolicy,
      role: from.role === to.role ? 'unchanged' : `${from.role}→${to.role}`,
      gap,
      maxGap,
      carried,
      decision: carried ? '承接任职' : '断档重新判断',
      occupiedStages: occupied,
      supportedLaterStages: supportedLater,
      note: carried
        ? `${fromEntity}→${toEntity} 在 ${fromPolicy.name} 合作范围内，间隔 ${gap} 天不超过 ${maxGap} 天，承接为同一段任职`
        : `${fromEntity}→${toEntity} ${samePolicy ? `间隔 ${gap} 天超过 ${maxGap} 天` : '不在同一合作范围'}，新任职从第 ${to.begin} 日重新起算`,
    });
  }

  return {
    personId,
    transfers,
    note: transfers.length === 0 ? '没有跨法人转岗' : '跨法人转岗按合作范围与允许间隔判断',
  };
}

/**
 * 园区额度承接：确认候选人换到另一法人后，原园区已占阶段、补充证明
 * 可支持的后继阶段、新园区可实际承接的额度分层列出。
 */
/**
 * 园区额度承接：法人（employment.entity）与园区（funds.scope / 结算机构）
 * 在资料中不是同一维度，不能按名称直接对应。因此先按法人列出其已占与
 * 可支持阶段，再按园区列出本地专属与共享额度；调用方可用 park 指定
 * 目标园区，查看该园区实际可承接的额度。
 */
export function scopeTransferCapacity({ settlement, tenures, personId, park }) {
  const personTenures = tenures.filter(tenure => tenure.personId === personId);
  const rows = settlement.rows.filter(row => row.personId === personId);
  const byEntity = new Map();
  for (const tenure of personTenures) {
    for (const entity of tenure.entities) {
      if (!byEntity.has(entity)) byEntity.set(entity, { entity, tenures: [], occupied: [], supported: [] });
      const slot = byEntity.get(entity);
      if (!slot.tenures.includes(tenure.id)) slot.tenures.push(tenure.id);
      for (const stage of tenure.stages) {
        if (stage.status === 'reached') {
          slot.occupied.push({ stage: stage.stage, anchor: stage.anchor, award: stage.award });
        } else if (stage.observed && !stage.supported) {
          slot.occupied.push({ stage: stage.stage, anchor: stage.anchor, award: 0, note: '节点时任职已结束' });
        } else if (!stage.observed) {
          slot.supported.push({ stage: stage.stage, anchor: stage.anchor, award: stage.award });
        }
      }
    }
  }

  const parks = [...new Set(settlement.balances.map(balance => balance.scope))].sort();
  const localCapacity = settlement.balances
    .filter(balance => balance.scope !== 'shared')
    .map(balance => ({
      period: balance.period,
      park: balance.scope,
      capacity: balance.capacity,
      used: balance.used,
      available: balance.available,
    }));
  const sharedCapacity = settlement.balances
    .filter(balance => balance.scope === 'shared')
    .map(balance => ({
      period: balance.period,
      capacity: balance.capacity,
      used: balance.used,
      available: balance.available,
    }));

  const target = park ?? rows[0]?.agency ?? null;
  const canTake = target
    ? localCapacity.filter(capacity => capacity.park === target)
    : [];

  return {
    personId,
    park: target,
    parks,
    payments: rows.map(row => ({
      payment: row.payment,
      agency: row.agency,
      stage: row.stage,
      period: row.period,
      status: row.status,
      decision: row.decision,
      amount: row.amount,
      approvedAmount: row.approvedAmount,
    })),
    entities: [...byEntity.values()],
    /** 目标园区本地专属额度（新园区首先使用）。 */
    canTake,
    /** 目标园区可用共享余额。 */
    sharedCapacity,
    localCapacity,
    note: '法人承接阶段与园区额度分属不同维度；园区额度按 funds.scope 计，不能按法人名称直接对应',
  };
}
