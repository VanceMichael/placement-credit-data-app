/**
 * 跨活动身份只凭已确认的关联记录归并。待核实的弱匹配不并入，
 * 但保留为候选，便于活动团队知道哪些接触暂不能计入。
 */
export function identityLinks(tables, asOf) {
  return tables.identities
    .filter(row => row.record_day !== '' && Number(row.record_day) <= asOf)
    .map(row => ({
      id: row.link,
      left: row.left_alias,
      right: row.right_alias,
      status: row.status,
      recordDay: Number(row.record_day),
    }));
}

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  add(value) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value) {
    this.add(value);
    let root = value;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(value) !== root) {
      const next = this.parent.get(value);
      this.parent.set(value, root);
      value = next;
    }
    return root;
  }

  union(left, right) {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    // 固定取字典序较小的别名作为根，保证同一批资料输出稳定。
    if (a < b) this.parent.set(b, a);
    else this.parent.set(a, b);
  }
}

/**
 * 返回 personOf(alias) 与每个人已确认的别名集合。未在联系表中出现的
 * 别名（例如被引用但缺失）按独立身份处理，交由资料检查暴露。
 */
export function buildIdentities(tables, asOf) {
  const aliases = new Set(tables.contacts.map(row => row.alias));
  const links = identityLinks(tables, asOf);
  const dsu = new DisjointSet();
  for (const alias of aliases) dsu.add(alias);
  for (const link of links) {
    if (link.status === 'confirmed') dsu.union(link.left, link.right);
  }

  const groups = new Map();
  for (const alias of aliases) {
    const root = dsu.find(alias);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(alias);
  }

  const personOf = new Map();
  const persons = [];
  for (const [root, members] of groups) {
    const id = `PER-${[...members].sort()[0]}`;
    const person = {
      id,
      aliases: [...members].sort(),
      confirmedLinks: links.filter(link => link.status === 'confirmed'
        && members.includes(link.left) && members.includes(link.right)),
      pendingLinks: links.filter(link => link.status !== 'confirmed'
        && members.includes(link.left) && members.includes(link.right)),
    };
    persons.push(person);
    for (const alias of members) personOf.set(alias, person);
  }

  const pendingCandidates = links
    .filter(link => link.status !== 'confirmed')
    .map(link => ({
      link: link.id,
      aliases: [link.left, link.right],
      status: link.status,
      recordDay: link.recordDay,
      reason: '弱匹配待核实，暂不并入身份',
    }));

  return {
    persons: persons.sort((a, b) => (a.id < b.id ? -1 : 1)),
    personOf,
    pendingCandidates,
  };
}
