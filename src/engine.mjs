import { loadTables, number } from './tables.mjs';
import { buildIdentities } from './identities.mjs';
import { buildTenures, policyIndex } from './employment.mjs';
import {
  buildActivity,
  buildChains,
  resolveTenureClaims,
} from './attribution.mjs';
import {
  reconcileSettlement,
  evaluateSettlement,
  exposureSummary,
} from './funding.mjs';
import { publishComparison, scopeQuery } from './queries.mjs';
import { transferAnalysis, scopeTransferCapacity } from './transfers.mjs';
import { installmentAlignment, proposeAdjustment } from './adjustments.mjs';
import { defaultAsOf } from './period.mjs';

function claimsByTenure({ tenures, tables, identities, asOf }) {
  const map = new Map();
  for (const tenure of tenures) {
    const person = identities.persons.find(item => item.id === tenure.personId);
    map.set(tenure.id, resolveTenureClaims(tenure, tables, person, asOf));
  }
  return map;
}

/**
 * 从当前资料生成一份快照。asOf 决定“当前证据”的时点：
 * 同一批资料在不同 asOf 下重算，即可看到结账后身份确认、
 * 证明撤回或争议决议对成效与结算的更新。
 */
export async function buildSnapshot(options = {}) {
  const { tables } = options.tables ? { tables: options.tables } : await loadTables(options.source);
  const index = policyIndex(tables);
  const asOf = options.asOf ?? defaultAsOf(tables);
  const periods = [...new Set(tables.funds.map(row => Number(row.period)))].sort((a, b) => a - b);
  const window = options.window ?? { from: 1, to: asOf };

  const identities = buildIdentities(tables, asOf);
  const employment = buildTenures(tables, identities.personOf, index, asOf);
  const resolutions = claimsByTenure({ tenures: employment.tenures, tables, identities, asOf });
  const chains = buildChains({
    tables,
    identities,
    tenures: employment.tenures,
    claimByTenure: resolutions,
  });
  const activity = buildActivity({
    tables,
    identities,
    tenures: employment.tenures,
    chains,
    window,
  });
  const settlement = evaluateSettlement({
    tables,
    identities,
    tenures: employment.tenures,
    resolutions,
    periods,
  });
  const reconciliation = reconcileSettlement({ settlement });
  const exposure = exposureSummary({ settlement });
  const comparison = publishComparison({
    activity,
    tenures: employment.tenures,
    policyIndex: index,
    asOf,
  });
  const claims = tables.claims.map(row => ({ claim: row.claim, agency: row.agency }));
  const disputes = tables.disputes.map(row => ({
    claim: row.claim,
    openedDay: number(row.opened_day),
    decisionDay: number(row.decision_day),
    outcome: row.outcome,
  }));

  const snapshot = {
    asOf,
    window,
    periods,
    tables,
    policy: index,
    identities,
    employment,
    resolutions,
    chains,
    activity,
    settlement,
    reconciliation,
    exposure,
    comparison,
    scopeQuery: scope => scopeQuery({
      scope,
      settlement,
      adjustments: settlement.adjustments,
      disputes,
      claims,
      asOf,
    }),
    transferAnalysis: personId => transferAnalysis({
      tables,
      tenures: employment.tenures,
      personId,
      index,
    }),
    capacityFor: (personId, park) => scopeTransferCapacity({
      settlement,
      tenures: employment.tenures,
      personId,
      park,
    }),
    /** 机构提交下一期拟返还/补发确认；确认后重新运行资料才会落账。 */
    proposeAdjustment: input => proposeAdjustment({ tables, settlement, ...input }),
    installmentAlignment: () => installmentAlignment({ reconciliation }),
  };

  return snapshot;
}

export { loadTables } from './tables.mjs';
