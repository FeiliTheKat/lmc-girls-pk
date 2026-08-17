import './style.css';
import type { Contestant, TournamentState } from './types';
import {
  assetUrl,
  categories,
  clipUrls,
  contestants,
  get,
  loadData,
  poolFor,
} from './data';
import {
  createTournament,
  currentPair,
  currentRoundName,
  pickWinner,
  playableCount,
  playableIndex,
  upcomingIds,
} from './tournament';
import { createCard, isMuted, setMuted, showToast, stopActiveClip } from './card';
import { setBgmMuted } from './bgm';
import { preloader } from './preload';

// 选手库只有 40 位，64/128 目前凑不满，不放出来选——库存够了再加回去
const SIZES = [16, 32];

// 开始页开局预加载用哪个分类：「人气」现有正好 16 位，和首页默认的
// 16 位规模天然对齐（见 DESIGN.md §9）
const SPLASH_CATEGORY = '人气';
const SPLASH_SIZE = 16;

// 作者（左列）+ 鸣谢（右列，视频素材提供者）。只放头像 + ID，不放各自
// 平台上的简介——简介和"这场比赛的素材/网站是谁做的"无关，是噪音
// （见 DESIGN.md §4）
const AUTHOR: { name: string; role: string; avatar: string } = {
  name: 'FelixTheKat-',
  role: '网站作者',
  avatar: 'creators/felixthekat.jpg',
};
const CREDITS: { name: string; role: string; avatar: string }[] = [
  { name: '随风弟弟', role: '视频素材提供者', avatar: 'creators/suifengdidi.jpg' },
  { name: '爆猴猫-授权录播号', role: '视频素材提供者', avatar: 'creators/baohoumao.jpg' },
];

// 冠军页播报文案：随机三选一，名字单独拆出来才能在同一行里用金色高亮而不是
// 整句一个颜色。缓存在 announceCache 而不是每次都掷骰子——main.ts 是全量
// 重渲染模式，静音按钮之类的操作也会触发 render()，同一次查看冠军页文案却
// 跳来跳去会很奇怪；只在冠军换人（新的一场比赛）时重新抽
const CHAMPION_ANNOUNCEMENTS: [prefix: string, suffix: string][] = [
  ['🏆 恭喜', '过关斩将，正式问鼎"猴女一"！'],
  ['🎉 你的眼光绝了！', '成功斩获总冠军！'],
  ['👑 C位诞生！', '凭实力霸气登顶！'],
];
let announceCache: { id: string; prefix: string; suffix: string } | null = null;
function championAnnouncement(champ: Contestant): { prefix: string; suffix: string } {
  if (announceCache?.id !== champ.id) {
    const [prefix, suffix] =
      CHAMPION_ANNOUNCEMENTS[Math.floor(Math.random() * CHAMPION_ANNOUNCEMENTS.length)];
    announceCache = { id: champ.id, prefix, suffix };
  }
  return announceCache;
}

type View = 'splash' | 'home' | 'picker' | 'gate' | 'match' | 'champion' | 'library';

interface App {
  view: View;
  mode: 'random' | 'manual';
  category: string | null;
  /** 自选参赛的勾选集合 */
  selection: Set<string>;
  state: TournamentState | null;
  /** 当前这场选中的选手 */
  picked: string | null;
  gate: { loaded: number; total: number; label: string };
  query: string;
  libCategory: string | null;
  /** 开始页三段式状态机，见 DESIGN.md §7 */
  splash: { stage: 'loading' | 'ready' | 'revealed'; loaded: number; total: number };
}

const app: App = {
  view: 'splash',
  mode: 'random',
  category: null,
  selection: new Set(),
  state: null,
  picked: null,
  gate: { loaded: 0, total: 1, label: '' },
  query: '',
  libCategory: null,
  splash: { stage: 'loading', loaded: 0, total: 1 },
};

