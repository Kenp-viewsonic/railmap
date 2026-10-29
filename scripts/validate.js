#!/usr/bin/env node
'use strict';
/* validate.js — 数据体检：对照期望清单找缺口
 * 用法: node scripts/validate.js
 */
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'data', 'dist');
const CURATED = path.join(__dirname, '..', 'data', 'curated');

const network = JSON.parse(fs.readFileSync(path.join(DIST, 'network.json'), 'utf8'));
const curated = JSON.parse(fs.readFileSync(path.join(CURATED, 'line-meta.json'), 'utf8'));

const issues = [];
const oks = [];

// 1. 期望线路覆盖检查
const lineKeys = new Set(network.lines.map(l => `${l.network}|${l.ref}`));
for (const [net, refs] of Object.entries(curated.expectedLines || {})) {
  for (const ref of refs) {
    const found = [...lineKeys].some(k => k.startsWith(net) && k.endsWith(`|${ref}`));
    (found ? oks : issues).push(`${net} ${ref}${found ? '' : ' —— 缺失'}`);
  }
}

// 2. 站名缺失检查
const unnamed = network.stations.filter(s => !s.names || !s.names.length);
if (unnamed.length) issues.push(`${unnamed.length} 个站无站名`);

// 3. 孤立站（不属于任何线）
const inLine = new Set(network.lines.flatMap(l => l.stations));
const orphans = network.stations.filter(s => !inLine.has(s.id));
if (orphans.length) issues.push(`${orphans.length} 个孤立站`);

// 4. 断链线路（站数 < 3 或边数 < 站数-1）
for (const l of network.lines) {
  if (l.stations.length < 3) issues.push(`${l.key} 仅 ${l.stations.length} 站`);
}

// 5. 换乘站统计
const transfers = network.stations.filter(s => s.lines.length > 1);
oks.push(`换乘站 ${transfers.length} 个`);

// 6. 疑似误合并：同名但距离远的换乘组（>3km 提示）
for (const s of transfers) {
  // 站点坐标是组内均值，无法直接检测距离；一期跳过
}

console.log('=== 数据体检 ===');
console.log(`\n✅ 正常 (${oks.length}):`);
for (const o of oks) console.log(`  ${o}`);
console.log(`\n⚠️ 问题 (${issues.length}):`);
for (const i of issues) console.log(`  ${i}`);
if (!issues.length) console.log('  无');
