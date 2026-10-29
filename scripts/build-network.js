#!/usr/bin/env node
'use strict';
/* build-network.js — 从 data/raw/ 的 Overpass 响应构建 network.json + geojson
 * 用法: node scripts/build-network.js
 * 产出: data/dist/network.json, lines.geojson, stops.geojson
 */
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '..', 'data', 'raw');
const CURATED = path.join(__dirname, '..', 'data', 'curated');
const DIST = path.join(__dirname, '..', 'data', 'dist');

const load = name => JSON.parse(fs.readFileSync(path.join(RAW, `${name}.json`), 'utf8')).elements;

// ---- 目标城市的 network 标签（bbox 顺带抓到了杭州/南京/宁波等，需过滤） ----
// OSM network 标签 -> 城市与制式
const NETWORKS = {
  '上海地铁': { city: '上海', kind: 'metro' },
  'Shanghai Metro': { city: '上海', kind: 'metro' },
  '上海磁浮': { city: '上海', kind: 'maglev' },
  '上海市域铁路': { city: '上海', kind: 'regional' },
  '上海市域轨道交通': { city: '上海', kind: 'regional' },
  '金山铁路': { city: '上海', kind: 'regional' },
  '嘉善地铁': { city: '嘉兴', kind: 'regional' },
  '苏州轨道交通': { city: '苏州', kind: 'metro' },
  'Suzhou Rail Transit': { city: '苏州', kind: 'metro' },
  '苏州高新有轨电车': { city: '苏州', kind: 'tram' },
  '苏州高新区有轨电车': { city: '苏州', kind: 'tram' },
  '无锡地铁': { city: '无锡', kind: 'metro' },
  'Wuxi Metro': { city: '无锡', kind: 'metro' },
  '常州地铁': { city: '常州', kind: 'metro' },
  'Changzhou Metro': { city: '常州', kind: 'metro' },
  '南通轨道交通': { city: '南通', kind: 'metro' },
  '嘉兴有轨电车': { city: '嘉兴', kind: 'tram' },
  '松江有轨电车': { city: '上海', kind: 'tram' },
  '上海浦东机场旅客捷运系统': { city: '上海', kind: 'maglev' },
};

