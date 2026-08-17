/**
 * 一次性小工具：接收浏览器 POST 过来的截帧二进制，直接写进 public/thumbs/。
 * 只在生成真实缩略图这一步用一下，用完就关掉，不是长期跑的服务。
 *
 *   node scripts/thumb-receiver.mjs
 *
 * 浏览器端配合：canvas.toBlob() → fetch(`http://localhost:5175/thumb/mg001`, {method:'POST', body: blob})
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const thumbDir = join(root, 'public', 'thumbs');
mkdirSync(thumbDir, { recursive: true });

const PORT = 5175;
let count = 0;

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const m = /^\/thumb\/([a-z0-9]+)$/.exec(req.url || '');
  if (req.method !== 'POST' || !m) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const id = m[1];
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    writeFileSync(join(thumbDir, `${id}.jpg`), buf);
    count++;
    console.log(`✓ [${count}] ${id}.jpg  ${(buf.length / 1024).toFixed(1)} KB`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
});

server.listen(PORT, () => {
  console.log(`缩略图接收服务已启动：http://localhost:${PORT}`);
});
