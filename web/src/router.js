// router.js — Dijkstra 路径规划 + 行程渲染 + 地图高亮
import mapboxgl from 'mapbox-gl';
import { highlightRoute, clearHighlight } from './map.js';
const { map, network } = window.__RAILMAP__;

// 类别商业旅速（km/h，含停站）—— 2026-10 用真实运营时刻校准：
// 高铁 250→160（虹桥→苏州北模型 17min vs 真实 27min，-36%）；城际 160→110（-30%）；
// 国铁 90→65（-25%）；市域 120→95（金山铁路 -18%）；磁浮 200→225（8min/30km）。
// 均速是“含停站的全行程均速”，不是设计速度。
const SPEED = {
  highspeed: 160, intercity: 110, national: 65,
  regional: 95, metro: 44, tram: 25, maglev: 225,
};
// 线路级覆盖：地铁类别里的快线/市域铁路旅速显著高于普通地铁（站距大）。
// 杭州16号线 54（35km/36min）、杭海城际 66（44km/40min）、上海16号线 68（55km/45min）、
// 上海17号线 65（39km/33min）、机场联络线 75（51km/40min）。
const LINE_SPEED = {
  '杭州地铁|16': 54, '杭州地铁|杭海城际': 66,
  '上海地铁|16': 68, '上海地铁|17': 65,
  '上海市域铁路|市域机场线': 75,
};
const TRANSFER_MIN = {
  metro_metro: 5, any_metro: 8, national_any: 15, default: 8,
};

// 构图：节点 = (station, line) 状态；边 = 乘车 + 换乘
// 用邻接表：nodeKey = `${stationId}:${lineId}`
const adj = new Map(); // nodeKey -> [{to, lineId, kind, costMin, distM}]
const nodeIndex = new Map(); // nodeKey -> idx
let idxCounter = 0;

function ensureNode(key) {
  if (!nodeIndex.has(key)) nodeIndex.set(key, idxCounter++);
  return nodeIndex.get(key);
}

for (const e of network.edges) {
  const line = network.lines[e.lineId];
  if (!line) continue;
  const speed = LINE_SPEED[line.key] || SPEED[line.category] || 44;
  const costMin = (e.distM / 1000) / speed * 60;
  const a = `${e.from}:${e.lineId}`;
  const b = `${e.to}:${e.lineId}`;
  ensureNode(a); ensureNode(b);
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push({ to: b, lineId: e.lineId, kind: 'ride', costMin, distM: e.distM });
  adj.get(b).push({ to: a, lineId: e.lineId, kind: 'ride', costMin, distM: e.distM });
}
// 换乘边：同站不同线
const linesByStation = new Map();
for (const line of network.lines) {
  for (const sid of line.stations) {
    if (!linesByStation.has(sid)) linesByStation.set(sid, []);
    linesByStation.get(sid).push(line.id);
  }
}
for (const [sid, lineIds] of linesByStation) {
  for (const la of lineIds) {
    for (const lb of lineIds) {
      if (la === lb) continue;
      const catA = network.lines[la].category;
      const catB = network.lines[lb].category;
      let cost = TRANSFER_MIN.default;
      if (catA === 'metro' && catB === 'metro') cost = TRANSFER_MIN.metro_metro;
      else if (catA === 'metro' || catB === 'metro') cost = TRANSFER_MIN.any_metro;
      if (catA === 'national' || catB === 'national' || catA === 'highspeed' || catB === 'highspeed') cost = TRANSFER_MIN.national_any;
      const a = `${sid}:${la}`, b = `${sid}:${lb}`;
      ensureNode(a); ensureNode(b);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ to: b, lineId: lb, kind: 'transfer', costMin: cost, distM: 0 });
    }
  }
}