const root = document.getElementById('app')!;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function go(v: View): void {
  stopActiveClip();
  app.view = v;
  app.query = '';
  render();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ */
/* 顶栏                                                                */
/* ------------------------------------------------------------------ */

function topbar(): HTMLElement {
  const bar = el('header', 'topbar');

  const brand = el('div', 'brand', '猴女郎巅峰对决');
  brand.style.cursor = 'pointer';
  brand.addEventListener('click', () => go('home'));
  bar.appendChild(brand);

  // 全局静音开关：同时控制选手视频片段的音量和背景音乐，只有一个开关，
  // 不搞两套互相独立的静音状态（见 bgm.ts 顶部注释）
  const sound = el('button', 'btn btn-secondary btn-sm', isMuted() ? '🔇 静音' : '🔊 有声');
  sound.addEventListener('click', () => {
    setMuted(!isMuted());
    setBgmMuted(isMuted());
    sound.textContent = isMuted() ? '🔇 静音' : '🔊 有声';
  });
  bar.appendChild(sound);

  if (app.view !== 'library') {
    const lib = el('button', 'btn btn-secondary btn-sm', '选手库');
    lib.addEventListener('click', () => go('library'));
    bar.appendChild(lib);
  }

  if (app.view !== 'home') {
    const back = el('button', 'btn btn-secondary btn-sm', '返回');
    back.addEventListener('click', () => {
      if (app.view === 'match' || app.view === 'champion') {
        if (!confirm('返回将结束当前赛事，确定吗？')) return;
        app.state = null;
        app.picked = null;
      }
      go('home');
    });
    bar.appendChild(back);
  }

  return bar;
}

/* ------------------------------------------------------------------ */
/* 开始页：三段式状态机（loading → ready → revealed）                    */
/* 见 DESIGN.md §7。挂载时播放背景音乐 + 开局后台预加载「人气」16 位的     */
/* 缩略图与视频片段；加载完成前只显示低品质占位图 + 玻璃模糊掩盖瑕疵。      */
/* ------------------------------------------------------------------ */

function viewSplash(main: HTMLElement): void {
  const wrap = el('div', `splash stage-${app.splash.stage}`);

  const bgPlaceholder = document.createElement('img');
  bgPlaceholder.className = 'splash-bg splash-bg-placeholder';
  bgPlaceholder.src = assetUrl('hero/splash-placeholder.jpg');
  bgPlaceholder.alt = '';
  bgPlaceholder.setAttribute('aria-hidden', 'true');
  wrap.appendChild(bgPlaceholder);

  const bgFull = document.createElement('img');
  bgFull.className = 'splash-bg splash-bg-full';
  bgFull.src = assetUrl('hero/splash-full.webp');
  bgFull.alt = '';
  bgFull.setAttribute('aria-hidden', 'true');
  wrap.appendChild(bgFull);

  // 开始页没有顶栏（见 render()），但音乐已经在放了——常驻一个小的静音键，
  // 不用先点进首页才能关掉背景音乐。和顶栏那颗按钮共用同一套全局状态
  // （card.ts 的 isMuted/setMuted + bgm.ts 的 setBgmMuted），不是独立开关
  const mute = el('button', 'splash-mute');
  mute.type = 'button';
  mute.setAttribute('aria-label', isMuted() ? '取消静音' : '静音');
  mute.innerHTML = isMuted() ? '🔇' : '🔊';
  mute.addEventListener('click', () => {
    setMuted(!isMuted());
    setBgmMuted(isMuted());
    mute.innerHTML = isMuted() ? '🔇' : '🔊';
    mute.setAttribute('aria-label', isMuted() ? '取消静音' : '静音');
  });
  wrap.appendChild(mute);

  if (app.splash.stage === 'revealed') {
    // 揭幕之后画面本身就是内容，标题/面板都不需要了，只留一个开始游戏
    // 按钮居中浮在清晰的插画上
    const cta = el('button', 'btn btn-primary btn-hero', '开始游戏');
    cta.type = 'button';
    // BGM 不在这里停：它是全站持续播放的背景音乐，不是开始页专属，
    // 见顶栏的全局静音开关（bgm.ts）
    cta.addEventListener('click', () => go('home'));
    wrap.appendChild(cta);
  } else {
    const panel = el('div', 'splash-panel');
    panel.appendChild(el('h1', 'splash-title', '猴女郎巅峰对决'));

    if (app.splash.stage === 'ready') {
      const ready = el('button', 'btn btn-primary splash-ready', 'Ready');
      ready.type = 'button';
      ready.setAttribute('aria-label', '素材已就绪，点击查看');
      ready.addEventListener('click', () => {
        ready.disabled = true;
        wrap.classList.add('is-revealing');
        window.setTimeout(() => {
          app.splash.stage = 'revealed';
          render();
        }, 520);
      });
      panel.appendChild(ready);
    } else {
      const ratio = app.splash.total ? app.splash.loaded / app.splash.total : 0;
      const progress = el('div', 'splash-progress');
      const fill = el('i');
      fill.style.width = `${Math.round(ratio * 100)}%`;
      progress.appendChild(fill);
      panel.appendChild(progress);
      panel.appendChild(
        el('div', 'splash-progress-label num', `正在准备 · ${Math.round(ratio * 100)}%`),
      );
    }

    wrap.appendChild(panel);
  }

  main.appendChild(wrap);
}

/**
 * 开局后台预加载：「人气」分类的 16 位视频片段 + 高清背景图，两者共用同一条
 * 阻塞进度（复用 preloader.loadBlocking，和 startPreload() 是同一套分层
 * 预加载机制，不是另起一套）。加载完成后把状态机推进到 'ready'，交给用户
 * 点击查看揭幕动效。
 */
async function startSplashPreload(): Promise<void> {
  const pool = poolFor(SPLASH_CATEGORY);
  const picks = (pool.length ? pool : contestants).slice(0, SPLASH_SIZE).map((c) => c.id);
  const urls = [assetUrl('hero/splash-full.webp'), ...clipUrls(picks)];

  app.splash.total = urls.length || 1;
  app.splash.loaded = 0;

  await preloader.loadBlocking(urls, (p) => {
    app.splash.loaded = p.loaded;
    app.splash.total = p.total;
    if (app.view !== 'splash') return; // 用户可能已经手动跳过（理论上不会发生，防御一下）
    const ratio = p.total ? p.loaded / p.total : 0;
    const fill = document.querySelector<HTMLElement>('.splash-progress > i');
    const label = document.querySelector<HTMLElement>('.splash-progress-label');
    if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
    if (label) label.textContent = `正在准备 · ${Math.round(ratio * 100)}%`;
  });

  if (app.view !== 'splash') return;
  app.splash.stage = 'ready';
  render();
}

/* ------------------------------------------------------------------ */
/* 首页：赛制配置                                                       */
/* ------------------------------------------------------------------ */

function viewHome(main: HTMLElement): void {
  main.appendChild(el('h1', 'page-title', '选择赛事规模'));

  const stack = el('div', 'stack');

  // 抽取方式
  const modeRow = el('div', 'chip-row');
  (
    [
      ['random', '🎲 随机抽取'],
      ['manual', '✅ 自选参赛'],
    ] as const
  ).forEach(([m, label]) => {
    const c = el('button', `chip ${app.mode === m ? 'is-on' : ''}`, label);
    c.addEventListener('click', () => {
      app.mode = m;
      render();
    });
    modeRow.appendChild(c);
  });
  stack.appendChild(modeRow);

  // 分类筛选先不放出来：人气目前只有 16 位、新锐连 16 都不到，跟"分类 + 规模"
  // 组合在一起很容易凑不出一场比赛，索性首页不提供这个选项。选手库涨到能撑起
  // 分类筛选的规模之后，把上面这段 chip 渲染逻辑加回来就行（app.category 这
  // 条状态还在，poolFor/createTournament 都照常支持，只是没有 UI 去设置它）。

  const pool = poolFor(app.category);

  if (app.mode === 'manual') {
    const btn = el('button', 'btn btn-primary', `去挑选（共 ${pool.length} 位）`);
    btn.disabled = pool.length < 2;
    btn.addEventListener('click', () => {
      app.selection = new Set();
      go('picker');
    });
    stack.appendChild(btn);
    stack.appendChild(el('p', 'prose', '自由挑选参赛选手，落单的一位会轮空晋级'));
  } else {
    const grid = el('div', 'size-grid');
    for (const size of SIZES) {
      const b = el('button', 'size-btn');
      b.innerHTML = `${size} 位<small>${pool.length < size ? `库存不足（${pool.length}）` : '随机抽取'}</small>`;
      b.disabled = pool.length < size;
      b.addEventListener('click', () => {
        const s = createTournament(
          pool.map((c) => c.id),
          size,
          app.category,
        );
        app.state = s;
        app.picked = null;
        startPreload(s);
      });
      grid.appendChild(b);
    }
    stack.appendChild(grid);
    stack.appendChild(
      el('p', 'prose', `将从选手库中随机抽取。当前有 ${pool.length} 位候选者`),
    );
  }

  main.appendChild(stack);
}

/* ------------------------------------------------------------------ */
/* 自选参赛                                                            */
/* ------------------------------------------------------------------ */

function viewPicker(main: HTMLElement): void {
  main.appendChild(el('h1', 'page-title', '自选参赛'));
  main.appendChild(searchBox());

  const pool = poolFor(app.category).filter((c) =>
    app.query ? c.name.toLowerCase().includes(app.query.toLowerCase()) : true,
  );

  const grid = el('div', 'grid');
  for (const c of pool) {
    const card = createCard(c, {
      showCategory: true,
      onSelect: (x) => {
        if (app.selection.has(x.id)) app.selection.delete(x.id);
        else app.selection.add(x.id);
        card.classList.toggle('is-picked', app.selection.has(x.id));
        count.textContent = `已选 ${app.selection.size} 位`;
        startBtn.disabled = app.selection.size < 2;
      },
    });
    card.classList.toggle('is-picked', app.selection.has(c.id));
    grid.appendChild(card);
  }
  if (!pool.length) grid.appendChild(el('div', 'empty', '没有匹配的选手'));
  main.appendChild(grid);

  const bar = el('div', 'pick-bar');
  const count = el('span', 'pick-count', `已选 ${app.selection.size} 位`);
  const clear = el('button', 'btn btn-secondary btn-sm', '清空');
  clear.addEventListener('click', () => {
    app.selection.clear();
    render();
  });
  const startBtn = el('button', 'btn btn-primary', '开赛');
  startBtn.disabled = app.selection.size < 2;
  startBtn.addEventListener('click', () => {
    const s = createTournament([...app.selection], app.selection.size, app.category);
    app.state = s;
    app.picked = null;
    startPreload(s);
  });
  bar.append(count, clear, startBtn);
  main.appendChild(bar);
}

function searchBox(): HTMLElement {
  const wrap = el('div', 'search');
  const input = el('input');
  input.type = 'search';
  input.placeholder = '搜索选手名字';
  input.value = app.query;

  // 中文这类输入法要经过"拼音候选 → 选字确认"的组合输入过程（compositionstart
  // 到 compositionend 之间）。如果这期间跟着每个 input 事件整页 render()，
  // <input> 节点会被销毁重建，组合输入被打断，中文根本打不出来。
  // 所以组合期间不重渲染，等 compositionend 选字确认了再刷新结果。
  let composing = false;
  const commit = (): void => {
    app.query = input.value;
    render();
    // 重绘后把焦点和光标还回去
    const next = document.querySelector<HTMLInputElement>('.search input');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  };
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    commit();
  });
  input.addEventListener('input', (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    commit();
  });
  wrap.appendChild(input);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* 加载闸门                                                            */
