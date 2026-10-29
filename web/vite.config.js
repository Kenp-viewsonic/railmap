import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 项目站点挂在 /<repo>/ 下，用相对路径即可同时兼容
  // 项目站点、用户站点及自定义域名，无需按仓库名改配置。
  base: './',
  build: {
    // main.js 用了顶层 await（顺序加载 map/ui/router 以打破循环依赖），
    // Vite 默认的 chrome87/es2020 目标不支持，需放到 esnext。
    target: 'esnext',
  },
});