// 站名 -> stationId（模糊匹配）
function findStation(name) {
  const q = (name || '').trim();
  if (!q) return null;
  // 精确
  for (const s of network.stations) {
    if ((s.names || []).includes(q)) return s.id;
  }
  // 归一化后精确（去"站"后缀）
  const norm = x => x.replace(/火车站$|高铁站$|站$/, '');
  for (const s of network.stations) {
    if ((s.names || []).some(n => norm(n) === norm(q))) return s.id;
  }
  // 包含匹配
  const hits = network.stations.filter(s => (s.names || []).some(n => n.includes(q) || q.includes(n)));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) return hits.sort((a, b) => (a.names[0] || '').length - (b.names[0] || '').length)[0].id;
  return null;
}

// Dijkstra：从起点站的所有线路状态出发
function plan(fromId, toId) {
  const dist = new Array(idxCounter).fill(Infinity);
  const prev = new Array(idxCounter).fill(null);
  // 简单二叉堆
  const heap = [];
  const push = (d, k) => { heap.push([d, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };

  const startKeys = (linesByStation.get(fromId) || []).map(l => `${fromId}:${l}`);
  const endSet = new Set((linesByStation.get(toId) || []).map(l => `${toId}:${l}`));
  for (const k of startKeys) { const i = nodeIndex.get(k); dist[i] = 0; push(0, i); }
  let endIdx = null;
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const key = [...nodeIndex.entries()].find(([, v]) => v === i)?.[0];
    if (endSet.has(key)) { endIdx = i; break; }
    for (const edge of adj.get(key) || []) {
      const j = nodeIndex.get(edge.to);
      if (d + edge.costMin < dist[j]) {
        dist[j] = d + edge.costMin;
        prev[j] = { from: i, edge };
        push(dist[j], j);
      }
    }
  }
  if (endIdx == null) return null;
  // 回溯
  const steps = [];
  let cur = endIdx;
  while (prev[cur]) {
    const { from, edge } = prev[cur];
    steps.unshift({ edge, fromKey: [...nodeIndex.entries()].find(([, v]) => v === from)?.[0], toKey: [...nodeIndex.entries()].find(([, v]) => v === cur)?.[0] });
    cur = from;
  }
  return { steps, totalMin: dist[endIdx] };
}

// ---- UI 绑定 ----
const fromInput = document.getElementById('from');
const toInput = document.getElementById('to');
const planBtn = document.getElementById('plan-btn');
const resultEl = document.getElementById('result');

// 交换起终点
document.getElementById('swap-btn').onclick = () => {
  [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
  if (fromInput.value && toInput.value) planBtn.click();
};

// 起终点标记
let markers = [];
function setEndpoints(fromId, toId) {
  for (const m of markers) m.remove();
  markers = [];
  for (const [sid, label, colour] of [[fromId, '起', '#1a73e8'], [toId, '终', '#e5543b']]) {
    if (sid == null) continue;
    const s = network.stations[sid];
    const el = document.createElement('div');
    el.className = 'endpoint-marker';
    el.style.background = colour;
    el.innerHTML = `<span>${label}</span>`;
    markers.push(new mapboxgl.Marker({ element: el })
      .setLngLat([s.lon, s.lat])
      .addTo(map));
  }
}

// 清除路线：高亮、标记、结果面板
const clearBtn = document.getElementById('clear-btn');
clearBtn.onclick = () => {
  clearHighlight();
  for (const m of markers) m.remove();
  markers = [];
  resultEl.innerHTML = '';
  fromInput.value = '';
  toInput.value = '';
};

planBtn.onclick = () => {
  const fromId = findStation(fromInput.value);
  const toId = findStation(toInput.value);
  if (fromId == null || toId == null) {
    resultEl.innerHTML = `<div class="error">找不到站点：${fromId == null ? fromInput.value : ''}${toId == null ? ' ' + toInput.value : ''}</div>`;
    return;
  }
  const r = plan(fromId, toId);
  if (!r) { resultEl.innerHTML = '<div class="error">无可达路径</div>'; return; }
  setEndpoints(fromId, toId);
  renderTrip(r);
};

function renderTrip(r) {
  // 按乘车段聚合
  const segs = [];
  for (const step of r.steps) {
    const { edge } = step;
    const line = network.lines[edge.lineId];
    const fromSid = Number(step.fromKey.split(':')[0]);
    const toSid = Number(step.toKey.split(':')[0]);
    if (edge.kind === 'ride' && segs.length && segs[segs.length - 1].lineId === edge.lineId) {
      segs[segs.length - 1].to = toSid;
      segs[segs.length - 1].distM += edge.distM;
      segs[segs.length - 1].costMin += edge.costMin;
    } else if (edge.kind === 'ride') {
      segs.push({ kind: 'ride', lineId: edge.lineId, from: fromSid, to: toSid, distM: edge.distM, costMin: edge.costMin });
    } else {
      segs.push({ kind: 'transfer', at: fromSid, toLineId: edge.lineId, costMin: edge.costMin });
    }
  }
  // 地图高亮：每段沿真实线位切片（network.segments），无数据回退站点连线
  const hlSegs = [];
  for (const seg of segs) {
    if (seg.kind !== 'ride') continue;
    const line = network.lines[seg.lineId];
    const lineSegs = network.segments?.[seg.lineId] || [];
    const idx = line.stations.indexOf(seg.from);
    const idxTo = line.stations.indexOf(seg.to);
    if (idx >= 0 && idxTo >= 0 && lineSegs.length) {
      // 站间切片：fromIdx/toIdx 是 line.stations 的索引
      const [lo, hi] = idx < idxTo ? [idx, idxTo] : [idxTo, idx];
      const slice = lineSegs.filter(s => s.fromIdx >= lo && s.toIdx <= hi);
      if (slice.length) {
        // coords 统一为 MultiLineString 形状（[[lng,lat][][]），断口拆分的段自然成多段
        const coords = idx < idxTo
          ? slice.flatMap(s => s.coords)
          : slice.slice().reverse().flatMap(s => s.coords.map(part => part.slice().reverse()));
        if (coords.every(part => part.length >= 2)) {
          hlSegs.push({ coords, colour: line.colour, multi: true });
          continue;
        }
      }
    }
    // 回退：站点连线
    hlSegs.push({
      coords: [seg.from, seg.to].filter(sid => network.stations[sid]).map(sid => [network.stations[sid].lon, network.stations[sid].lat]),
      colour: line.colour,
    });
  }
  highlightRoute(hlSegs);
  // 缩放到路径范围（hlSegs 同时含 LineString 与 MultiLineString 两种形状）
  const allCoords = hlSegs.flat(s => (s.multi ? s.coords.flat() : s.coords));
  if (allCoords.length > 1 && allCoords.every(c => Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
    const lons = allCoords.map(c => c[0]), lats = allCoords.map(c => c[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, duration: 800 });
  }

  let html = '';
  let transfers = 0;
  for (const seg of segs) {
    if (seg.kind === 'ride') {
      const line = network.lines[seg.lineId];
      const from = network.stations[seg.from];
      const to = network.stations[seg.to];
      html += `<div class="seg"><span class="bar" style="background:${line.colour}"></span>
        <span><b>${line.network.replace(/地铁|轨道交通|有轨电车/g, '')} ${line.ref}</b><br/>
        ${from?.names?.[0] || '?'} → ${to?.names?.[0] || '?'}<br/>
        <span style="color:#888">${(seg.distM / 1000).toFixed(1)}km · 约${Math.round(seg.costMin)}分钟</span></span></div>`;
    } else {
      transfers++;
      const at = network.stations[seg.at];
      html += `<div class="transfer">↻ 在 ${at?.names?.[0] || '?'} 换乘（约${Math.round(seg.costMin)}分钟）</div>`;
    }
  }
  const totalMin = Math.round(r.totalMin);
  html += `<div class="total">总计约 ${Math.floor(totalMin / 60)} 小时 ${totalMin % 60} 分钟 · 换乘 ${transfers} 次</div>
    <div class="note">※ 时间为按类别均速估算，非时刻表</div>`;
  resultEl.innerHTML = html;
}
