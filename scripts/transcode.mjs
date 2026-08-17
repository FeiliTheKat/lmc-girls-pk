/**
 * 批量转码：raw/ 里的原始视频 → 10 秒低清片段 + 首帧缩略图。
 *
 *   node scripts/transcode.mjs                      # 默认 low 档
 *   node scripts/transcode.mjs --preset potato      # 更狠的压缩
 *   node scripts/transcode.mjs --seconds 8 --start 3
 *   node scripts/transcode.mjs --json               # 顺便把 contestants.json 写出来
 *
 * 输入：raw/<任意文件名>.mp4|mov|mkv|webm，文件名（去扩展名）即选手名
 * 输出：public/clips/<id>.mp4 、 public/thumbs/<id>.jpg
 *
 * 需要 ffmpeg 在 PATH 里。Windows: winget install Gyan.FFmpeg
 *
 * ---- 关于比例 ----
 * 这里不会把视频裁成统一比例。缩略图用 object-fit: cover 铺满 3:4 卡片
 * （它只是氛围参考图，裁一点无所谓，源素材比例随意）；用户点开看视频时，
 * 前端用 object-fit: contain 按原始比例展示，不裁不切——所以转码这一步
 * 保持视频原生比例即可，不需要也不应该在这里强行统一宽高比。
 * 缩略图如果因为源素材比例特殊而裁得不好看，用 contestants.json 里每个
 * 选手的 focus 字段（CSS object-position 语法，如 "top"）微调裁切位置，
 * 不需要重新转码。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rawDir = join(root, 'raw');
const clipDir = join(root, 'public', 'clips');
const thumbDir = join(root, 'public', 'thumbs');
const dataFile = join(root, 'public', 'data', 'contestants.json');

/** 三档预设，数字来自 DESIGN.md 旁边那张体积测算表（按 320px 宽的参考素材估的，
 *  实际体积会随源素材比例浮动——横屏素材面积小，体积通常还更省） */
const PRESETS = {
  // 约 90 KB / 10s —— 128 人合计 ~12 MB
  potato: { width: 256, fps: 12, crf: 36, maxrate: '80k', bufsize: '160k' },
  // 约 140 KB / 10s —— 128 人合计 ~18 MB（推荐）
  low: { width: 320, fps: 15, crf: 34, maxrate: '150k', bufsize: '300k' },
  // 约 250 KB / 10s —— 128 人合计 ~32 MB，画质明显更好
  std: { width: 426, fps: 20, crf: 32, maxrate: '260k', bufsize: '520k' },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const preset = PRESETS[arg('preset', 'low')];
if (!preset) {
  console.error(`× 未知预设，可选：${Object.keys(PRESETS).join(' / ')}`);
  process.exit(1);
}
const seconds = Number(arg('seconds', 10));
const start = Number(arg('start', 0));
const keepAudio = has('audio');

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error('× 找不到 ffmpeg。Windows 装法：winget install Gyan.FFmpeg');
  process.exit(1);
}

if (!existsSync(rawDir)) {
  console.error(`× 没有 raw/ 目录。把原始视频丢进 ${rawDir} 再跑一次`);
  process.exit(1);
}

mkdirSync(clipDir, { recursive: true });
mkdirSync(thumbDir, { recursive: true });

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const files = readdirSync(rawDir).filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()));

if (!files.length) {
  console.error('× raw/ 里没有找到视频文件');
  process.exit(1);
}

function run(args) {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error(r.stderr?.toString().split('\n').slice(-6).join('\n'));
}

const contestants = [];
let ok = 0;
let fail = 0;

files.forEach((f, i) => {
  const name = basename(f, extname(f));
  const id = `mg${String(i + 1).padStart(3, '0')}`;
  const src = join(rawDir, f);
  const clip = join(clipDir, `${id}.mp4`);
  const thumb = join(thumbDir, `${id}.jpg`);

  process.stdout.write(`[${i + 1}/${files.length}] ${name} … `);

  try {
    // 片段：只缩放不裁切，源素材是什么比例输出就是什么比例
    // （偶数宽高是 yuv420p 要求，main profile 兼容性最好，faststart 让首帧秒出）
    run([
      '-y',
      '-ss', String(start),
      '-i', src,
      '-t', String(seconds),
      '-vf', `scale=${preset.width}:-2,fps=${preset.fps}`,
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level', '3.1',
      '-preset', 'slow',
      '-crf', String(preset.crf),
      '-maxrate', preset.maxrate,
      '-bufsize', preset.bufsize,
      '-pix_fmt', 'yuv420p',
      ...(keepAudio ? ['-c:a', 'aac', '-b:a', '48k', '-ac', '1'] : ['-an']),
      '-movflags', '+faststart',
      clip,
    ]);

    // 缩略图：取片段中段那一帧，宽 300 对应卡片 @2x，同样不裁切
    run([
      '-y',
      '-ss', String(start + Math.min(1, seconds / 3)),
      '-i', src,
      '-frames:v', '1',
      '-vf', 'scale=300:-2',
      '-q:v', '6',
      thumb,
    ]);

    contestants.push({
      id,
      name,
      category: '',
      thumb: `thumbs/${id}.jpg`,
      clip: `clips/${id}.mp4`,
    });
    ok++;
    console.log('OK');
  } catch (e) {
    fail++;
    console.log('失败');
    console.error(String(e.message).trim());
  }
});

console.log(`\n✓ 完成：成功 ${ok} 个，失败 ${fail} 个`);
console.log(`  预设 ${arg('preset', 'low')} · ${preset.width}px · ${preset.fps}fps · crf ${preset.crf} · ${seconds}s${keepAudio ? ' · 带音轨' : ' · 无音轨'}`);
console.log('  比例保持源素材原样，不强制裁切；缩略图裁切位置不理想的话用 contestants.json 的 focus 字段微调');

if (has('json')) {
  if (existsSync(dataFile) && !has('force')) {
    const old = join(root, 'public', 'data', 'contestants.generated.json');
    writeFileSync(old, JSON.stringify({ version: 1, title: '猴女郎巅峰对决', contestants }, null, 2) + '\n', 'utf8');
    console.log(`! contestants.json 已存在，结果写到 contestants.generated.json（加 --force 可直接覆盖）`);
    // 顺手提示新增了哪些
    try {
      const cur = JSON.parse(readFileSync(dataFile, 'utf8'));
      const known = new Set(cur.contestants.map((c) => c.id));
      const added = contestants.filter((c) => !known.has(c.id)).length;
      if (added) console.log(`  其中 ${added} 位是新的`);
    } catch {
      /* ignore */
    }
  } else {
    mkdirSync(join(root, 'public', 'data'), { recursive: true });
    writeFileSync(dataFile, JSON.stringify({ version: 1, title: '猴女郎巅峰对决', contestants }, null, 2) + '\n', 'utf8');
    console.log('✓ 已写入 public/data/contestants.json');
  }
}
