#!/usr/bin/env node
'use strict';
/* copy-dist.js — 把 data/dist 拷到 web/public/data（vite 静态服务） */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'dist');
const DST = path.join(__dirname, '..', 'web', 'public', 'data');

if (!fs.existsSync(path.join(SRC, 'network.json'))) {
  console.error('data/dist/network.json 不存在，先跑 node scripts/build-network.js');
  process.exit(1);
}
fs.mkdirSync(DST, { recursive: true });
for (const f of ['network.json', 'lines.geojson', 'stops.geojson']) {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  console.log(`copied ${f} (${(fs.statSync(path.join(DST, f)).size / 1048576).toFixed(2)} MB)`);
}
