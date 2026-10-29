// map.js — 轨道图层渲染（casing + 线 + 站点 + 换乘站）
// 依赖经 window.__RAILMAP__ 注入（避免与含顶层 await 的 main.js 形成循环 import 死锁）
import mapboxgl from 'mapbox-gl';
const { map, network, linesGeo, stopsGeo, CATEGORIES } = window.__RAILMAP__;

function addLayers() {
  if (map.getLayer('lines-casing')) return; // 防重复
  map.addSource('lines', { type: 'geojson', data: linesGeo });
  map.addSource('stops', { type: 'geojson', data: stopsGeo });

  // 1. 白色 casing（描边）
  map.addLayer({
    id: 'lines-casing',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'],
        8, ['+', ['*', 1.4, ['get', 'widthFactor']], 2],
        14, ['+', ['*', 3, ['get', 'widthFactor']], 4]],
    },
  });

  // 2. 线路本体：按类别宽度 + 线路色
  map.addLayer({
    id: 'lines-main',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'],
        8, ['*', 1.4, ['get', 'widthFactor']],
        14, ['*', 3, ['get', 'widthFactor']]],
      // 注: line-dasharray 不支持数据表达式，电车虚线效果二期用独立图层实现
    },
  });

  // 3. 普通站点（小圆点）
  map.addLayer({
    id: 'stops-dot',
    type: 'circle',
    source: 'stops',
    filter: ['!', ['get', 'transfer']],
    paint: {
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'colour'],
      'circle-stroke-width': 2,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 4],
    },
  });

  // 4. 换乘站（白底彩环，放大）
  map.addLayer({
    id: 'stops-transfer',
    type: 'circle',
    source: 'stops',
    filter: ['get', 'transfer'],
    paint: {
      'circle-color': '#ffffff',
      'circle-stroke-color': '#333333',
      'circle-stroke-width': 2.5,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 7],
    },
  });

  // 5. 路径高亮层（规划结果叠加）
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'route-glow',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 16],
      'line-opacity': 0.3,
    },
  });
  map.addLayer({
    id: 'route-main',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 9],
    },
  });

  // 站点点击弹窗
  map.on('click', ['stops-dot', 'stops-transfer'], e => {
    const f = e.features[0];
    const { names, lines } = f.properties;
    const lineList = JSON.parse(lines);
    const chips = lineList.map(k => {
      const line = network.lines.find(l => l.key === k);
      const colour = line?.colour || '#666';
      const label = line ? `${line.network.replace(/地铁|轨道交通|有轨电车/g, '')} ${line.ref}`.trim() : k;
      return `<span class="line-chip" style="background:${colour}">${label}</span>`;
    }).join('');
    const name = JSON.parse(names)[0] || '未命名站';
    new mapboxgl.Popup({ offset: 8, maxWidth: '240px' })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<div class="popup">
        <h3>${name}</h3>
        ${lineList.length > 1 ? `<div class="sub">换乘站 · ${lineList.length} 条线路</div>` : ''}
        <div class="lines">${chips}</div>
        <div class="actions">
          <button data-action="from" data-name="${name}">设为起点</button>
          <button data-action="to" data-name="${name}">设为终点</button>
        </div></div>`)
      .addTo(map);
  });

  // 弹窗按钮：设为起点/终点后自动规划
  document.addEventListener('click', e => {
    const btn = e.target.closest('.popup .actions button');
    if (!btn) return;
    const name = btn.dataset.name;
    if (btn.dataset.action === 'from') document.getElementById('from').value = name;
    else document.getElementById('to').value = name;
    document.getElementById('plan-btn').click();
  });

  // 鼠标指针
  map.on('mouseenter', ['stops-dot', 'stops-transfer'], () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', ['stops-dot', 'stops-transfer'], () => {
    map.getCanvas().style.cursor = '';
  });
}

// style 可能已加载完（load 事件已错过），轮询确保图层挂上
function ensureLayers() {
  if (map.isStyleLoaded()) { addLayers(); return; }
  setTimeout(ensureLayers, 100);
}
ensureLayers();

// 给 geojson 注入渲染属性（widthFactor/dashed），在 main.js 加载后执行
for (const f of linesGeo.features) {
  const cat = CATEGORIES[f.properties.category] || { width: 2 };
  f.properties.widthFactor = cat.width / 2.5; // 归一化到地铁宽度
  f.properties.dashed = !!cat.dash;
}

// ---- 路径高亮 API（router.js 调用） ----
export function highlightRoute(segments) {
  // segments: [{coords: [[lng,lat],...] | [[[lng,lat],...],...], colour, multi?}]
  const src = map.getSource('route');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: segments.map(s => ({
      type: 'Feature',
      properties: { colour: s.colour },
      // multi=true 时 coords 是断口拆分的多段线（MultiLineString）
      geometry: s.multi
        ? { type: 'MultiLineString', coordinates: s.coords }
        : { type: 'LineString', coordinates: s.coords },
    })),
  });
}

export function clearHighlight() {
  const src = map.getSource('route');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}
