#!/usr/bin/env node
'use strict';
/* fetch-osm.js — 从 Overpass API 抓取原始数据并缓存到 data/raw/
 * 用法:
 *   node scripts/fetch-osm.js              # 抓取全部（已有缓存则跳过）
 *   node scripts/fetch-osm.js --force      # 忽略缓存全部重抓
 *   node scripts/fetch-osm.js rail-ways    # 只抓指定查询
 * 环境变量:
 *   HTTPS_PROXY / HTTP_PROXY / RAILMAP_PROXY  代理地址，如 http://127.0.0.1:7897
 *   OVERPASS_ENDPOINT                          强制指定端点
 */
const fs = require('fs');
const path = require('path');

// ---- 代理支持 -------------------------------------------------------------
// Node 24 的 fetch 只在 NODE_USE_ENV_PROXY=1 时才认 HTTP(S)_PROXY。
// 检测到代理变量但开关未开时，带上环境变量重新拉起自身（仅一次）。
const PROXY = process.env.RAILMAP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY && !process.env.NODE_USE_ENV_PROXY && !process.env.RAILMAP_REEXEC) {
  const { spawn } = require('child_process');
  console.log(`[proxy] 使用 ${PROXY}，以 NODE_USE_ENV_PROXY=1 重启自身`);
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', RAILMAP_REEXEC: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  return; // CommonJS 允许顶层 return：不再执行后续逻辑
}

const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');

// bbox: 上海/苏州/无锡/常州/泰州/南通/嘉兴/湖州（含少量周边余量）
// Overpass 顺序: (south, west, north, east)
const B = '29.9,118.9,33.4,122.2';

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.osm.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  // 注: overpass.osm.ch 是瑞士区域实例，对中国区域一律返回空，已移除
].filter(Boolean);

const QUERIES = {
  // 地铁/电车/轻轨/单轨 运营线路（含成员几何）
  'metro-relations': `
[out:json][timeout:300];
(
  relation[route=subway](${B});
  relation[route=light_rail](${B});
  relation[route=tram](${B});
  relation[route=monorail](${B});
);
out geom;
`,
  // route=train 线路标签普查（只要 tags，用于发现金山铁路/机场联络线等）
  'train-relation-tags': `
[out:json][timeout:180];
relation[route=train](${B});
out tags;
`,
  // 定点抓取：市域/特殊线路的完整几何
  'special-relations': `
[out:json][timeout:180];
(
  relation[route=train][name~"机场联络|金山|磁浮|磁悬浮|杭海|市域"](${B});
);
out geom;
`,
  // 国铁物理径道（usage=main / highspeed），带几何与名称
  'rail-ways': `
[out:json][timeout:300];
(
  way[railway=rail][usage=main](${B});
  way[railway=rail][highspeed=yes](${B});
);
out geom;
`,
  // 车站（节点 + 面状车站的中心点）
  'stations': `
[out:json][timeout:180];
(
  node[railway=station](${B});
  node[railway=halt](${B});
  node[railway=tram_stop](${B});
  node[public_transport=stop_position][train=yes](${B});
  node[public_transport=stop_position][subway=yes](${B});
  node[public_transport=stop_position][light_rail=yes](${B});
  node[public_transport=stop_position][tram=yes](${B});
  way[railway=station](${B});
);
out center;
`,
};

// 各查询的最低期望元素数：低于此值视为可疑响应（镜像数据残缺/被截断），自动换端点重试。
// 依据: 仅上海地铁双向 relation 就有 ~40 条；8 市国铁干线 way 数百条；车站上千。
const MIN_ELEMENTS = {
  'metro-relations': 30,
  'train-relation-tags': 8, // 金山铁路/机场联络线双向+嘉兴市域铁路，10 条左右
  'special-relations': 3, // 金山铁路/机场联络线/磁浮应至少命中数条
  'rail-ways': 300,
  'stations': 800,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// de 等公共端点对默认 UA 挑剔：用浏览器风格 UA + 项目标识
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 railmap/0.1';

// 重查询分片：全 bbox 一次抓几何太重（镜像容易 504），按网格切片抓取后合并去重。
// Overpass 返回与 bbox 相交的完整对象（不裁剪几何），因此按 id 去重即可，无需拼接。
const TILES = {
  'rail-ways': [3, 3],
  'stations': [3, 3],
};

function tileBoxes(bbox, cols, rows) {
  const [s, w, n, e] = bbox.split(',').map(Number);
  const boxes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s2 = s + ((n - s) * r) / rows;
      const n2 = s + ((n - s) * (r + 1)) / rows;
      const w2 = w + ((e - w) * c) / cols;
      const e2 = w + ((e - w) * (c + 1)) / cols;
      boxes.push([s2, w2, n2, e2].map(x => x.toFixed(4)).join(','));
    }
  }
  return boxes;
}

