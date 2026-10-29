// ui.js — 面板折叠、图例开关、线路搜索列表、站名自动补全
const { map, network, CATEGORIES } = window.__RAILMAP__;
import { highlightRoute, clearHighlight } from './map.js';

// ---- 面板折叠 ----
for (const head of document.querySelectorAll('.panel-head')) {
  head.onclick = () => head.parentElement.classList.toggle('collapsed');
}

// ---- 类别开关 ----
const catEl = document.getElementById('categories');
const catState = {}; // category -> bool(可见)
for (const [cat, def] of Object.entries(CATEGORIES)) {
  catState[cat] = true;
  const count = network.lines.filter(l => l.category === cat).length;
  if (!count) continue;
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML = `
    <span class="swatch" style="background:${def.colour || 'linear-gradient(90deg,#E4002B,#009FDF,#97D700)'}"></span>
    <span>${def.label}</span>
    <span class="count">${count} 线</span>`;
  row.onclick = () => {
    catState[cat] = !catState[cat];
    row.classList.toggle('off', !catState[cat]);
    applyFilters();
  };
  catEl.appendChild(row);
}

function applyFilters() {
  const visibleKeys = network.lines.filter(l => catState[l.category]).map(l => l.key);
  map.setFilter('lines-casing', ['in', ['get', 'key'], ['literal', visibleKeys]]);
  map.setFilter('lines-main', ['in', ['get', 'key'], ['literal', visibleKeys]]);
  // 站点：收集可见线路的站点 id（避免对 keysWrapped 做 like 匹配）
  const visibleIds = new Set();
  for (const l of network.lines) {
    if (catState[l.category]) for (const sid of l.stations) visibleIds.add(sid);
  }
  const idList = [...visibleIds];
  map.setFilter('stops-dot', ['all', ['!', ['get', 'transfer']], ['in', ['get', 'id'], ['literal', idList]]]);
  map.setFilter('stops-transfer', ['all', ['get', 'transfer'], ['in', ['get', 'id'], ['literal', idList]]]);
}

// ---- 线路列表（按城市分组 + 搜索） ----
const listEl = document.getElementById('line-list');
const searchEl = document.getElementById('line-search');
const CITY_ORDER = ['上海', '苏州', '无锡', '常州', '南通', '嘉兴'];

function lineLabel(l) {
  const net = l.network.replace(/地铁|轨道交通|有轨电车|市域铁路|市域轨道交通/g, '');
  return `${net} ${l.ref}`.trim();
}

function renderList(filter = '') {
  const lines = network.lines.filter(l =>
    !filter || l.name.includes(filter) || lineLabel(l).includes(filter) || l.ref.includes(filter));
  const byCity = new Map();
  for (const l of lines) {
    if (!byCity.has(l.city)) byCity.set(l.city, []);
    byCity.get(l.city).push(l);
  }
  const cities = [...byCity.keys()].sort((a, b) =>
    (CITY_ORDER.indexOf(a) + 1 || 99) - (CITY_ORDER.indexOf(b) + 1 || 99));
  let html = '';
  for (const city of cities) {
    html += `<div class="group-title">${city}</div>`;
    for (const l of byCity.get(city)) {
      html += `<div class="line-item" data-key="${l.key}">
        <span class="dot" style="background:${l.colour}"></span>
        <span class="name">${lineLabel(l)}</span></div>`;
    }
  }
  listEl.innerHTML = html || '<div class="group-title">无匹配线路</div>';
}
searchEl.oninput = () => renderList(searchEl.value.trim());
renderList();

// 点击线路：缩放到该线 + 高亮闪烁
let focusedKey = null;
listEl.onclick = e => {
  const item = e.target.closest('.line-item');
  if (!item) return;
  const key = item.dataset.key;
  const line = network.lines.find(l => l.key === key);
  if (!line) return;
  // 取消聚焦
  listEl.querySelectorAll('.line-item').forEach(x => x.classList.remove('focused'));
  if (focusedKey === key) { focusedKey = null; clearHighlight(); return; }
  focusedKey = key;
  item.classList.add('focused');
  // 高亮：该线站点连线
  const coords = line.stations
    .filter(sid => network.stations[sid])
    .map(sid => [network.stations[sid].lon, network.stations[sid].lat]);
  highlightRoute([{ coords, colour: line.colour }]);
  // 缩放到线路范围
  const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, duration: 800 });
};

// ---- 站名自动补全 ----
const datalist = document.getElementById('stations');
const seen = new Set();
for (const s of network.stations) {
  for (const n of s.names || []) {
    if (seen.has(n)) continue;
    seen.add(n);
    const opt = document.createElement('option');
    opt.value = n;
    datalist.appendChild(opt);
  }
}
