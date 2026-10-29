// main.js — 入口：加载数据、初始化地图与 UI
import mapboxgl from 'mapbox-gl';

const TOKEN_KEY = 'RAILMAP_MAPBOX_TOKEN';

function getToken() {
  // 优先 URL 参数 ?token=，其次 localStorage，最后 import.meta.env
  const url = new URL(location.href);
  return url.searchParams.get('token')
    || localStorage.getItem(TOKEN_KEY)
    || import.meta.env.VITE_MAPBOX_TOKEN
    || '';
}

const token = getToken();
if (!token) {
  // 无 token 时显示输入页（prompt 在部分环境不可用）
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;font-family:sans-serif;background:#f7f7f5;">
      <h2 style="font-size:18px;">长三角轨道交通图</h2>
      <p style="font-size:13px;color:#666;">需要 Mapbox Public Token（仅用于加载底图，保存在本地）</p>
      <input id="token-input" placeholder="pk.eyJ..." style="padding:8px 12px;width:320px;border:1px solid #ccc;border-radius:8px;font-size:13px;" />
      <button id="token-save" style="padding:8px 24px;background:#1a73e8;color:#fff;border:none;border-radius:8px;cursor:pointer;">保存并加载</button>
      <a href="https://account.mapbox.com/access-tokens/" target="_blank" style="font-size:12px;color:#1a73e8;">如何获取 Token？</a>
    </div>`;
  document.getElementById('token-save').onclick = () => {
    const t = document.getElementById('token-input').value.trim();
    if (t) { localStorage.setItem(TOKEN_KEY, t); location.reload(); }
  };
  throw new Error('等待 token 输入');
}

mapboxgl.accessToken = token;

// 数据目录：用 Vite 注入的 BASE_URL（本项目配为 './'）拼相对路径。
// 原实现硬编码绝对路径 '/data'，在 GitHub Pages 的子路径站点
// （https://<user>.github.io/railmap/）下会解析成 /data/... 而 404，
// 表现为页面全白。相对路径由 fetch 基于文档地址解析，本地与子路径部署都能命中。
const DATA = import.meta.env.VITE_DATA_URL || `${import.meta.env.BASE_URL}data`;
async function loadJSON(name) {
  const url = `${DATA}/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}  (${url})`);
  return res.json();
}

// 启动期任何未捕获错误都在页面上写明原因，不留白屏
window.addEventListener('error', e => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', e => showFatal(e.reason));
function showFatal(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  if (document.getElementById('fatal')) return;
  const el = document.createElement('div');
  el.id = 'fatal';
  el.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff;padding:24px;overflow:auto;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;';
  el.textContent = `加载失败\n\n${msg}\n\n数据目录: ${DATA}`;
  document.body.appendChild(el);
}

const [network, linesGeo, stopsGeo] = await Promise.all([
  loadJSON('network.json'),
  loadJSON('lines.geojson'),
  loadJSON('stops.geojson'),
]);

console.log(`数据: ${network.meta.stations} 站 / ${network.meta.lines} 线 / ${network.meta.edges} 边`);

// ---- 类别定义（与 build-network.js 的 category 对应） ----
export const CATEGORIES = {
  highspeed: { label: '高铁', width: 4, colour: '#E4002B' },
  intercity: { label: '城际', width: 3, colour: '#F39800' },
  national:  { label: '国铁', width: 3, colour: '#8B7355' },
  regional:  { label: '市域', width: 3, colour: '#00838F' },
  metro:     { label: '地铁', width: 2.5, colour: null }, // 用线路官方色
  tram:      { label: '电车', width: 1.5, colour: '#7CB342', dash: [2, 2] },
  maglev:    { label: '磁浮', width: 2.5, colour: '#9C27B0' },
};

// ---- 初始化地图 ----
const map = new mapboxgl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    sources: {
      'mapbox-streets': {
        type: 'vector',
        url: 'mapbox://mapbox.mapbox-streets-v8',
      },
    },
    layers: [
      // 极简底图：只留水系、地名
      { id: 'bg', type: 'background', paint: { 'background-color': '#f7f7f5' } },
      {
        id: 'water', type: 'fill', source: 'mapbox-streets',
        'source-layer': 'water', paint: { 'fill-color': '#cfe3f5' },
      },
      {
        id: 'place-label', type: 'symbol', source: 'mapbox-streets',
        'source-layer': 'place_label',
        layout: {
          'text-field': ['coalesce', ['get', 'name_zh'], ['get', 'name']],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 16],
          'text-font': ['Noto Sans CJK SC'],
        },
        paint: { 'text-color': '#666', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
      },
    ],
  },
  center: [120.8, 31.6], // 苏州附近
  zoom: 8,
});

export { map, network, linesGeo, stopsGeo };

// 调试钩子（控制台可访问）
window._debugMap = map;
map.on('error', e => console.error('[mapbox]', e?.error?.message || e));

// 依赖注入：子模块不反向 import 本模块（main.js 有顶层 await，循环依赖会死锁）
window.__RAILMAP__ = { map, network, linesGeo, stopsGeo, CATEGORIES };

// 图层与 UI 在 map.js / ui.js 中挂载
await import('./map.js');
await import('./ui.js');
await import('./router.js');
