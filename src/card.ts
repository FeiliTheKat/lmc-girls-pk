/**
 * 选手卡片：名字文字是主要内容，上半区是氛围图，不是内容本身。
 *
 * 卡片分三等份（DESIGN.md §4）：
 *   上 2/3（.card-visual）→ hueOf() 哈希算出的渐变色打底（同一个 id 永远
 *     同一个颜色，见 PLACEHOLDER_COLORS.md）；桌面端 hover 静音循环预览，
 *     点击直接在卡片原地切成带声音的"正片"播放，不弹层
 *   下 1/3（.card-name） → 放大的名字，点了选择该选手晋级
 *
 * 曾经这里打底的是缩略图离线生成的毛玻璃静态图（scripts/gen-blur-thumbs.mjs
 * / blurThumbUrl()），2026-08-17 试跑了一遍发现效果不好——模糊到位后大部分
 * 选手的背景色都趋同（鲜艳的道具/装饰颜色被磨成差不多的紫灰色），卡片之间
 * 靠背景色区分选手的辨识度反而下降，被否掉了。连带清掉了：`public/thumbs/`
 * 那 40 张原图（`preload.ts`/`data.ts` 的 thumbUrls()/blurThumbUrl() 一直在
 * 后台把它们当"毛玻璃版"路径去 fetch，其实从来没生成过 thumbs-blur/，全是
 * 404，纯白费流量和请求数）、以及 data.ts 里两个只为这条路径存在的函数。
 * 现在就是单纯的哈希渐变色，没有图片层。
 *
 * 2026-08-17 这天还改了两轮点击/hover 交互：
 *   1) 加回"鼠标 hover 静音自动播放视频预览"——早前因浏览器合成层白闪 bug
 *      （`.card`/`.card-visual` 的 isolation: isolate 就是当时留下的兜底）
 *      和当时片源平均 1.6MB/条太重去掉过，两个原因都随片源重新转码到
 *      ~110KB/条后不成立了。
 *   2) 去掉点击弹出的居中浮层：点击直接复用同一个 <video>，从静音循环预览
 *      切到带声音、播完自动停的"正片"状态；播放键从"hover 才现身"改成
 *      默认常驻显示——不弹层之后它是唯一告诉用户"这里能点"的可见入口。
 *      全站同一时刻只允许一张卡在出声，跟之前弹层"同一时刻只放一条"是
 *      同一个约束，只是承载的容器从独立浮层变成卡片自己。
 */

import type { Contestant } from './types';
import { assetUrl } from './data';
import { preloader } from './preload';
import { duckBgm, unduckBgm } from './bgm';

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

/** 鼠标停留多久才当作"真的想看预览"，纯划过路过不触发下载 */
const HOVER_INTENT_MS = 150;
/** 跟 CSS 里 .card-preview-video 的 transition 时长（--dur-state）对齐，
 *  淡出动画走完再真正暂停/卸载，画面不会戛然而止 */
const PREVIEW_FADE_MS = 220;

/** 只在真正支持 hover 的指针设备上启用静音预览，触屏没有"划过又移开"这种
 *  手势；用户开了「减少动态效果」也尊重，不强制自动播放。点击播放这个动作
 *  跟这个开关无关，所有设备都有 */