/* ------------------------------------------------------------------ */

function viewGate(main: HTMLElement): void {
  const g = el('div', 'gate');
  g.appendChild(el('div', 'gate-title', app.gate.label));

  const bar = el('div', 'progress');
  const fill = el('i');
  const ratio = app.gate.total ? app.gate.loaded / app.gate.total : 0;
  fill.style.width = `${Math.round(ratio * 100)}%`;
  bar.appendChild(fill);
  g.appendChild(bar);

  g.appendChild(el('div', 'gate-sub', `${app.gate.loaded} / ${app.gate.total}`));
  main.appendChild(g);
}

/**
 * 分层预加载：首场片段阻塞，其余片段后台铺。
 * 进度条只反映阻塞部分，不然用户会盯着一个永远走不完的条。
 */
async function startPreload(s: TournamentState): Promise<void> {
  const ids = upcomingIds(s);
  const pair = currentPair(s);
  const blocking = pair ? clipUrls(pair) : [];
  app.gate = {
    loaded: 0,
    total: blocking.length || 1,
    label: `正在准备 ${s.size} 位选手`,
  };
  go('gate');

  await preloader.loadBlocking(blocking, (p) => {
    app.gate.loaded = p.loaded;
    app.gate.total = p.total;
    const fill = document.querySelector<HTMLElement>('.progress > i');
    const sub = document.querySelector<HTMLElement>('.gate-sub');
    if (fill) fill.style.width = `${Math.round(p.ratio * 100)}%`;
    if (sub) sub.textContent = `${p.loaded} / ${p.total}`;
  });

  // 剩下的片段按出场顺序后台铺，用户看片的空档里就下完了
  preloader.enqueue(clipUrls(ids));
  go('match');
}