// 单次请求：成功返回 {ok:true, json}，失败返回 {ok:false, reason}
async function request(ep, query) {
  process.stdout.write(`  -> ${ep} ... `);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 420000);
  try {
    const res = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    if (!Array.isArray(json.elements)) return { ok: false, reason: '响应异常' };
    if (json.remark && /timed? ?out|error/i.test(json.remark)) {
      return { ok: false, reason: `服务端超时/错误: ${json.remark}` };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, reason: `失败: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(name, query, force) {
  const file = path.join(RAW_DIR, `${name}.json`);
  const min = MIN_ELEMENTS[name] ?? 0;
  if (!force && fs.existsSync(file)) {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')).elements?.length ?? 0;
    if (n >= min) {
      console.log(`[skip] ${name} 已缓存 (${n} elements)`);
      return;
    }
    console.log(`[stale] ${name} 缓存仅 ${n} elements（期望 ≥${min}），重新抓取`);
  }
  const tiles = TILES[name] ? tileBoxes(B, TILES[name][0], TILES[name][1]) : [B];
  const tiled = tiles.length > 1;
  console.log(`[fetch] ${name}${tiled ? `（分 ${tiles.length} 片）` : ''} ...`);
  const merged = new Map(); // 分片模式：type/id -> element
  const failedTiles = [];   // 分片模式：所有端点都失败的网格片（会导致地图缺口，必须报警）
  let best = null;          // 单次模式：所有端点都不达标时的兜底
  let lastGood = null;      // 分片模式：优先复用上一片成功的端点
  for (const box of tiles) {
    const q = box === B ? query : query.split(B).join(box);
    const order = lastGood ? [lastGood, ...ENDPOINTS.filter(e => e !== lastGood)] : ENDPOINTS;
    let got = false;
    for (const ep of order) {
      const r = await request(ep, q);
      if (!r.ok) { console.log(`${r.reason}, 换下一个端点`); continue; }
      const n = r.json.elements.length;
      if (tiled) {
        if (n === 0) { console.log('0 elements（可能为空片），换下一个端点确认'); continue; }
        for (const el of r.json.elements) merged.set(`${el.type}/${el.id}`, el);
        lastGood = ep;
        console.log(`OK  ${n} elements（累计 ${merged.size}）`);
        got = true;
        break;
      }
      if (n < min) {
        if (!best || n > best.json.elements.length) best = { json: r.json, ep };
        console.log(`可疑响应: 仅 ${n} elements（期望 ≥${min}），换下一个端点`);
        continue;
      }
      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(r.json));
      console.log(`OK  ${n} elements, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
      return;
    }
    if (tiled) {
      if (!got) {
        console.log('  [ERROR] 该片所有端点失败/为空，数据将不完整');
        failedTiles.push(box);
      }
      await sleep(1500);
    }
  }
  if (tiled) {
    const elements = [...merged.values()];
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ elements }));
    const size = (fs.statSync(file).size / 1048576).toFixed(1);
    if (elements.length < min) {
      console.log(`[warn] ${name}: 合并后仅 ${elements.length} elements（期望 ≥${min}），已保存 —— 数据可能不完整!`);
    } else {
      console.log(`[done] ${name}: ${elements.length} elements, ${size} MB`);
    }
    if (failedTiles.length) {
      console.log(`[ERROR] ${name}: ${failedTiles.length}/${tiles.length} 片抓取失败，地图会出现"断头"缺口:`);
      failedTiles.forEach(t => console.log(`       - ${t}`));
      console.log(`       补抓: node tmp/fetch-tile.js ${name} <片号>，或稍后重跑本脚本`);
      process.exitCode = 1;
    }
    return;
  }
  if (best) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(best.json));
    console.log(`[warn] ${name}: 所有端点均低于期望，已保存最多的响应（${best.json.elements.length} elements, ${best.ep}）——数据可能不完整!`);
    return;
  }
  throw new Error(`查询 ${name} 在所有端点均失败`);
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.find(a => !a.startsWith('--'));
  const rounds = parseInt((args.find(a => a.startsWith('--rounds=')) || '').slice(9) || '1', 10);
  const names = Object.keys(QUERIES).filter(n => !only || n === only);
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) {
      console.log(`\n===== 第 ${round}/${rounds} 轮 =====`);
      await sleep(30000);
    }
    let allOk = true;
    for (const name of names) {
      const file = path.join(RAW_DIR, `${name}.json`);
      const min = MIN_ELEMENTS[name] ?? 0;
      if (!force && fs.existsSync(file)) {
        const n = JSON.parse(fs.readFileSync(file, 'utf8')).elements?.length ?? 0;
        if (n >= min) { console.log(`[skip] ${name} 已达标 (${n} elements)`); continue; }
      }
      allOk = false;
      try {
        await fetchOne(name, QUERIES[name].trim(), force && round === 1);
      } catch (e) {
        console.log(`[error] ${name}: ${e.message}`);
      }
      await sleep(3000);
    }
    if (allOk) { console.log('\n全部查询已达标'); return; }
  }
  console.log('\n达到最大轮次，未达标项见上方 [warn]');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
