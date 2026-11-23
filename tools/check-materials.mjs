import { pathToFileURL } from 'node:url';
import { checkLinks, checkMaterials, loadTables, parseTable } from '../src/tables.mjs';

export { checkLinks, checkMaterials, loadTables, parseTable };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const counts = await checkMaterials();
  console.log(JSON.stringify({ 状态: '资料可读取', 记录数: counts }, null, 2));
}
