# 猴女郎巅峰对决

纯前端的淘汰赛小游戏：两两 PK，一路选到冠军。没有后端、没有登录注册，所有数据只存在浏览器里。

美术规范见 [DESIGN.md](DESIGN.md)——改任何样式前先看那份文档，颜色/圆角/动效都是 token 化的。

## 跑起来

```bash
npm install
npm run dev
```

打开 http://localhost:5173 。仓库里带的是 40 位真实素材（真实视频 + 浏览器截帧生成的真实缩略图），可以直接体验完整赛制。

## 核心交互

**缩略图是氛围参考图，不是本人照片，名字文字才是主要内容。** 卡片因此拆成两个独立的点击区，各自是真正的 `<button>`：

- 点**图片区域** → 弹出居中的视频层，用视频原生比例播放，不裁不切，遮罩盖住整个背景
- 点**底部文字条**（选手名） → 选择该选手晋级，右端有个常驻可见的对勾图形，不用 hover 就能看出"这里能点"
- 视频**永远不自动播放**，必须先有这次点击手势才会播——因此允许带声音，这是自动播放做不到的
- 全站同一时刻只有一条视频在播；关闭方式三选一：点关闭键、点视频以外的遮罩空白处、按 Escape
- 点确认后才真正推进赛程

## 换成你自己的素材

### 已有一批文件，想直接批量导入

参考 [scripts/import-roster.mjs](scripts/import-roster.mjs)：按源目录结构（子目录名当分类，散装文件不带分类）批量复制视频、生成 `contestants.json`。这是一次性脚本，跑之前改一下里面的 `SRC` 路径和分组规则。

缩略图不需要 ffmpeg：[scripts/thumb-receiver.mjs](scripts/thumb-receiver.mjs) 起一个本地小服务器，配合浏览器 `canvas.drawImage()` 直接对已经能播放的视频截帧，POST 存成 jpg。用法：

```bash
node scripts/thumb-receiver.mjs   # 另开一个终端，先把它跑起来
```

然后在跑着 dev server 的页面里，对每个 `/clips/<id>.mp4` 建一个 `<video>`、seek 到某一帧、`canvas.toBlob()`，`fetch` POST 到 `http://localhost:5175/thumb/<id>`。截完关掉这个服务器就行，它不是长期跑的东西。

### 从头开始：转码 + 生成数据

把原始视频丢进 `raw/`，文件名（去扩展名）就是选手名：

```
raw/
  阿珍.mp4
  阿强.mov
```

然后（需要先装 ffmpeg，Windows：`winget install Gyan.FFmpeg`）：

```bash
node scripts/transcode.mjs --preset low --json
```

它会输出 `public/clips/<id>.mp4` 和 `public/thumbs/<id>.jpg`，并生成一份 `contestants.json`。**不会强行裁剪成统一比例**——缩略图用 `cover` 铺满卡片，视频播放走原生比例的居中弹层，源素材横的竖的方的都不影响转码流程，这一步只做缩放不做裁切。

三档预设（体积会随源素材实际画面内容浮动，这里给的是参考量级）：

| 预设 | 规格 | 单条 10s（参考） |
|---|---|---|
| `potato` | 256px · 12fps · crf 36 | ~90 KB |
| `low`（默认） | 320px · 15fps · crf 34 | ~140 KB |
| `std` | 426px · 20fps · crf 32 | ~250 KB |

常用参数：`--seconds 8`（片段时长）、`--start 3`（从第几秒截起）、`--audio`（保留音轨，体积 +48kbps）、`--force`（直接覆盖已有 contestants.json）。

### 选手库格式

`public/data/contestants.json`：

```json
{
  "version": 1,
  "title": "猴女郎巅峰对决",
  "contestants": [
    {
      "id": "mg001",
      "name": "阿珍",
      "category": "人气",
      "thumb": "thumbs/mg001.jpg",
      "clip": "clips/mg001.mp4",
      "focus": "top",
      "championLine": "毫无悬念"
    }
  ]
}
```

`category`、`clip`、`focus`、`championLine` 都是可选的：

- 没有 `category` 就不属于任何分类——**不要发明"未分类"这种类目**，只有点「不限」时才会和其他人一起出现，选中某个具体分类不会显示它。分类 chip 只由数据里出现过的 `category` 值自动生成。
- 没有 `clip` 的选手卡片会退化成纯图片，右下角标「暂无片段」，其余功能不受影响——**所以你可以先只做图片版上线，视频后面再逐个补**。
- `focus` 是缩略图裁切位置的微调（CSS `object-position` 语法，如 `"top"`），不需要重新转码就能调，只影响缩略图（`cover` 阶段），不影响视频弹层（视频本来就是原生比例，不裁切）。

### 占位图

还没有真实素材时：

```bash
node scripts/gen-placeholders.mjs --init 40
```