/* ------------------------------------------------------------------ */
/* PK 页                                                               */
/* ------------------------------------------------------------------ */

function viewMatch(main: HTMLElement): void {
  const s = app.state;
  if (!s) return go('home');
  if (s.championId) return go('champion');

  const pair = currentPair(s);
  if (!pair) return go('champion');

  const a = get(pair[0]);
  const b = get(pair[1]);
  if (!a || !b) {
    showToast('选手数据缺失，已重置赛事');
    app.state = null;
    return go('home');
  }

  const head = el('div', 'round-head');
  head.appendChild(el('h2', 'round-title', currentRoundName(s)));
  const idx = playableIndex(s);
  const cnt = playableCount(s);
  head.appendChild(el('div', 'round-sub num', `第 ${idx}/${cnt} 场 · 请选择 1 位晋级`));
  const bar = el('div', 'round-bar');
  const fill = el('i');
  fill.style.width = `${cnt ? ((idx - 1) / cnt) * 100 : 0}%`;
  bar.appendChild(fill);
  head.appendChild(bar);
  main.appendChild(head);

  const match = el('div', 'match');
  const cards = new Map<string, HTMLElement>();

  const onSelect = (c: Contestant): void => {
    app.picked = app.picked === c.id ? null : c.id;
    for (const [id, node] of cards) node.classList.toggle('is-picked', app.picked === id);
    confirm.disabled = app.picked === null;
  };

  for (const c of [a, b]) {
    const card = createCard(c, { showCategory: true, onSelect });
    card.classList.toggle('is-picked', app.picked === c.id);
    cards.set(c.id, card);
  }

  match.appendChild(cards.get(a.id)!);
  match.appendChild(el('div', 'vs', 'VS'));
  match.appendChild(cards.get(b.id)!);
  main.appendChild(match);

  const barWrap = el('div', 'confirm-bar');
  const confirm = el('button', 'btn btn-confirm', '确认选择');
  confirm.disabled = app.picked === null;
  confirm.addEventListener('click', () => {
    if (!app.picked) {
      showToast('先选一位再确认');
      return;
    }
    stopActiveClip();
    pickWinner(s, app.picked);
    app.picked = null;

    if (s.championId) {
      go('champion');
      return;
    }
    // 把下一场的两条片段顶到队首
    const next = currentPair(s);
    if (next) preloader.prioritize(clipUrls(next));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  barWrap.appendChild(confirm);
  main.appendChild(barWrap);
}

/* ------------------------------------------------------------------ */
/* 冠军页                                                              */
/* ------------------------------------------------------------------ */

function viewChampion(main: HTMLElement): void {
  const s = app.state;
  if (!s?.championId) return go('home');
  const champ = get(s.championId);
  if (!champ) return go('home');

  const wrap = el('div', 'champion');
  wrap.appendChild(el('div', 'trophy', '🏆'));

  // 冠军卡也用同一套卡片组件，片段照样是点了才播
  const card = createCard(champ, {});
  card.classList.add('is-champion');
  wrap.appendChild(card);

  // 名字和播报文案合并成一行，不再重复显示——名字只在句子里用金色高亮出来
  const { prefix, suffix } = championAnnouncement(champ);
  const announce = el('div', 'champion-announce');
  announce.append(prefix, el('span', 'champion-name', champ.name), suffix);
  wrap.appendChild(announce);
  if (champ.championLine) wrap.appendChild(el('div', 'champion-line', champ.championLine));

  const path = s.history.filter((h) => h.winnerId === s.championId && h.loserId);
  if (path.length) {
    const box = el('div', 'path');
    box.appendChild(el('h3', undefined, '晋级之路'));

    const flow = el('div', 'path-flow');
    for (const m of path) {
      const node = el('div', 'path-node');
      node.appendChild(el('span', 'path-node-dot'));
      const body = el('div', 'path-node-body');
      body.appendChild(el('span', 'path-node-round', m.roundName));
      const beat = el('span', 'path-node-beat');
      beat.innerHTML = `击败 <b></b>`;
      beat.querySelector('b')!.textContent = get(m.loserId!)?.name ?? '—';
      body.appendChild(beat);
      node.appendChild(body);
      flow.appendChild(node);
    }
    // 收尾节点：夺冠本身，让"晋级之路"在视觉上是一条真正流向冠军的线，
    // 不是打完就断在最后一场
    const champNode = el('div', 'path-node path-node-champion');
    champNode.appendChild(el('span', 'path-node-dot'));
    const champBody = el('div', 'path-node-body');
    champBody.appendChild(el('span', 'path-node-round', '🏆 夺冠'));
    const champBeat = el('span', 'path-node-beat');
    champBeat.innerHTML = `<b></b>`;
    champBeat.querySelector('b')!.textContent = champ.name;
    champBody.appendChild(champBeat);
    champNode.appendChild(champBody);
    flow.appendChild(champNode);

    box.appendChild(flow);
    wrap.appendChild(box);
  }

  const row = el('div', 'btn-row');
  const again = el('button', 'btn btn-primary', '再来一场');
  again.addEventListener('click', () => {
    app.state = null;
    app.picked = null;
    go('home');
  });
  row.append(again);
  wrap.appendChild(row);

  wrap.appendChild(creditsBlock());

  main.appendChild(wrap);
  spawnConfetti();
}

/** 头像 + ID 的小胶囊，只放这两样，不放平台简介 */
function creditCard(p: { name: string; role: string; avatar: string }): HTMLElement {
  const item = el('div', 'credit-card');

  const avatar = document.createElement('img');
  avatar.className = 'credit-avatar';
  avatar.src = assetUrl(p.avatar);
  avatar.alt = p.name;
  avatar.loading = 'lazy';
  item.appendChild(avatar);

  const meta = el('div', 'credit-meta');
  meta.appendChild(el('div', 'credit-name', p.name));
  meta.appendChild(el('div', 'credit-role', p.role));
  item.appendChild(meta);

  return item;
}

/**
 * 两列：左边「作者」（网站作者本人），右边「鸣谢」（视频素材提供者，竖排）。
 * 两个标题钉在同一条水平线上——两列都是「标题在前、卡片在后」的纵向结构，
 * 用一个 flex 行把两列并排放，标题自然对齐，不需要额外的对齐 hack。
 * 只放头像 + ID，不放平台简介——简介是各自平台上的个人签名，和"这个网站/
 * 这场比赛是谁做的"无关，是噪音（见 DESIGN.md §4「创作者致谢卡」）。
 */
function creditsBlock(): HTMLElement {
  const box = el('div', 'credits');

  const authorCol = el('div', 'credits-col');
  authorCol.appendChild(el('h3', 'credits-title', '作者'));
  authorCol.appendChild(creditCard(AUTHOR));
  box.appendChild(authorCol);

  const thanksCol = el('div', 'credits-col');
  thanksCol.appendChild(el('h3', 'credits-title', '鸣谢'));
  const grid = el('div', 'credits-grid');
  for (const p of CREDITS) grid.appendChild(creditCard(p));
  thanksCol.appendChild(grid);
  box.appendChild(thanksCol);

  return box;
}

function spawnConfetti(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.confetti')?.remove();
  const box = el('div', 'confetti');
  const colors = ['#f5c542', '#ff3d7f', '#ff8ab4', '#ffffff', '#3ddc97'];
  for (let i = 0; i < 120; i++) {
    const p = el('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${2 + Math.random() * 2}s`;
    p.style.animationDelay = `${Math.random() * 0.8}s`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  window.setTimeout(() => box.remove(), 5200);
}

/* ------------------------------------------------------------------ */
/* 选手库                                                              */
/* ------------------------------------------------------------------ */

function viewLibrary(main: HTMLElement): void {
  main.appendChild(el('h1', 'page-title', '选手库'));
  main.appendChild(searchBox());

  if (categories.length) {
    const catRow = el('div', 'chip-row');
    catRow.style.marginBottom = 'var(--sp-5)';
    const all = el('button', `chip ${app.libCategory === null ? 'is-on' : ''}`, '不限');
    all.addEventListener('click', () => {
      app.libCategory = null;
      render();
    });
    catRow.appendChild(all);
    for (const cat of categories) {
      const c = el('button', `chip ${app.libCategory === cat ? 'is-on' : ''}`, cat);
      c.addEventListener('click', () => {
        app.libCategory = cat;
        render();
      });
      catRow.appendChild(c);
    }
    main.appendChild(catRow);
  }

  const q = app.query.trim().toLowerCase();
  const list = contestants.filter(
    (c) =>
      (!app.libCategory || c.category === app.libCategory) &&
      (!q || c.name.toLowerCase().includes(q)),
  );

  main.appendChild(el('p', 'prose', `共 ${list.length} 位 · 点图片看视频`));

  const grid = el('div', 'grid');
  grid.style.marginTop = 'var(--sp-5)';
  for (const c of list) grid.appendChild(createCard(c, { showCategory: true }));
  if (!list.length) grid.appendChild(el('div', 'empty', '没有匹配的选手'));
  main.appendChild(grid);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function render(): void {
  root.innerHTML = '';
  const shell = el('div', 'app');
  // 开始页是全屏 hero，不带标准顶栏——那套"返回/选手库/静音"导航在
  // 用户还没进入赛制配置之前没有意义，且会破坏通屏视觉
  if (app.view !== 'splash') shell.appendChild(topbar());

  // 赛制配置页内容偏少，撑不满整屏，垂直居中比顶着标准页面顶部堆着好看
  let mainClass = 'main';
  if (app.view === 'splash') mainClass = 'main main-flush';
  else if (app.view === 'home') mainClass = 'main main-centered';
  const main = el('main', mainClass);
  switch (app.view) {
    case 'splash':
      viewSplash(main);
      break;
    case 'home':
      viewHome(main);
      break;
    case 'picker':
      viewPicker(main);
      break;
    case 'gate':
      viewGate(main);
      break;
    case 'match':
      viewMatch(main);
      break;
    case 'champion':
      viewChampion(main);
      break;
    case 'library':
      viewLibrary(main);
      break;
  }
  shell.appendChild(main);
  root.appendChild(shell);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  root.innerHTML = '<div class="gate"><div class="gate-title">正在载入选手库…</div></div>';
  try {
    await loadData();
  } catch (e) {
    root.innerHTML = `<div class="gate"><div class="gate-title">选手库加载失败</div><div class="gate-sub">${
      e instanceof Error ? e.message : String(e)
    }</div></div>`;
    return;
  }

  if (!contestants.length) {
    root.innerHTML =
      '<div class="gate"><div class="gate-title">选手库是空的</div><div class="gate-sub">往 public/data/contestants.json 里加选手</div></div>';
    return;
  }

  render();

  // 开始页：挂载即尝试播放背景音乐（除非用户之前设过全局静音；自动播放
  // 被拦截时的兜底见 bgm.ts 注释），同时后台预加载「人气」16 位的片段，
  // 加载完才允许点开始游戏（DESIGN.md §9）
  if (app.view === 'splash') {
    setBgmMuted(isMuted());
    void startSplashPreload();
  }
}

void boot();
