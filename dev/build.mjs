// build.mjs — bundle three (as global THREE) + the game, inline everything into one HTML file.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('../refer/html/snowline-rally.html');

const vendor = await build({
  entryPoints: ['node_modules/three/build/three.module.js'],
  bundle: true,
  format: 'iife',
  globalName: 'THREE',
  minify: true,
  target: ['es2020'],
  write: false,
  legalComments: 'none',
});

const game = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: false,
  target: ['es2020'],
  write: false,
  legalComments: 'none',
});

const css = fs.readFileSync('src/styles.css', 'utf8');
const vendorJs = vendor.outputFiles[0].text;
const gameJs = game.outputFiles[0].text;

const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<!--
  Snowline Rally — a single-file procedural rally game.
  SPDX-License-Identifier: MIT
  Copyright (c) 2025-2026 The Snowline Rally authors. See LICENSE.

  Third-party software:
  - three.js r180 — MIT License, Copyright (c) 2010-2025 three.js authors
    https://github.com/mrdoob/three.js

  MIT License

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
-->
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#eef7fe">
<meta name="license" content="MIT">
<title>SNOWLINE RALLY — 单文件拉力赛</title>
<style>
${css}
</style>
</head>
<body>
<canvas id="view"></canvas>
<div id="app"></div>
<noscript><div style="position:fixed;inset:0;display:grid;place-items:center;background:#080a0c;color:#ece8df;font-family:system-ui">需要启用 JavaScript</div></noscript>
<script>
window.addEventListener('error', function (e) {
  var el = document.querySelector('[data-f="bootmsg"]');
  if (el) el.textContent = '启动失败：' + (e.message || '未知错误');
});
</script>
<script>${safe(vendorJs)}</script>
<script>${safe(gameJs)}</script>
</body>
</html>
`;

fs.writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`wrote ${out}`);
console.log(`total ${kb(Buffer.byteLength(html))}  vendor ${kb(Buffer.byteLength(vendorJs))}  game ${kb(Buffer.byteLength(gameJs))}  css ${kb(Buffer.byteLength(css))}`);
