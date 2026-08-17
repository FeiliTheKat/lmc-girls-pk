/**
 * 一次性导入脚本：把 D:\自媒体素材库\猴游戏2视频\人物 下的真实素材接进项目。
 *
 *   node scripts/import-roster.mjs
 *
 * 规则：
 *   - 人气/ 子目录下的视频 → category: '人气'
 *   - 新锐/ 子目录下的视频 → category: '新锐'
 *   - 直接扔在 人物/ 根目录下、没进任何子目录的视频 → 不写 category 字段
 *     （不发明"未分类"这种类目，"不限"筛选自然会把它们和其他人一起显示）
 *   - 文件名（去扩展名）就是选手名
 *   - 不转码，原样复制——这一步只是把素材接进来，测试真实体验
 *
 * 缩略图这一步先不管，交给 scripts/gen-video-thumbs.mjs（用浏览器截帧，不需要 ffmpeg）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clipDir = join(root, 'public', 'clips');
const dataFile = join(root, 'public', 'data', 'contestants.json');

const SRC = 'D:\\自媒体素材库\\猴游戏2视频\\人物';

mkdirSync(clipDir, { recursive: true });

function listMp4(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === '.mp4')
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

const groups = [
  { dir: join(SRC, '人气'), category: '人气' },
  { dir: join(SRC, '新锐'), category: '新锐' },
  { dir: SRC, category: undefined }, // 根目录下的散装文件，不带分类
];

const contestants = [];
let seq = 1;
let totalBytes = 0;

for (const { dir, category } of groups) {
  for (const file of listMp4(dir)) {
    const src = join(dir, file);
    const id = `mg${String(seq).padStart(3, '0')}`;
    const name = basename(file, extname(file));
    const destClip = join(clipDir, `${id}.mp4`);

    copyFileSync(src, destClip);
    const size = statSync(destClip).size;
    totalBytes += size;

    const entry = {
      id,
      name,
      thumb: `thumbs/${id}.jpg`,
      clip: `clips/${id}.mp4`,
    };
    if (category) entry.category = category;
    contestants.push(entry);

    console.log(
      `[${String(seq).padStart(2, '0')}/40] ${id}  ${name}${category ? `（${category}）` : '（无分类）'}  ${(size / 1024 / 1024).toFixed(2)} MB`,
    );
    seq++;
  }
}

writeFileSync(
  dataFile,
  JSON.stringify({ version: 1, title: '猴女郎巅峰对决', contestants }, null, 2) + '\n',
  'utf8',
);

console.log(`\n✓ 导入 ${contestants.length} 位选手 → public/data/contestants.json`);
console.log(`✓ 复制 ${contestants.length} 条视频 → public/clips/，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，原始比特率未改动`);
console.log(`  下一步跑 scripts/gen-video-thumbs.mjs 生成真实缩略图（需要 dev server 在跑）`);