const HOVER_PREVIEW_ENABLED = (() => {
  try {
    return (
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
})();

/**
 * 和 scripts/gen-placeholders.mjs 的 hueOf() 完全一致的哈希算法，见
 * PLACEHOLDER_COLORS.md——同一个 id 永远算出同一个颜色，重新加载/换设备
 * 都不会变。这不是"占位图复活"，是产品所有者明确要求卡片背景改用这套
 * 配色而不是真实照片。
 */
function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function gradientFor(id: string): string {
  const h = hueOf(id);
  const h2 = (h + 42) % 360;
  return `linear-gradient(135deg, hsl(${h} 58% 34%), hsl(${h2} 52% 12%))`;
}

const MUTE_KEY = 'mgc:muted';

let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

/** 当前正在出声播放"正片"的卡片，全站唯一 */
let active: { video: HTMLVideoElement; viewBtn: HTMLButtonElement | null } | null = null;

export function isMuted(): boolean {
  return muted;
}

export function setMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (active) active.video.muted = v;
}

function resetViewBtn(viewBtn: HTMLButtonElement | null): void {
  if (!viewBtn) return;
  viewBtn.dataset.state = 'idle';
  viewBtn.innerHTML = PLAY_ICON;
  viewBtn.setAttribute('aria-label', '播放视频');
}

/**
 * 停掉当前正在出声播放的卡片。鼠标还停在上面的话续成静音循环预览（不让
 * 画面凭空消失），否则跟 hover 移开时一样彻底卸载 <video>（摘 src + load()
 * 真正释放解码器/网络请求，不是只是隐藏）。
 */
export function stopActiveClip(): void {
  if (!active) return;
  const { video, viewBtn } = active;
  active = null;
  video.pause();
  video.loop = true;
  video.muted = true;
  resetViewBtn(viewBtn);
  preloader.resumeBackground();
  unduckBgm();

  if (HOVER_PREVIEW_ENABLED && video.matches(':hover')) {
    video.currentTime = 0;
    void video.play().catch(() => {});
  } else {
    video.removeAttribute('src');
    video.load();
  }
}

// 弹层时代 Esc 能关；现在没有弹层了，但正在出声播放的卡还是应该能用键盘
// 停掉——挂在 module 顶层一次性注册，不用像原来的弹层那样开关时反复
// add/removeEventListener
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopActiveClip();
});

/**
 * 点击热区/播放键的核心逻辑：已经是当前出声播放的卡就停掉；否则先停掉
 * 别的卡（全站同一时刻只放一条），把这条切到带声音、不循环的"正片"状态。
 * 必须在用户手势的同一个调用栈里发起 play()，中间不能有 await。
 */
function toggleActive(c: Contestant, video: HTMLVideoElement, viewBtn: HTMLButtonElement | null): void {
  if (active?.video === video) {
    stopActiveClip();
    return;
  }
  stopActiveClip();

  // 让出带宽给这条流，别和后台预取抢
  preloader.pauseBackground();
  // 视频有自己的声音，闪避掉背景音乐，不叠两条音轨
  duckBgm();

  video.loop = false;
  video.muted = muted;
  if (!video.src) video.src = assetUrl(c.clip!);
  video.currentTime = 0;

  active = { video, viewBtn };
  if (viewBtn) {
    viewBtn.dataset.state = 'loading';
    viewBtn.innerHTML = '';
  }

  const showPlaying = () => {
    if (active?.video !== video || !viewBtn) return;
    viewBtn.dataset.state = 'playing';
    viewBtn.innerHTML = PAUSE_ICON;
    viewBtn.setAttribute('aria-label', '暂停');
  };

  // play() 的 promise resolve 才代表真的开始播了，比监听 'playing' 事件
  // 靠谱——如果这条视频已经在 hover 预览里播着（只是把 currentTime 拨回
  // 0），浏览器不一定会为此再发一次 'playing'，但这个 promise 总会 resolve
  const p = video.play();
  if (p) {
    p.then(showPlaying).catch(() => {
      // 极少数情况下带声音被拦，退化成静音重试一次
      video.muted = true;
      void video.play().then(showPlaying).catch(() => {
        if (active?.video === video) stopActiveClip();
      });
    });
  } else {
    showPlaying();
  }
}

/**
 * 给卡片上半区挂一个复用的 <video>：桌面端 hover 静音循环预览，点击切到
 * 带声音、播完自动停的"正片"——同一个元素两种状态来回切，不建两条 <video>。
 * 播放键的点击/状态切换在 createCard()/toggleActive() 里管，这里不碰。
 */
