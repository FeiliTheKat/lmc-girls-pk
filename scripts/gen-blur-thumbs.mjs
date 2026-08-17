/**
 * 从 public/thumbs/*.jpg 生成卡片用的毛玻璃背景图 → public/thumbs-blur/<id>.jpg
 *
 *   node scripts/gen-blur-thumbs.mjs
 *
 * 需要 ffmpeg 在 PATH 里（和 transcode.mjs 一样）。Windows: winget install Gyan.FFmpeg
 *
 * ---- 为什么这样做 ----
 * 卡片上半区（.card-visual）以前鼠标 hover 会静音自动播放视频预览，后来去掉了：
 * 一是浏览器合成层在起播那一瞬间有白色闪烁的 bug；二是选手库网格里卡片一多，
 * 用户鼠标扫过去等于给经过的每一张卡都触发一次视频下载。现在默认展示的是这张
 * 离线生成好的毛玻璃图，点击才真正加载视频。
 *
 * 模糊在构建期用 ffmpeg 一次性烧进图片像素里，不是运行时 backdrop-filter——
 * 卡片数量一多，每张卡都实时跑一次 GPU 模糊，比浏览器解一张几 KB 的小图开销
 * 大得多，这也是产品所有者要"毛玻璃图片"而不是"毛玻璃滤镜"的原因。
 *
 * 先缩小到很小的尺寸再模糊：模糊半径相对图片尺寸才够把构图"化开"，产物也就
 * 几 KB，不需要为了保留细节而用大图——反正最终就是要看不清细节的效果。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const thumbDir = join(root, 'public', 'thumbs');
const outDir = join(root, 'public', 'thumbs-blur');

// 缩到这个宽度再模糊；数字来自试验：太大模糊不掉构图细节，太小会在放大铺满
// 卡片时出现明显色块边界（gblur 本身能柔化，但源太小还是会露馅）
const SCALE_WIDTH = 120;
const BLUR_SIGMA = 20;

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error('× 找不到 ffmpeg。Windows 装法：winget install Gyan.FFmpeg');
  process.exit(1);
}

if (!existsSync(thumbDir)) {
  console.error(`× 没有 ${thumbDir}，先跑 npm run assets:transcode 生成缩略图`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const files = readdirSync(thumbDir).filter((f) => extname(f).toLowerCase() === '.jpg');
if (!files.length) {
  console.error('× public/thumbs 里没有 jpg，先跑 npm run assets:transcode');
  process.exit(1);
}

let ok = 0;
let fail = 0;

for (const f of files) {
  const src = join(thumbDir, f);
  const out = join(outDir, f);

  process.stdout.write(`${f} … `);
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i', src,
      '-vf', `scale=${SCALE_WIDTH}:-2,gblur=sigma=${BLUR_SIGMA}`,
      '-q:v', '5',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  if (r.status === 0) {
    ok++;
    console.log('OK');
  } else {
    fail++;
    console.log('失败');
    console.error(r.stderr?.toString().split('\n').slice(-4).join('\n'));
  }
}

console.log(`\n✓ 完成：成功 ${ok} 个，失败 ${fail} 个 → public/thumbs-blur/`);
if (fail === 0) {
  console.log('  卡片背景加载失败时会退化成渐变色兜底，不影响这次生成是否完整');
}
