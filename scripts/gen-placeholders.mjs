/**
 * 占位素材生成器。
 *
 *   node scripts/gen-placeholders.mjs --init 40           # 生成示例 contestants.json（已存在则不覆盖）
 *   node scripts/gen-placeholders.mjs --init 40 --force   # 已存在也强制重新生成
 *   node scripts/gen-placeholders.mjs                     # 给缺图的选手补一张 SVG 占位缩略图
 *
 * 真实素材到位后就不再需要它了：把 thumb 指向 thumbs/xxx.jpg 即可。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pub = join(root, 'public');
const dataFile = join(pub, 'data', 'contestants.json');

const argv = process.argv.slice(2);
const initIdx = argv.indexOf('--init');
const initCount = initIdx >= 0 ? Number(argv[initIdx + 1] ?? 32) : 0;
const force = argv.includes('--force');

// 歌手分类只有这两档
const CATEGORIES = ['人气', '新锐'];

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

function makeSample(count) {
  const contestants = [];
  for (let i = 1; i <= count; i++) {
    const id = `mg${String(i).padStart(3, '0')}`;
    contestants.push({
      id,
      name: `猴女郎 ${String(i).padStart(2, '0')}`,
      category: CATEGORIES[i % CATEGORIES.length],
      thumb: `thumbs/${id}.svg`,
      // clip 先留空：卡片会退化成纯图片并显示「暂无片段」
      // 素材转码好之后改成 `clips/${id}.mp4`
    });
  }
  return { version: 1, title: '猴女郎巅峰对决', contestants };
}

/** 用 id 的字符和做一个稳定色相，保证每次生成同一个人颜色不变 */
function hueOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function svgFor(c, index) {
  const h = hueOf(c.id);
  const h2 = (h + 42) % 360;
  const label = String(index + 1).padStart(2, '0');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h} 58% 34%)"/>
      <stop offset="1" stop-color="hsl(${h2} 52% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="400" fill="url(#g)"/>
  <circle cx="150" cy="160" r="72" fill="rgba(255,255,255,0.10)"/>
  <text x="150" y="188" font-family="system-ui, sans-serif" font-size="76" font-weight="800"
        fill="rgba(255,255,255,0.82)" text-anchor="middle">${label}</text>
  <text x="150" y="300" font-family="system-ui, sans-serif" font-size="20" font-weight="600"
        fill="rgba(255,255,255,0.55)" text-anchor="middle">占位图</text>
</svg>
`;
}

// --init：生成示例选手库
if (initCount > 0) {
  if (existsSync(dataFile) && !force) {
    console.log(`! ${dataFile} 已存在，跳过（加 --force 强制重新生成）`);
  } else {
    ensureDir(dataFile);
    writeFileSync(dataFile, JSON.stringify(makeSample(initCount), null, 2) + '\n', 'utf8');
    console.log(`✓ 生成示例选手库：${initCount} 位 → public/data/contestants.json`);
  }
}

if (!existsSync(dataFile)) {
  console.error('× 找不到 public/data/contestants.json，先跑一次 --init 40');
  process.exit(1);
}

const file = JSON.parse(readFileSync(dataFile, 'utf8'));
let written = 0;
let skipped = 0;

file.contestants.forEach((c, i) => {
  const target = join(pub, c.thumb);
  if (existsSync(target)) {
    skipped++;
    return;
  }
  if (!c.thumb.endsWith('.svg')) {
    console.warn(`! ${c.id} 的 thumb 是 ${c.thumb}，不是 svg 占位图，跳过`);
    skipped++;
    return;
  }
  ensureDir(target);
  writeFileSync(target, svgFor(c, i), 'utf8');
  written++;
});

console.log(`✓ 占位缩略图：新建 ${written} 张，跳过 ${skipped} 张`);
