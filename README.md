# 长三角轨道交通图

上海 / 苏州 / 无锡 / 常州 / 泰州 / 南通 / 嘉兴 / 湖州 八市的轨道交通统一地图，
覆盖高铁、城际、国铁、市域铁路、地铁、有轨电车、磁浮七类线路，支持按类别筛选与路径规划。

**在线访问**：https://kenp-viewsonic.github.io/railmap/

## 技术栈

- 数据：OpenStreetMap（Overpass API 抓取）→ 自建构建脚本聚合为线路/车站/边拓扑
- 前端：Vite + Mapbox GL JS（底图仅保留水系与地名，突出线网）
- 托管：GitHub Pages（GitHub Actions 自动构建部署）

## 本地运行

```bash
# 1. 安装前端依赖
cd web && npm install

# 2. 构建线网数据（已提交 data/raw 原始数据，可直接构建）
cd ..
node scripts/build-network.js

# 3. 启动开发服务器（会先同步数据到 web/public/data）
cd web && npm run dev
```

打开 http://localhost:5173/ 。首次访问需在页面上粘贴自己的
[Mapbox Public Token](https://account.mapbox.com/access-tokens/)（仅用于加载底图，保存在浏览器 localStorage）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run fetch` | 从 Overpass 抓取/更新 OSM 原始数据到 `data/raw/` |
| `npm run build` | 由 `data/raw/` 重新生成 `data/dist/` 线网数据 |
| `npm run validate` | 校验线网数据（缺失线路、单站线路、异常端点等） |
| `cd web && npm run dev` | 启动开发服务器（热更新） |
| `cd web && npm run build` | 构建静态站点到 `web/dist/` |

## 目录结构

```
data/
  raw/        OSM 原始数据（Overpass 抓取结果，已入库）
  curated/    人工配置：线路类别、颜色、站名别名、期望线路清单
  dist/       构建产物（gitignore，由 build-network.js 生成）
scripts/
  fetch-osm.js       Overpass 分片抓取，失败片会报警并要求补抓
  build-network.js   核心：聚合线路 → 串接链 → 站点吸附 → 切片
  copy-dist.js       同步 data/dist → web/public/data
  validate.js        数据健康检查
web/
  src/        前端源码（main / map / ui / router）
  public/data/ 构建产物副本（供 Vite 静态服务）
```

## 数据构建要点

`build-network.js` 处理几类会在地图上表现为「断头」的 OSM 数据问题：

- **线路链串接**：用 ≥200m 基线计算方向向量（站点道岔处相邻点常不足 1m，旧实现会产生方向噪声并误弃合法路段）。
- **端部裁剪**：OSM 常把站后存车线、在建延伸段并入主线 way，轨道会越过终点站数百米到数公里。按「全部车站投影的最外侧位置」裁剪，并对超阈值、与其它子链相连的情况跳过。
- **同名站合并**：阈值 800m；同名但相距 1.4km 的实为两个不同车站（如地铁封浜站与铁路封浜站），错误合并会把线路末端拽到空地。
- **站标记取位**：组内取「中位点」再对 400m 内成员取均值，避免跨城同名节点（如「人民广场」横跨 164km）把标记拉偏。

## 部署

推送到 `main` 分支即触发 GitHub Actions 自动部署到 GitHub Pages。

Mapbox Token 通过仓库 Secret `VITE_MAPBOX_TOKEN` 注入构建（**不在源码中**）：
仓库 `Settings → Secrets and variables → Actions → New repository secret`。
未配置该 Secret 时构建仍会成功，页面会退回「访客自行输入 token」流程。

## 数据来源

地图数据来自 © [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者，
遵循 [ODbL](https://opendatacommons.org/licenses/odbl/) 许可。