生成 N 位示例选手 + 彩色占位缩略图。已有 `contestants.json` 时加 `--force` 才会重新生成。

## 预加载策略

这是整个项目最需要小心的地方。见 `src/preload.ts`。

分三层，进度条只反映前两层（阻塞层），后台层不占进度——不然用户会盯着一个永远走不完的条：

| 层 | 内容 | 行为 |
|---|---|---|
| L0 阻塞 | 参赛选手的全部缩略图 | 通常几十 KB 一张，1 秒内跑完 |
| L1 阻塞 | 首场对阵的 2 条片段 | 保证第一屏点开就播 |
| L2 后台 | 其余片段 | 并发 3，按对阵顺序排队 |

每确认一场，下一场的两条片段会被顶到队首（`preloader.prioritize`）。用户看片时后台预取自动暂停，把带宽让给当前这条流。

资源落在 **Cache Storage** 而不是 Blob：不占 JS 堆内存、跨会话持久，第二次访问全部秒开。非安全上下文（比如直接 `file://` 打开）会自动退化成普通 fetch。

**片段体积直接决定首屏体验**：低清转码档（~140KB/条）下 128 人合计约 18MB，分层预加载后首屏只需约 1.6MB；如果像本仓库当前这样用未压缩的原始素材（本仓库 40 条约 1.5MB/条，合计 62.8MB），同样的策略仍然适用（后台预取、单流暂停规则都不变），只是每层要传的字节数更大，弱网下会更明显感觉到——要不要压缩、压到什么程度，看你自己权衡画质和加载体验。

## 赛制

单败淘汰，每轮结束后重新洗牌配对（和常见的固定对阵树不同，这是刻意的：重排让每一轮都有新鲜感）。

参赛人数**不必是 2 的整数次幂**——奇数时最后一位轮空自动晋级，所以自选参赛可以是任意人数（≥2）。轮次名按本轮开赛人数计算，一轮之内恒定。

**没有断点续赛**：刷新或离开对战页，当前这场就没了，回首页重新开一场。这是刻意去掉的——产品定位就是一次坐下来打完的短会话，不是要打很多轮的东西，"继续上次比赛"这个入口留着反而是多余的界面元素。

## 部署

```bash
npm run build
```

产物在 `dist/`，纯静态（`public/` 下的所有素材会原样拷进 `dist/`）。打包用的是相对路径（`base: './'`），丢到任何静态托管或子目录都能直接跑。

**实际部署用的是 GitHub Pages**：`.github/workflows/deploy.yml` 推 `master` 就自动 build + 发布，跟仓库账号下其它项目各自独立（GitHub Pages 一个仓库一个站点，互不影响）。仓库首次建好后要去 Settings → Pages 把 Source 手动切到 "GitHub Actions"（只需要点一次，之后每次 push 都是全自动的）。

带宽/体积不是这个项目的顾虑量级了（视频压完全站 `dist/` 只有 ~6MB），但如果以后素材库涨大到 GitHub Pages 的软性带宽额度会紧张，**Cloudflare Pages** 是更宽裕的备选（免费且带宽不限量）——换平台不用改配置，上面那句相对路径就是为这个留的退路。

`public/_headers` 是 Cloudflare Pages 专用的缓存配置文件，GitHub Pages 不会读它（GitHub Pages 自己的默认缓存策略已经比较合理，没有等价的自定义 headers 机制）——留着不影响任何东西，只是万一以后换回 Cloudflare 能直接生效。它给 clips/thumbs/hero/audio/creators 这些手动转码产出的素材设了一年 immutable 缓存（Cloudflare Pages 默认是 `max-age=0, must-revalidate`，每次都要跟 CDN 确认一遍）。代价：这些文件名不带内容哈希，以后要是重新转码（改压缩预设之类），文件内容变了但 URL 没变，immutable 窗口内的回头客不会自动看到新版本——记得手动把文件改名/加版本号。`index.html` 和 `/data/*` 故意没设，维持默认行为。

## 目录

```
public/
  data/contestants.json   选手库
  thumbs/                 缩略图
  clips/                  视频片段
raw/                      原始视频（不进版本库，转码脚本的输入）
scripts/
  transcode.mjs           批量转码（不强制裁剪比例）
  gen-placeholders.mjs    占位图生成
  import-roster.mjs       一次性导入脚本（按目录结构批量接入真实素材）
  thumb-receiver.mjs      一次性缩略图接收服务器（配合浏览器截帧，不需要 ffmpeg）
src/
  main.ts                 视图与路由
  tournament.ts           赛制引擎（纯函数，只存 id）
  preload.ts              分层预加载器
  card.ts                 选手卡片（两个热区）+ 视频弹层
  poster.ts               「晋级之路」海报（原生 canvas）
  style.css               DESIGN.md 的 token 实现
DESIGN.md                 美术规范
PLACEHOLDER_COLORS.md      占位图配色对照表（占位阶段专用，真实素材接入后作废）
```