// ---- 工具 ----
const distM = (a, b) => {
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// 站名归一化：去括号、去后缀、去前缀、去空格，用于换乘合并
const normName = n => (n || '')
  .replace(/[（(].*?[)）]/g, '')
  .replace(/火车站$|高铁站$|火车东站$|火车南站$|火车北站$|站$/, '')
  .replace(/^高铁|^火车/, '') // "高铁苏州北" vs "苏州北"、"火车东站" vs "东"
  .replace(/[\s·・]/g, '')
  .trim();

(async () => {
  const metroEls = load('metro-relations');
  const specialEls = fs.existsSync(path.join(RAW, 'special-relations.json')) ? load('special-relations') : [];
  const railEls = fs.existsSync(path.join(RAW, 'rail-ways.json')) ? load('rail-ways') : [];
  const curated = JSON.parse(fs.readFileSync(path.join(CURATED, 'line-meta.json'), 'utf8'));

  // ============ 1. 地铁/电车线路 ============
  // 同一 ref 的双向 relation 合并，取 stop 数最多的那份作为代表
  const lineMap = new Map(); // key: network|ref -> {tags, stops[]}
  // stop 成员可能是 node（带 lat/lon）或 way 型站台（带 geometry，取中心点）
  const memberCenter = m => {
    if (m.lat != null) return { id: m.ref, lat: m.lat, lon: m.lon };
    if (Array.isArray(m.geometry) && m.geometry.length) {
      const lat = m.geometry.reduce((s, p) => s + p.lat, 0) / m.geometry.length;
      const lon = m.geometry.reduce((s, p) => s + p.lon, 0) / m.geometry.length;
      return { id: m.ref, lat, lon };
    }
    return null;
  };
  // way 成员尺寸启发式：站台是小面（<~200m），轨道是长线
  const isPlatformWay = m => {
    if (!Array.isArray(m.geometry) || m.geometry.length < 2) return false;
    const lats = m.geometry.map(p => p.lat), lons = m.geometry.map(p => p.lon);
    return Math.max(...lats) - Math.min(...lats) < 0.002 && Math.max(...lons) - Math.min(...lons) < 0.002;
  };
  // 提取站序：在多种标注风格中取数量最多的一组（避免 stop 只标了首末站时误用）
  // 1) PTv2: role=stop*  2) PTv2: role=platform*  3) PTv1: role='' 的 node
  // 4) 嘉兴电车风格: role='' 的闭合环 way（站台面）
  const extractStops = el => {
    const members = el.members || [];
    const isStopRole = m => m.type === 'node' && /^stop/.test(m.role);
    const isPlatformRole = m => m.type === 'node' && /^platform/.test(m.role);
    const ptv1Node = m => m.type === 'node' && m.role === '';
    const closedWay = m => {
      if (m.type !== 'way' || m.role !== '' || !Array.isArray(m.geometry) || m.geometry.length < 3) return false;
      const a = m.geometry[0], b = m.geometry[m.geometry.length - 1];
      return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
    };
    const groups = [
      members.filter(isStopRole),
      members.filter(isPlatformRole),
      members.filter(ptv1Node),
      members.filter(closedWay),
    ].filter(g => g.length >= 2);
    if (!groups.length) return [];
    const candidates = groups.reduce((a, b) => (b.length > a.length ? b : a));
    const stops = candidates.map(memberCenter).filter(Boolean);
    // 相邻去重：同一站的重复录入（<30m 视为同站）
    const dedup = [];
    for (const s of stops) {
      const prev = dedup[dedup.length - 1];
      if (prev && distM(prev, s) < 30) continue;
      dedup.push(s);
    }
    return dedup;
  };

  // 提取轨道几何：relation 里 role='' 的非闭合 way（轨道本体）。
  // 策略：先按 member 顺序串接（PTv2 的 way 成员按运行方向排列，绝大多数线路正确），
  // 断口过多时（如苏州电车 PTv1 乱序）回退到地理连续性贪心串接，取断口更少的方案。
  const extractTrack = el => {
    const ways = (el.members || []).filter(m =>
      m.type === 'way' && m.role === '' && Array.isArray(m.geometry) && m.geometry.length >= 2);
    const isClosed = g => {
      const a = g[0], b = g[g.length - 1];
      return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
    };
    const segs = ways.filter(w => !isClosed(w.geometry)).map(w => w.geometry);
    if (!segs.length) return [];

    const countGaps = (track, threshold) => {
      let gaps = 0;
      for (let i = 1; i < track.length; i++) if (distM(track[i - 1], track[i]) > threshold) gaps++;
      return gaps;
    };

    // 方案A：member 顺序串接（相邻段自动判向）
    const chainInOrder = () => {
      const track = [];
      for (const g of segs) {
        if (!track.length) { track.push(...g); continue; }
        const last = track[track.length - 1];
        if (distM(last, g[0]) <= distM(last, g[g.length - 1])) track.push(...g);
        else track.push(...[...g].reverse());
      }
      return track;
    };

    // 方案B：地理连续性贪心（从最长段向两端吸附 <500m 的段；起始段只归 tail，不重复）
    const greedyChain = () => {
      const segLen = g => g.reduce((s, p, i) => i ? s + distM(g[i - 1], p) : 0, 0);
      let startIdx = 0, startLen = 0;
      segs.forEach((s, i) => { const l = segLen(s); if (l > startLen) { startLen = l; startIdx = i; } });
      const used = new Set([startIdx]);
      const tailParts = [segs[startIdx]];
      const headParts = []; // 按加入顺序存放，每段已定向为「末点朝向当前链头」
      let headFront = segs[startIdx][0];
      let tailEnd = segs[startIdx][segs[startIdx].length - 1];
      for (;;) {
        let bestI = -1, bestD = Infinity, bestEnd = 0; // 0=接尾 1=接头
        for (let i = 0; i < segs.length; i++) {
          if (used.has(i)) continue;
          const s = segs[i];
          const dTail = Math.min(distM(tailEnd, s[0]), distM(tailEnd, s[s.length - 1]));
          const dHead = Math.min(distM(headFront, s[0]), distM(headFront, s[s.length - 1]));
          if (dTail < bestD) { bestD = dTail; bestI = i; bestEnd = 0; }
          if (dHead < bestD) { bestD = dHead; bestI = i; bestEnd = 1; }
        }
        if (bestI < 0 || bestD > 500) break;
        const s = segs[bestI];
        used.add(bestI);
        if (bestEnd === 0) {
          if (distM(tailEnd, s[0]) <= distM(tailEnd, s[s.length - 1])) { tailParts.push(s); tailEnd = s[s.length - 1]; }
          else { const r = [...s].reverse(); tailParts.push(r); tailEnd = r[r.length - 1]; }
        } else {
          if (distM(headFront, s[s.length - 1]) <= distM(headFront, s[0])) { headParts.push(s); headFront = s[0]; }
          else { const r = [...s].reverse(); headParts.push(r); headFront = r[0]; }
        }
      }
      return headParts.reverse().flat().concat(tailParts.flat());
    };

    const a = chainInOrder();
    const aGaps = countGaps(a, 500); // 500m 以上才算真断口（OSM 点间距约 100m，不能用小阈值）
    if (aGaps <= 3) return a; // member 顺序良好，直接用
    const b = greedyChain();
    const bGaps = countGaps(b, 500);
    return bGaps < aGaps ? b : a; // 真乱序（如苏州电车 PTv1）时贪心可能更优，取断口少者
  };
  for (const el of [...metroEls, ...specialEls]) {
    if (el.type !== 'relation') continue;
    const t = el.tags || {};
    let net = t.network || t['network:en'] || '';
    let meta = NETWORKS[net] || NETWORKS[t['network:en'] || ''];
    // network 标签缺失时的兜底：按 operator / name 关键词匹配
    if (!meta) {
      const hay = `${t.operator || ''} ${t.name || ''} ${t.ref || ''}`;
      if (/磁浮|Maglev/.test(hay)) meta = NETWORKS['上海磁浮'];
      else if (/常州地铁|Changzhou Metro/.test(hay)) meta = NETWORKS['常州地铁'];
      else if (/苏州高新[区]?有轨电车/.test(hay)) meta = NETWORKS['苏州高新区有轨电车'];
      else if (/嘉善|枫南/.test(hay)) meta = NETWORKS['嘉善地铁'];
    }
    if (!meta) continue; // 非目标城市
    const ref = t.ref || t.name;
    if (!ref) continue;
    // network 缺失时用兜底 network 名（与 NETWORKS 表键一致），避免 key 出现 "?|"
    if (!net && meta) {
      const fallbackNet = Object.keys(NETWORKS).find(k => NETWORKS[k] === meta && /磁浮|常州|高新|嘉善/.test(k));
      if (fallbackNet) net = fallbackNet;
    }
    let stops = extractStops(el);
    // 无 stop 成员的市域铁路（嘉善/枫南在建线）：用轨道端点作首末站
    if (stops.length < 2) {
      const track = extractTrack(el);
      if (track.length >= 2) {
        stops = [track[0], track[track.length - 1]].map((p, i) => ({ id: `end-${el.id}-${i}`, lat: p.lat, lon: p.lon }));
      }
    }
    if (stops.length < 2) continue;
    const track = extractTrack(el); // 真实轨道折线（可能为空，回退直线）
    const key = `${net || meta.fallbackNet || t.operator || '?'}|${ref}`;
    const prev = lineMap.get(key);
    if (!prev || stops.length > prev.stops.length) {
      lineMap.set(key, { tags: t, stops, meta, net, track });
    }
  }

  console.log(`[metro] 合并后线路数: ${lineMap.size}`);
  for (const [key, l] of lineMap) {
    console.log(`  ${key}  stops=${l.stops.length}  colour=${l.tags.colour || '-'}`);
  }

  // ============ 2. 国铁径道聚合 ============
  // way 按 name 聚合成"线路"；usage=main 的干线。类别由 curated/line-meta.json 人工映射。
  const railLines = new Map(); // name -> {ways: [], category}
  for (const el of railEls) {
    if (el.type !== 'way') continue;
    const t = el.tags || {};
    if (t.railway !== 'rail') continue;
    const name = t.name || t.ref;
    if (!name) continue; // 无名支线/联络线，一期跳过
    if (!railLines.has(name)) railLines.set(name, { ways: [], tags: t });
    railLines.get(name).ways.push(el);
  }
  console.log(`\n[rail] 国铁径道聚合: ${railLines.size} 条线路（按 name）`);
  const railNames = [...railLines.keys()];
  const known = railNames.filter(n => curated.railCategories?.[n]);
  const unknown = railNames.filter(n => !curated.railCategories?.[n]);
  console.log(`  已映射类别: ${known.length}  未映射: ${unknown.length}`);
  console.log('  未映射线路（需人工归类）:', unknown.slice(0, 40).join(' / '));

  // ============ 2.5 国铁接入路由图 ============
  // 站名/车站数据提前加载（国铁吸附与换乘识别都要用）
  const stationEls = fs.existsSync(path.join(RAW, 'stations.json')) ? load('stations') : [];
  const nameById = new Map();
  const stopNamesFile = path.join(RAW, 'stop-names.json');
  if (fs.existsSync(stopNamesFile)) {
    Object.entries(JSON.parse(fs.readFileSync(stopNamesFile, 'utf8'))).forEach(([id, name]) => nameById.set(Number(id), name));
  }
  for (const el of stationEls) {
    if (el.type === 'node' && el.tags?.name) nameById.set(el.id, el.tags.name);
    else if (el.type === 'way' && el.tags?.name && el.center) nameById.set(el.id, el.tags.name);
  }
  // 只接入已归类的主干线（跳过虹桥站股道/联络线等碎片），
  // 车站从 stations.json 吸附（railway=station 节点），沿径道折线投影排序得站序。
  const RAIL_MIN_WAYS = 3; // 主干线至少由 3 段 way 组成，过滤碎片
  const railStations = []; // {id, name, lat, lon}
  for (const el of stationEls) {
    const t = el.tags || {};
    if (!t.name) continue;
    const isRail = t.railway === 'station' && !t.station; // 国铁站（非 subway/tram 站）
    if (!isRail) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    railStations.push({ id: el.id, name: t.name, lat, lon });
  }
  console.log(`\n[rail] 国铁车站候选: ${railStations.length}`);

  // 点到折线的最短距离 + 投影位置（用于排序）
  function projectOnPolyline(pt, pts) {
    let best = { dist: Infinity, t: 0 };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ax = a.lon, ay = a.lat, bx = b.lon, by = b.lat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      let t = ((pt.lon - ax) * dx + (pt.lat - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const d = distM(pt, { lat: py, lon: px });
      if (d < best.dist) best = { dist: d, t: i - 1 + t };
    }
    return best;
  }

  const SNAP_M = 1500; // 车站吸附半径
  const railLineEntries = []; // {name, category, stations: [{id,name,lat,lon}]}
  for (const [name, rl] of railLines) {
    const category = curated.railCategories?.[name];
    if (!category) continue;
    if (rl.ways.length < RAIL_MIN_WAYS) continue;
    // 按地理连续性把 way 串成一条折线（贪心：从最长段开始，首尾吸附最近的下一段）。
    // 关键：国铁是上下行双线，两端渡线连成闭环——不加方向检查会把双线串成"去而复返"的链，
    // 站点投影落在返程段导致站序错乱。吸附时要求候选段定向后与链方向同向（点积>0）。
    const segs = rl.ways.filter(w => Array.isArray(w.geometry) && w.geometry.length >= 2).map(w => w.geometry);
    if (segs.length < 1) continue;
    const dirOf = (a, b) => { // 方向向量（经度按 cos(lat) 校正）
      const cl = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
      return [(b.lon - a.lon) * cl, b.lat - a.lat];
    };
    const segLen = g => g.reduce((s, p, i) => i ? s + distM(g[i - 1], p) : 0, 0);
    // 多链生长：每轮从剩余最长段开始串一条链（方向检查防双线闭环）。
    // 一条线可能断成多段物理径道（如新长线南延段与北段不相连），每段各自成链。
    const used = new Set();
    const chains = [];
    for (;;) {
      let startIdx = -1, startLen = 0;
      segs.forEach((s, i) => { if (used.has(i)) return; const l = segLen(s); if (l > startLen) { startLen = l; startIdx = i; } });
      if (startIdx < 0 || startLen < 200) break; // 剩余都是碎片
      used.add(startIdx);
      const tailParts = [segs[startIdx]], headParts = [];
      let hf = segs[startIdx][0], te = segs[startIdx][segs[startIdx].length - 1];
      // 端点行驶方向：沿折线取 ≥200m 基线，返回「在该端点处沿行进方向」的单位向量。
      // 端点最后两点间距常不足 1m（站场渡线节点），用末两点算方向会被噪声带偏成近垂直/近反向，
      // 导致正常延续段被误判为反向丢弃——这正是线路断头的成因。
      const dirAt = (pts, end, base = 200) => {
        const tail = end === 'tail';
        let i = tail ? pts.length - 1 : 0, acc = 0;
        while (tail ? i > 0 : i < pts.length - 1) {
          const j = tail ? i - 1 : i + 1;
          acc += distM(pts[i], pts[j]);
          i = j;
          if (acc >= base) break;
        }
        const a = tail ? pts[i] : pts[0];
        const b = tail ? pts[pts.length - 1] : pts[i];
        const d = dirOf(a, b);
        const n = Math.hypot(d[0], d[1]);
        return n > 0 ? [d[0] / n, d[1] / n] : null;
      };
      // 拼接判据 = 行进方向连续性：进入接点前的方向与离开接点后的方向应同向（点积>0）。
      // 反向段（对向车道回折，会串成"去而复返"的闭环）给高罚分降优先级，但任何情况下都不丢段——
      // 没有正向候选时仍接上，避免留下断头。
      const REVERSE_PENALTY = 1e6;
      for (;;) {
        // 方向基准取「最近接上的那一段」：接点就落在它的端点上。
        const lastTail = tailParts[tailParts.length - 1];
        const lastHead = headParts[headParts.length - 1] || segs[startIdx];
        const tailDir = dirAt(lastTail, 'tail'); // 抵达 te 的行进方向
        const headDir = dirAt(lastHead, 'head'); // 离开 hf 的行进方向
        let bestI = -1, bestD = Infinity, bestEnd = 0, bestScore = Infinity;
        for (let i = 0; i < segs.length; i++) {
          if (used.has(i)) continue;
          const s = segs[i];
          const flow = segLen(s) > 100;
          const dHead_c = flow ? dirAt(s, 'head') : null; // 离开 s[0] 的方向
          const dTail_c = flow ? dirAt(s, 'tail') : null; // 抵达 s[n-1] 的方向
          const neg = v => (v ? [-v[0], -v[1]] : null);
          const dTail = Math.min(distM(te, s[0]), distM(te, s[s.length - 1]));
          const dHead = Math.min(distM(hf, s[0]), distM(hf, s[s.length - 1]));
          for (const [dist, end] of [[dTail, 0], [dHead, 1]]) {
            if (dist > 500) continue; // 断链超过 500m 视为不连续
            const ref = end === 0 ? tailDir : headDir;
            // 接点落在候选段的首点还是尾点
            const atStart = end === 0 ? distM(te, s[0]) <= distM(te, s[s.length - 1])
                                      : distM(hf, s[0]) <= distM(hf, s[s.length - 1]);
            // 接尾：候选从接点出发 → 取接点处「离开」方向；接头：候选抵达接点 → 取接点处「抵达」方向
            const near = end === 0 ? (atStart ? dHead_c : neg(dTail_c))
                                   : (atStart ? neg(dHead_c) : dTail_c);
            const dot = ref && near ? ref[0] * near[0] + ref[1] * near[1] : 1;
            const score = dist + (dot < -0.5 ? REVERSE_PENALTY : 0); // 夹角 >120° 才算反向
            if (score < bestScore) { bestScore = score; bestD = dist; bestI = i; bestEnd = end; }
          }
        }
        // 500m 内只剩反向候选 = 已到本方向径道终点（前方是对向车道），本链到此为止；
        // 该段留着由后续轮次另起一条链，双线因此各成一条链（后续按 bbox 归组取代表链）。
        if (bestI < 0 || bestScore >= REVERSE_PENALTY) break;
        const s = segs[bestI];
        used.add(bestI);
        if (bestEnd === 0) {
          if (distM(te, s[0]) <= distM(te, s[s.length - 1])) { tailParts.push(s); te = s[s.length - 1]; }
          else { const r = [...s].reverse(); tailParts.push(r); te = r[r.length - 1]; }
        } else {
          if (distM(hf, s[s.length - 1]) <= distM(hf, s[0])) { headParts.push(s); hf = s[0]; }
          else { const r = [...s].reverse(); headParts.push(r); hf = r[0]; }
        }
      }
      chains.push(headParts.reverse().flat().concat(tailParts.flat()));
    }
    if (!chains.length) continue;
    // 几何包含所有链：双线平行链视觉重合无妨，延伸链正好补覆盖缺口
    // （如京沪高铁南京端短链、新长线南段链、宁启线扬州段链——只取最长链会丢这些区段）。
    // 链间插入 null 分隔，产出时拆成 MultiLineString。
    const chainLens = chains.map(c => {
      let l = 0;
      for (let i = 1; i < c.length; i++) l += distM(c[i - 1], c[i]);
      return l;
    });
    // 冗余短链剔除：站场股道/渡线常被同名 way 单独标出，串成几百米的短链，位置又正好压在
    // 主线链上——照原样输出会在图上留下孤立的小线段（如太仓站东侧 0.7km 联络线）。
    {
      const keep = [];
      const sample = c => { const s = []; for (let i = 0; i < c.length; i += 3) s.push(c[i]); return s; };
      const coveredLoosely = (c, other) => {
        const step = Math.max(1, Math.floor(other.length / 400));
        for (const p of sample(c)) {
          let bd = Infinity;
          for (let i = 0; i < other.length; i += step) { const d = distM(p, other[i]); if (d < bd) bd = d; }
          if (bd > 60) return false;
        }
        return true;
      };
      chains.forEach((c, i) => {
        if (chainLens[i] > 3000) { keep.push(i); return; }
        const host = chains.findIndex((o, j) => j !== i && chainLens[j] > chainLens[i] && coveredLoosely(c, o));
        if (host < 0) keep.push(i);
      });
      if (keep.length !== chains.length) {
        console.log(`  [rail] ${name}: 剔除压在主链上的冗余短链 ${chains.length - keep.length} 条`);
        const kept = keep.map(i => ({ c: chains[i], l: chainLens[i] }));
        chains.length = 0; chainLens.length = 0;
        kept.forEach(k => { chains.push(k.c); chainLens.push(k.l); });
      }
    }
    const allPts = [];
    chains.forEach((c, i) => { if (i) allPts.push(null); allPts.push(...c); });
    if (allPts.filter(p => p).length < 2) continue;
    // 吸附车站：投影到所有链，取距离 <SNAP_M 的。t 编码为 chainIdx*1e7 + 链内位置。
    // 双线平行链归组：bbox 高度重叠的链是同一段线路的上下行（视觉重合），
    // 归为一组取最长链作代表——否则站会交替投影到对向线，链排序后站序全乱。
    // 组间按空间衔接贪心排序（从西端开始，末端找最近的下一条链）。
    const snapped = [];
    const bboxOf = c => {
      let minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
      for (const p of c) { minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); }
      return [minLon, minLat, maxLon, maxLat];
    };
    const iou = (a, b) => {
      const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (iw <= 0 || ih <= 0) return 0;
      const inter = iw * ih;
      const areaA = (a[2] - a[0]) * (a[3] - a[1]), areaB = (b[2] - b[0]) * (b[3] - b[1]);
      return inter / (areaA + areaB - inter);
    };
    // 并查集归组
    const groupOf = chains.map((_, i) => i);
    const find = i => { while (groupOf[i] !== i) { groupOf[i] = groupOf[groupOf[i]]; i = groupOf[i]; } return i; };
    const bboxes = chains.map(bboxOf);
    for (let i = 0; i < chains.length; i++)
      for (let j = i + 1; j < chains.length; j++)
        if (iou(bboxes[i], bboxes[j]) > 0.55) { groupOf[find(i)] = find(j); }
    // 组 -> 代表链（最长）
    const groupReps = new Map(); // root -> chainIdx
    chains.forEach((c, i) => {
      const root = find(i);
      const cur = groupReps.get(root);
      if (cur == null || chainLens[i] > chainLens[cur]) groupReps.set(root, i);
    });
    const repChains = [...groupReps.values()]; // 代表链列表
    // 代表链衔接贪心排序：从最西端开始，末端找最近的其他代表链端点
    const orderReps = () => {
      const items = repChains.map(ci => ({ ci, head: chains[ci][0], tail: chains[ci][chains[ci].length - 1] }));
      let start = items[0], startLon = Infinity;
      for (const it of items) for (const p of [it.head, it.tail]) if (p.lon < startLon) { startLon = p.lon; start = it; }
      const seq = [{ item: start, reversed: false }];
      const used = new Set([start.ci]);
      let curEnd = start.tail;
      while (seq.length < items.length) {
        let best = null, bestD = Infinity, bestRev = false;
        for (const it of items) {
          if (used.has(it.ci)) continue;
          const dH = distM(curEnd, it.head), dT = distM(curEnd, it.tail);
          if (dH < bestD) { bestD = dH; best = it; bestRev = false; }
          if (dT < bestD) { bestD = dT; best = it; bestRev = true; }
        }
        if (!best) break;
        used.add(best.ci);
        seq.push({ item: best, reversed: bestRev });
        curEnd = bestRev ? best.head : best.tail;
      }
      return seq;
    };
    const repSeq = orderReps();
    const repRank = new Map(); // chainIdx(代表) -> rank
    const repReversed = new Map();
    repSeq.forEach((s, rank) => { repRank.set(s.item.ci, rank); repReversed.set(s.item.ci, s.reversed); });
    for (const st of railStations) {
      let best = null, bestRep = -1;
      for (const ci of repChains) {
        const proj = projectOnPolyline(st, chains[ci]);
        if (proj.dist <= SNAP_M && (!best || proj.dist < best.dist)) { best = proj; bestRep = ci; }
      }
      if (best) {
        const rank = repRank.get(bestRep);
        const tLen = chains[bestRep].length - 1;
        const tIn = repReversed.get(bestRep) ? (tLen - best.t) : best.t;
        snapped.push({ ...st, t: rank * 1e7 + tIn, chain: bestRep });
      }
    }
    if (snapped.length < 2) continue;
    // 按投影位置排序 + 相邻去重（同名站保留一个）
    snapped.sort((a, b) => a.t - b.t);
    const ordered = [];
    for (const s of snapped) {
      const prev = ordered[ordered.length - 1];
      if (prev && (prev.name === s.name || distM(prev, s) < 300)) continue;
      ordered.push(s);
    }
    // segments 用代表链（去双线重复，瘦身 network.json）；track 保留全链供渲染
    const repTrack = [];
    repSeq.forEach((s, i) => { if (i) repTrack.push(null); repTrack.push(...chains[s.item.ci]); });
    railLineEntries.push({ name, category, stations: ordered, track: allPts, repTrack, colour: curated.categoryColours?.[category] || '#666666' });
  }
  console.log(`[rail] 接入路由图的国铁线路: ${railLineEntries.length}`);
  for (const rle of railLineEntries) {
    console.log(`  ${rle.name} (${rle.category})  ${rle.stations.length} 站: ${rle.stations.map(s => s.name).slice(0, 8).join('→')}${rle.stations.length > 8 ? '…' : ''}`);
  }

  // ============ 3. 换乘识别 ============
  // 汇总所有站（地铁 stop 节点 + 国铁车站），按"归一化同名 且 ≤1.5km"合并为换乘组
  const allStops = []; // {nodeId, name, lat, lon, lineKey}
  for (const [key, l] of lineMap) {
    l.stops.forEach((s, i) => {
      allStops.push({ nodeId: s.id, idx: i, lineKey: key, lat: s.lat, lon: s.lon });
    });
  }
  // 国铁线路的车站也加入（lineKey 用线路名）
  for (const rle of railLineEntries) {
    rle.stations.forEach((s, i) => {
      allStops.push({ nodeId: s.id, idx: i, lineKey: `rail|${rle.name}`, lat: s.lat, lon: s.lon, railEntry: rle });
    });
  }
  // 站名：nameById 已在 2.5 节加载
  for (const s of allStops) {
    s.name = s.name || nameById.get(s.nodeId) || (s.railEntry ? s.nodeId : null);
  }
  // 国铁车站的 name 在 railStations 里已带，补上
  for (const s of allStops) {
    if (s.railEntry && !s.name) {
      const st = s.railEntry.stations.find(x => x.id === s.nodeId);
      s.name = st?.name || null;
    }
  }
  const named = allStops.filter(s => s.name).length;
  console.log(`\n[stops] 总站次 ${allStops.length}，有站名 ${named}（stations 数据${named > 0 ? '可用' : '缺失，站名待补'}）`);

  // 换乘组：并查集，按归一化同名+距离约束合并
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  for (const s of allStops) if (!parent.has(s.nodeId)) parent.set(s.nodeId, s.nodeId);
  // 按归一化名字分桶
  const byNorm = new Map();
  for (const s of allStops) {
    if (!s.name) continue;
    const n = normName(s.name);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(s);
  }
  const aliasMap = new Map((curated.aliases || []).map(([a, b]) => [normName(a), normName(b)]));
  // 同名合并距离上限：同名但相距 1.4km 的是两个不同车站（上海地铁14号线封浜站 vs
  // 铁路封浜站），1500m 会把地铁终点站并到 1.07km 外的铁路站上，线路末端就"断"在空地。
  // 站点数据里同名节点 96% 在 300m 内，600m 以上的同名对基本是异站。
  const MERGE_M = Number(process.env.MERGE_M || 800);
  let transferPairs = 0;
  for (const [n, group] of byNorm) {
    const target = aliasMap.get(n) || n;
    if (target !== n) {
      for (const s of byNorm.get(target) || []) group.push(s);
    }
    const gm = (a, b) => distM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
    const linked = group.filter(s => gm(group[0], s) <= MERGE_M);
    for (const s of linked.slice()) {
      for (const q of group) {
        if (linked.includes(q)) continue;
        if (gm(s, q) <= MERGE_M) linked.push(q);
      }
    }
    for (let i = 1; i < linked.length; i++) { union(group[0].nodeId, linked[i].nodeId); transferPairs++; }
  }
  console.log(`[transfer] 归一化合并 ${transferPairs} 对站（阈值 ${MERGE_M}m）`);

  // ============ 4. 产出 ============
  fs.mkdirSync(DIST, { recursive: true });

  // 4.0 站间切片：站点投影到轨道折线，切出每对相邻站之间的真实几何。
  // 返回 { fullCoords: [[lng,lat],...], segments: [ {fromIdx, toIdx, coords} ] }
  // 无轨道数据时回退直线连线。
  // track 可能含 null 分隔符（国铁多链：双线平行链 + 延伸链），null 处断开。
  const trimLog = []; // 端部裁剪记录，构建末尾汇总打印
  function sliceByStops(track, stopPoints, label) {
    const toLngLat = p => [p.lon, p.lat];
    if (!track || track.length < 2) {
      // 回退：直线
      const coords = stopPoints.map(toLngLat);
      const segments = [];
      for (let i = 1; i < coords.length; i++) {
        segments.push({ fromIdx: i - 1, toIdx: i, coords: [coords[i - 1], coords[i]] });
      }
      return { fullCoords: coords, segments };
    }
    // 把 track 按 null 拆成子链，记录每条子链在原 track 中的起止索引
    const splitChains = tk => {
      const out = []; // {pts, start}
      let cur = [], start = 0;
      tk.forEach((p, i) => {
        if (p === null) { if (cur.length) out.push({ pts: cur, start }); cur = []; start = i + 1; }
        else cur.push(p);
      });
      if (cur.length) out.push({ pts: cur, start });
      return out;
    };
    // 每个站投影到所有子链，取最近；t 映射回原 track 索引空间（子链内索引 + start）
    const projectAll = chains => stopPoints.map(p => {
      let best = { dist: Infinity, t: 0 };
      for (const sc of chains) {
        const proj = projectOnPolyline(p, sc.pts);
        if (proj.dist < best.dist) best = { dist: proj.dist, t: proj.t + sc.start };
      }
      return best;
    });
    const totalLenOf = pts => { let l = 0; for (let i = 1; i < pts.length; i++) l += distM(pts[i - 1], pts[i]); return l; };
    const pointAt = (pts, t) => {
      const i = Math.max(0, Math.min(pts.length - 2, Math.floor(t)));
      const f = t - i;
      return { lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * f, lon: pts[i].lon + (pts[i + 1].lon - pts[i].lon) * f };
    };
    const lenAt = (pts, t) => {
      const i = Math.max(0, Math.min(pts.length - 1, Math.floor(t)));
      let l = 0;
      for (let k = 1; k <= i; k++) l += distM(pts[k - 1], pts[k]);
      return i < pts.length - 1 ? l + distM(pts[i], pointAt(pts, t)) : l;
    };
    const sliceBetween = (pts, t0, t1) => {
      const out = [pointAt(pts, t0)];
      for (let i = Math.ceil(t0); i <= Math.floor(t1) && i < pts.length - 1; i++) out.push(pts[i]);
      out.push(pointAt(pts, t1));
      const cl = [out[0]];
      for (const p of out.slice(1)) {
        const q = cl[cl.length - 1];
        if (Math.abs(p.lat - q.lat) > 1e-12 || Math.abs(p.lon - q.lon) > 1e-12) cl.push(p);
      }
      return cl;
    };
    // ---- 端部裁剪：轨道越过终点站的悬空延伸 ----------------------------
    // OSM 常把站后存车线、在建延伸段、同名联络线并进主线 way，轨道会越过终点站再延伸
    // 几百米到几公里，画出来就是一根悬空的"断头"（沪宁沿江太仓站以东 4.68km 即此类：
    // 轨道死头在浏河一带，看着像该继续去上海，实际列车在太仓转沪苏通线）。
    // 判据：整条 track 上「全部车站投影」的最小/最大位置，两侧之外的轨道即为悬空延伸。
    // 用全部车站（不是首末站）定界，避免站序与轨道走向不一致时误切真线位
    // （沪春线站序 莘庄→上海南→新龙华→春申，而轨道自春申向上海南延伸）。
    // 保护：悬空 >TAIL_MAX_M 不裁 —— 更可能是车站数据本身缺失（南京南站在 bbox 外，
    // 京沪高铁北端 51km 真实径道无站可吸附），裁掉反而丢真实线位。
    const TAIL_MAX_M = 8000, TAIL_MIN_M = 300;
    const TAIL_MAX_FRAC = 0.1; // 裁剪量最多占全线 10%：比例过大说明该端不是"站外尾巴"，
    // 而是站序与线位不一致（沪春线莘庄在正中，春申吸附到并行子链上，按首站裁会切掉 42% 真线位）
    let subChains = splitChains(track);
    let projections = projectAll(subChains);
    const trim = { head: 0, tail: 0 };
    {
      // 投影 t 与子链 start 同处「扁平 track 索引空间」
      const locate = proj => {
        for (let i = subChains.length - 1; i >= 0; i--) {
          const sc = subChains[i];
          if (proj.t >= sc.start - 1e-9) return { i, local: Math.min(proj.t - sc.start, sc.pts.length - 1) };
        }
        return { i: 0, local: 0 };
      };
      const locs = projections.map(locate);
      const at = (l, edge) => (edge === 'h' ? l.local : -l.local);
      const firstLoc = locs.reduce((a, b) => (b.i < a.i || (b.i === a.i && at(b, 'h') < at(a, 'h')) ? b : a));
      const lastLoc = locs.reduce((a, b) => (b.i > a.i || (b.i === a.i && at(b, 't') < at(a, 't')) ? b : a));
      const overhang = (loc, kind) => {
        const pts = subChains[loc.i].pts;
        return kind === 'h' ? lenAt(pts, loc.local) : totalLenOf(pts) - lenAt(pts, loc.local);
      };
      // 待裁区域若逼近别的子链，它就是「与主线相连的接线」而非站外尾巴：
      // 沪春线子链1 由春申向莘庄方向接回子链0（接缝仅 62m），尾端裁掉会断开真线位。
      const reconnects = (loc, kind) => {
        const pts = subChains[loc.i].pts;
        const from = kind === 'h' ? 0 : Math.ceil(loc.local);
        const to = kind === 'h' ? Math.floor(loc.local) : pts.length - 1;
        for (const [j, sc] of subChains.entries()) {
          if (j === loc.i) continue;
          for (let k = from; k <= to; k += 3) {
            for (let m = 0; m < sc.pts.length; m += 3) {
              if (distM(pts[k], sc.pts[m]) < 300) return true;
            }
          }
        }
        return false;
      };
      const cuts = new Map(); // 子链索引 -> {h, t} 链内位置
      const totalAll = subChains.reduce((s, sc) => s + totalLenOf(sc.pts), 0);
      const cutLimit = Math.min(TAIL_MAX_M, totalAll * TAIL_MAX_FRAC);
      const headCut = overhang(firstLoc, 'h');
      if (headCut >= TAIL_MIN_M && headCut <= cutLimit && !reconnects(firstLoc, 'h')) {
        cuts.set(firstLoc.i, { h: firstLoc.local, t: Infinity });
        trim.head = headCut;
      } else if (headCut > TAIL_MIN_M && label) {
        const why = headCut > cutLimit ? `> 阈值 ${(cutLimit / 1000).toFixed(2)}km` : '与其它子链相连（真线位）';
        trimLog.push(`[跳过] ${label}: 首端悬空 ${(headCut / 1000).toFixed(2)}km ${why}，保留原线位`);
      }
      const tailCut = overhang(lastLoc, 't');
      if (tailCut >= TAIL_MIN_M && tailCut <= cutLimit && !reconnects(lastLoc, 't')) {
        const cur = cuts.get(lastLoc.i) || { h: 0, t: Infinity };
        cur.t = Math.min(cur.t, lastLoc.local);
        cuts.set(lastLoc.i, cur);
        trim.tail = tailCut;
      } else if (tailCut > TAIL_MIN_M && label) {
        const why = tailCut > cutLimit ? `> 阈值 ${(cutLimit / 1000).toFixed(2)}km` : '与其它子链相连（真线位）';
        trimLog.push(`[跳过] ${label}: 尾端悬空 ${(tailCut / 1000).toFixed(2)}km ${why}，保留原线位`);
      }
      if (trim.head || trim.tail) {
        const parts = subChains.map((sc, i) => {
          const c = cuts.get(i);
          if (!c) return sc.pts;
          const lo = c.h || 0;
          const hi = c.t === Infinity ? sc.pts.length - 1 : c.t;
          return sliceBetween(sc.pts, lo, hi);
        }).filter(p => p.length >= 2);
        const flat = [];
        parts.forEach((pts, i) => { if (i) flat.push(null); flat.push(...pts); });
        if (flat.length >= 2 && parts.reduce((s, p) => s + totalLenOf(p), 0) > 0) {
          track = flat;
          subChains = splitChains(track);
          projections = projectAll(subChains);
          if (label) {
            trimLog.push(`${label}: 收口站外悬空轨道${trim.head ? ` 首端 ${(trim.head / 1000).toFixed(2)}km` : ''}${trim.tail ? ` 尾端 ${(trim.tail / 1000).toFixed(2)}km` : ''}`);
          }
        } else { trim.head = trim.tail = 0; }
      }
    }
    // 按 t 排序站点顺序可能已定（站序），但投影可能乱（环线/共线）——直接用给定站序切
    const cutAt = (t) => {
      const i = Math.floor(t);
      const frac = t - i;
      if (i >= track.length - 1) return track[track.length - 1];
      const a = track[i], b = track[i + 1];
      if (!a || !b) return a || b; // 落在 null 分隔上，取最近端点
      return { lat: a.lat + (b.lat - a.lat) * frac, lon: a.lon + (b.lon - a.lon) * frac };
    };
    const segments = [];
    for (let i = 1; i < projections.length; i++) {
      const t0 = projections[i - 1].t, t1 = projections[i].t;
      const [lo, hi] = t0 <= t1 ? [t0, t1] : [t1, t0];
      const pts = [];
      pts.push(cutAt(lo));
      for (let k = Math.floor(lo) + 1; k <= Math.floor(hi); k++) {
        if (k < track.length && track[k] !== null) pts.push(track[k]);
      }
      pts.push(cutAt(hi));
      // 去重相邻重复点
      const clean = [pts[0]];
      for (const p of pts.slice(1)) {
        const prev = clean[clean.length - 1];
        if (Math.abs(prev.lat - p.lat) < 1e-9 && Math.abs(prev.lon - p.lon) < 1e-9) continue;
        clean.push(p);
      }
      // 断口处理：只有 >12km 的巨洞（画直线会横穿地图、明显错误）才断开成多段。
      // 500m~12km 的缺口是 OSM 常见数据洞（地铁每线 5-28 个、国铁 2-9km），直接直线桥接，
      // 沿线路走廊视觉无感。coords 统一为嵌套数组 [[[lng,lat],...], ...]，
      // 前端 router.js 把它当作 MultiLineString 坐标处理。
      const parts = [];
      let cur = [toLngLat(clean[0])];
      for (let j = 1; j < clean.length; j++) {
        if (distM(clean[j - 1], clean[j]) > 12000) {
          if (cur.length >= 2) parts.push(cur);
          cur = [toLngLat(clean[j])];
        } else cur.push(toLngLat(clean[j]));
      }
      if (cur.length >= 2) parts.push(cur);
      const coords = parts.length ? parts : [[toLngLat(clean[0]), toLngLat(clean[clean.length - 1])]];
      segments.push({ fromIdx: i - 1, toIdx: i, coords });
    }
    // fullCoords：按 null 分组输出（多链 = MultiLineString），组内 >12km 巨洞再拆
    const groups = [];
    let g = [];
    for (const p of track) {
      if (p === null) { if (g.length) groups.push(g); g = []; }
      else g.push(toLngLat(p));
    }
    if (g.length) groups.push(g);
    let fullCoords;
    if (groups.length === 1) fullCoords = splitGaps(groups[0]);
    else {
      // 多链：每条链内部再拆巨洞，输出 MultiLineString
      const partsAll = [];
      for (const gr of groups) {
        const r = splitGaps(gr);
        if (typeof r[0][0] === 'number') partsAll.push(r);
        else r.forEach(x => partsAll.push(x));
      }
      fullCoords = partsAll;
    }
    return { fullCoords, segments };
  }
  // 断口拆分：仅 >12km 巨洞断开（真缺数据），其余缺口直线桥接。返回 LineString 或 MultiLineString 坐标
  function splitGaps(coords) {
    const parts = [];
    let cur = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const a = { lat: coords[i - 1][1], lon: coords[i - 1][0] };
      const b = { lat: coords[i][1], lon: coords[i][0] };
      if (distM(a, b) > 12000) {
        if (cur.length >= 2) parts.push(cur);
        cur = [coords[i]];
      } else cur.push(coords[i]);
    }
    if (cur.length >= 2) parts.push(cur);
    if (parts.length <= 1) return parts[0] || coords;
    return parts; // MultiLineString
  }

  // 4.1 站点：换乘组 -> 单一站点（取组内均值坐标）
  const groups = new Map();
  for (const s of allStops) {
    const root = find(s.nodeId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  }
  const stations = [];
  const stationIdByRoot = new Map();
  for (const [root, members] of groups) {
    const id = stations.length;
    stationIdByRoot.set(root, id);
    // 组内取「中位点」（到其它成员距离和最小者），再只对中位点 400m 内的成员取均值：
    // 同名站常有相距很远的异站/异城同名节点（"人民广场" 15 个节点横跨 164km），
    // 全组求平均会把标记拽到两站中间的空地（上海地铁14号线封浜被拽偏 1.07km，
    // 于是线路末端看起来"断头"）。400m 内的多线同名节点仍会平滑合并成换乘标记。
    const dm = (a, b) => distM({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
    let best = members[0], bestSum = Infinity;
    for (const a of members) {
      let sum = 0;
      for (const b of members) sum += dm(a, b);
      if (sum < bestSum) { bestSum = sum; best = a; }
    }
    const near = members.filter(m => dm(best, m) <= 400);
    const lat = near.reduce((x, s) => x + s.lat, 0) / near.length;
    const lon = near.reduce((x, s) => x + s.lon, 0) / near.length;
    const names = [...new Set(members.map(s => s.name).filter(Boolean))];
    const lines = [...new Set(members.map(s => s.lineKey))];
    stations.push({ id, names, lat, lon, lines });
  }
  // 4.2 线路与边（地铁 + 国铁统一处理）
  const lines = [];
  const edges = [];
  const lineGeoms = new Map(); // lineId -> {fullCoords, segments}
  for (const [key, l] of lineMap) {
    const lineId = lines.length;
    const [net, ref] = key.split('|');
    const stationIds = l.stops.map(s => stationIdByRoot.get(find(s.id)));
    lines.push({
      id: lineId, key, network: net, ref,
      name: l.tags.name || ref,
      category: l.meta.kind,
      city: l.meta.city,
      colour: l.tags.colour || curated.categoryColours?.[l.meta.kind] || '#666666',
      stations: stationIds,
    });
    lineGeoms.set(lineId, sliceByStops(l.track, l.stops, key));
    for (let i = 1; i < stationIds.length; i++) {
      const a = stations[stationIds[i - 1]], b = stations[stationIds[i]];
      if (!a || !b) continue;
      edges.push({
        from: a.id, to: b.id, lineId,
        distM: Math.round(distM(a, b)),
      });
    }
  }
  // 国铁线路
  for (const rle of railLineEntries) {
    const lineId = lines.length;
    const stationIds = rle.stations.map(s => stationIdByRoot.get(find(s.id))).filter(Boolean);
    if (new Set(stationIds).size < 2) continue; // 合并后不足两站，无意义
    lines.push({
      id: lineId, key: `rail|${rle.name}`, network: '国铁', ref: rle.name,
      name: rle.name,
      category: rle.category,
      city: '多市',
      colour: rle.colour,
      stations: stationIds,
    });
    lineGeoms.set(lineId, sliceByStops(rle.repTrack || rle.track, rle.stations, `rail|${rle.name}`));
    for (let i = 1; i < stationIds.length; i++) {
      const a = stations[stationIds[i - 1]], b = stations[stationIds[i]];
      if (!a || !b) continue;
      edges.push({
        from: a.id, to: b.id, lineId,
        distM: Math.round(distM(a, b)),
      });
    }
  }
  // 4.3 geojson（真实轨道走向，断口处自动断开）
  const linesGeo = {
    type: 'FeatureCollection',
    features: lines.map(l => {
      const geom = lineGeoms.get(l.id);
      const fallback = l.stations.filter(sid => stations[sid]).map(sid => [stations[sid].lon, stations[sid].lat]);
      let coordinates, type;
      if (geom?.fullCoords?.length >= 2) {
        const fc = geom.fullCoords;
        if (typeof fc[0][0] === 'number') { type = 'LineString'; coordinates = fc; }
        else { type = 'MultiLineString'; coordinates = fc; }
      } else {
        type = 'LineString'; coordinates = fallback;
      }
      return {
        type: 'Feature',
        properties: { lineId: l.id, key: l.key, name: l.name, category: l.category, colour: l.colour, city: l.city },
        geometry: { type, coordinates },
      };
    }),
  };
  const stopsGeo = {
    type: 'FeatureCollection',
    features: stations.map(s => {
      const firstLine = lineMap.get(s.lines[0]);
      const cats = [...new Set(s.lines.map(k => lineMap.get(k)?.meta.kind || 'metro'))];
      return {
        type: 'Feature',
        properties: {
          id: s.id,
          names: JSON.stringify(s.names),
          lines: JSON.stringify(s.lines),
          cats: cats.join(','),
          keysWrapped: `|${s.lines.join('|')}|`,
          colour: firstLine?.tags.colour || '#666666',
          transfer: s.lines.length > 1,
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      };
    }),
  };
  const network = {
    meta: { generatedAt: new Date().toISOString(), stations: stations.length, lines: lines.length, edges: edges.length },
    stations, lines, edges,
    // 站间真实几何：lineId -> [ {fromIdx, toIdx, coords} ]（fromIdx/toIdx 是 line.stations 的索引）
    segments: Object.fromEntries([...lineGeoms.entries()].map(([id, g]) => [id, g.segments])),
  };
  fs.writeFileSync(path.join(DIST, 'network.json'), JSON.stringify(network));
  fs.writeFileSync(path.join(DIST, 'lines.geojson'), JSON.stringify(linesGeo));
  fs.writeFileSync(path.join(DIST, 'stops.geojson'), JSON.stringify(stopsGeo));
  // 真实线位统计：MultiLineString 数总点数（段数少不代表没真实几何）
  const withTrack = [...lineGeoms.values()].filter(g => {
    const fc = g.fullCoords;
    if (!Array.isArray(fc) || !fc.length) return false;
    const pts = typeof fc[0][0] === 'number' ? fc.length : fc.reduce((s, p) => s + p.length, 0);
    return pts > 10;
  }).length;
  console.log(`\n[done] stations=${stations.length} lines=${lines.length} edges=${edges.length} 真实线位线路=${withTrack}/${lines.length}`);
  if (trimLog.length) {
    const skipped = trimLog.filter(s => s.startsWith('[跳过]'));
    const applied = trimLog.filter(s => !s.startsWith('[跳过]'));
    console.log(`  [trim] 端部裁剪 ${applied.length} 条（站外悬空轨道已收口），跳过 ${skipped.length} 条:`);
    applied.slice(0, 22).forEach(s => console.log(`    ${s}`));
    if (applied.length > 22) console.log(`    … 另 ${applied.length - 22} 条`);
    skipped.forEach(s => console.log(`    ${s}`));
  }
  console.log(`  -> data/dist/network.json, lines.geojson, stops.geojson`);
})();
