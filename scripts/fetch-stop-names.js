#!/usr/bin/env node
'use strict';
/* fetch-stop-names.js — 按 node id 批量反查站名（metro-relations 的 stop node 无 tags，需单独查）
 * 用法: node scripts/fetch-stop-names.js
 * 产出: data/raw/stop-names.json  { nodeId: name }
 */
const fs = require('fs');
const path = require('path');

const PROXY = process.env.RAILMAP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY && !process.env.NODE_USE_ENV_PROXY && !process.env.RAILMAP_REEXEC) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', RAILMAP_REEXEC: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  return;
}

const RAW = path.join(__dirname, '..', 'data', 'raw');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 railmap/0.1';
const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.osm.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 收集所有 stop node id（从 metro-relations + special-relations）
const ids = new Set();
for (const f of ['metro-relations', 'special-relations']) {
  const p = path.join(RAW, `${f}.json`);
  if (!fs.existsSync(p)) continue;
  const els = JSON.parse(fs.readFileSync(p, 'utf8')).elements;
  for (const el of els) {
    if (el.type !== 'relation') continue;
    for (const m of el.members || []) {
      if (m.type === 'node' && /^stop|^platform/.test(m.role || '')) ids.add(m.ref);
      if (m.type === 'node' && m.role === '') ids.add(m.ref); // PTv1
    }
  }
}
const idList = [...ids];
console.log(`待查站名 node: ${idList.length}`);

async function query(endpoint, batch) {
  const q = `[out:json][timeout:60];node(id:${batch.join(',')});out tags;`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.elements || [];
}

(async () => {
  const rounds = parseInt((process.argv.find(a => a.startsWith('--rounds=')) || '').slice(9) || '1', 10);
  for (let round = 1; round <= rounds; round++) {
    const out = {};
    const outFile = path.join(RAW, 'stop-names.json');
    if (fs.existsSync(outFile)) Object.assign(out, JSON.parse(fs.readFileSync(outFile, 'utf8')));
    const remaining = idList.filter(id => !out[id]);
    if (!remaining.length) { console.log(`全部 ${idList.length} 个站名已齐`); return; }
    console.log(`\n===== 第 ${round}/${rounds} 轮：还需 ${remaining.length} =====`);
    const BATCH = 200;
    let epIdx = 0;
    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH);
      let ok = false;
      for (let t = 0; t < ENDPOINTS.length && !ok; t++) {
        const ep = ENDPOINTS[(epIdx + t) % ENDPOINTS.length];
        try {
          process.stdout.write(`  批 ${i / BATCH + 1}/${Math.ceil(remaining.length / BATCH)} @ ${new URL(ep).host} ... `);
          const els = await query(ep, batch);
          for (const el of els) {
            if (el.tags?.name) out[el.id] = el.tags.name;
          }
          epIdx = (epIdx + t) % ENDPOINTS.length; // 记住好用的端点
          console.log(`OK ${els.length}`);
          ok = true;
        } catch (e) {
          console.log(`失败: ${e.message}`);
        }
      }
      if (!ok) console.log('  [warn] 该批全部端点失败，跳过');
      fs.writeFileSync(outFile, JSON.stringify(out)); // 增量保存
      await sleep(1500);
    }
    if (round < rounds) await sleep(20000);
  }
  const final = JSON.parse(fs.readFileSync(path.join(RAW, 'stop-names.json'), 'utf8'));
  console.log(`\n完成: ${Object.keys(final).length}/${idList.length} 个站名`);
})();