function attachCardVideo(visual: HTMLElement, c: Contestant): HTMLVideoElement {
  const video = document.createElement('video');
  video.className = 'card-preview-video';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  // @ts-expect-error 老版本 iOS Safari 只认这个属性名
  video.webkitPlaysinline = true;
  video.preload = 'none';
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  // 不复用缩略图的 focus 裁切锚点：那是给静态图调的，视频里套用同一个偏移
  // 经常会把裁切窗口推到画面边缘的黑边上（原始素材本来就是竖版内容嵌在
  // 16:9 画布里、左右带黑边）。这里就老老实实居中铺满——用户明确要求
  // "不用让女生在正中间，直接把视频放进框里就行"，不做额外偏移
  visual.prepend(video);

  // 播放键的状态切换在 toggleActive() 里靠 play() 的 promise 驱动，这里
  // 只管淡入——静音预览和出声正片共用同一个事件
  video.addEventListener('playing', () => video.classList.add('is-visible'));

  video.addEventListener('ended', () => {
    if (active?.video === video) stopActiveClip();
  });

  video.addEventListener('error', () => {
    if (active?.video !== video) return;
    stopActiveClip();
    showToast(`${c.name} 的片段加载失败`);
  });

  if (HOVER_PREVIEW_ENABLED) {
    let hoverTimer: number | undefined;
    let hideTimer: number | undefined;

    visual.addEventListener('mouseenter', () => {
      if (active?.video === video) return; // 正在出声播放，hover 不干预
      window.clearTimeout(hideTimer);
      hoverTimer = window.setTimeout(() => {
        if (!video.src) video.src = assetUrl(c.clip!);
        void video.play().catch(() => {
          // 页面还没收到任何用户手势时浏览器可能拦自动播放；静态毛玻璃图
          // 兜底着，不是关键路径，拦了就拦了
        });
      }, HOVER_INTENT_MS);
    });

    visual.addEventListener('mouseleave', () => {
      window.clearTimeout(hoverTimer);
      if (active?.video === video) return; // 出声播放不受鼠标移开影响
      video.classList.remove('is-visible');
      hideTimer = window.setTimeout(() => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }, PREVIEW_FADE_MS);
    });
  }

  return video;
}

export interface CardOptions {
  /** 点文字条时回调；不传则文字条不可点，只是个标签 */
  onSelect?: (c: Contestant) => void;
  /** 是否显示左上角分类标签 */
  showCategory?: boolean;
}

export function createCard(c: Contestant, opts: CardOptions = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = c.id;

  const media = document.createElement('div');
  media.className = 'card-media';

  // 上 2/3：哈希渐变色打底 + 播放热区（没有图片层，见文件顶部注释）
  const visual = document.createElement('div');
  visual.className = 'card-visual';
  visual.style.background = gradientFor(c.id);
  media.appendChild(visual);

  let viewBtn: HTMLButtonElement | undefined;
  let video: HTMLVideoElement | undefined;

  if (c.clip) {
    video = attachCardVideo(visual, c);
  } else {
    visual.addEventListener('click', () => showToast(`${c.name} 暂无片段`));
    const tag = document.createElement('span');
    tag.className = 'card-noclip';
    tag.textContent = '暂无片段';
    visual.appendChild(tag);
  }

  if (opts.showCategory && c.category) {
    const cat = document.createElement('span');
    cat.className = 'card-cat';
    cat.textContent = c.category;
    visual.appendChild(cat);
  }

  // 播放键：默认常驻显示（不弹层之后它是唯一"这里能点"的可见提示），跟点
  // .card-visual 任意位置是同一个动作
  if (c.clip && video) {
    const clipVideo = video;
    viewBtn = document.createElement('button');
    viewBtn.className = 'card-view-btn';
    viewBtn.type = 'button';
    viewBtn.dataset.state = 'idle';
    viewBtn.innerHTML = PLAY_ICON;
    viewBtn.setAttribute('aria-label', '播放视频');
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleActive(c, clipVideo, viewBtn ?? null);
    });
    visual.appendChild(viewBtn);

    visual.addEventListener('click', () => toggleActive(c, clipVideo, viewBtn ?? null));
  }

  // 下 1/3：名字，主要内容，也是「选择晋级」的唯一入口。选中状态靠
  // 上半区的绿色浸染 + 卡片本身的描边/辉光表达——不再额外放对勾图形，
  // 太多处同时说"选中了"是冗余信息
  if (opts.onSelect) {
    const nameBtn = document.createElement('button');
    nameBtn.className = 'card-name';
    nameBtn.type = 'button';
    nameBtn.setAttribute('aria-label', `选择 ${c.name} 晋级`);

    const text = document.createElement('span');
    text.className = 'card-name-text';
    text.textContent = c.name;
    nameBtn.appendChild(text);

    nameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onSelect!(c);
    });
    media.appendChild(nameBtn);
  } else {
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = c.name;
    media.appendChild(name);
  }

  card.appendChild(media);
  return card;
}

let toastTimer: number | undefined;

export function showToast(msg: string): void {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2200);
}
