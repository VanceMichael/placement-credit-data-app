import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const fixturesUrl = new URL('../fixtures/', import.meta.url);

/**
 * 解析约定的无引号 CSV。空字段保留为空字符串，行号从数据首行开始计。
 */
export function parseTable(content, fields, table) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, position) => [field, cells[position]]));
  });
}

/** 空引用与“不适用”允许留空，其余引用必须能在目标表定位。 */
export function checkLinks(tables, links) {
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== '-' && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

export async function loadTables(source = fixturesUrl) {
  const format = JSON.parse(await readFile(new URL('format.json', source), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    const content = await readFile(new URL(`${name}.csv`, source), 'utf8');
    tables[name] = parseTable(content, fields, name);
    if (tables[name].length === 0) {
      throw new Error(`${name} 没有交接记录`);
    }
  }
  checkLinks(tables, format.links);
  return { tables, format };
}

export async function checkMaterials(source = fixturesUrl) {
  const { tables } = await loadTables(source);
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

export const number = value => (value === '' || value === '-' || value === undefined ? null : Number(value));
export const boolean = value => value === 'true';
export const splitList = value => (value === '' || value === '-' ? [] : value.split('|'));

/** 支付编号按数字段排序，保证同一文件内顺序稳定。 */
export function naturalCompare(left, right) {
  const split = value => String(value).match(/\d+|\D+/g) ?? [];
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const na = Number(a[index]);
    const nb = Number(b[index]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const counts = await checkMaterials();
  console.log(JSON.stringify({ 状态: '资料可读取', 记录数: counts }, null, 2));
}
