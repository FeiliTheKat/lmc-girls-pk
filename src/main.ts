import './style.css';
import type { Contestant, GroupStageState, RedemptionState, TournamentState } from './types';
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
import {
  confirmGroup,
  createGroupStage,
  currentGroup,
  GROUP_QUALIFIERS_PER_GROUP,
  GROUP_SIZE,
  isGroupStageDone,
} from './groupStage';
import {
  createRedemption,
  currentRedemptionPair,
  isRedemptionDone,
  pickRedemptionWinner,
} from './redemption';
import { createCard, isMuted, setMuted, showToast, stopActiveClip } from './card';
import { setBgmMuted, skipToNextTrack } from './bgm';
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

type View =
  | 'splash'
  | 'home'
  | 'picker'
  | 'gate'
  | 'match'
  | 'champion'
  | 'library'
  | 'groupDraw'
  | 'group'
  | 'redemption';

interface App {
  view: View;
  mode: 'random' | 'manual';
  category: string | null;
  /** 自选参赛的勾选集合 */
  selection: Set<string>;
  state: TournamentState | null;
  /** 当前这场选中的选手（PK 页 / 复活赛共用） */
  picked: string | null;
  gate: { loaded: number; total: number; label: string };
  query: string;
  libCategory: string | null;
  /** 开始页三段式状态机，见 DESIGN.md §7 */
  splash: { stage: 'loading' | 'ready' | 'revealed'; loaded: number; total: number };
  /** 小组赛世界杯模式：小组赛阶段状态，见 groupStage.ts */
  group: GroupStageState | null;
  /** 小组赛世界杯模式：复活赛阶段状态，见 redemption.ts */
  redemption: RedemptionState | null;
  /** 小组赛当前这组已勾选的 id（必须精确选够 GROUP_QUALIFIERS_PER_GROUP 个才能确认） */
  groupPicked: Set<string>;
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
  group: null,
  redemption: null,
  groupPicked: new Set(),
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
  persistCup();
  render();
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ */
/* 断点续赛（localStorage）                                             */
/* 覆盖随机抽取/自选参赛的普通淘汰赛，以及小组赛世界杯模式的三个阶段——      */
/* types.ts 里早先那条"天然可 JSON 序列化，直接 setItem 即可"的注释，       */
/* 一直没真正落地，这里补上。                                            */
/* ------------------------------------------------------------------ */

const CUP_STORAGE_KEY = 'mgc:cup';
/** 只有这些 view 代表"进行中的赛事"，值得存档；其余 view（首页/选手库/挑选
 *  页等）没有需要恢复的中途状态，进入时应该清掉旧档，避免残留一场废弃的赛事 */
const RESUMABLE_VIEWS: readonly View[] = ['groupDraw', 'group', 'redemption', 'match', 'champion'];

interface CupSnapshot {
  view: View;
  state: TournamentState | null;
  group: GroupStageState | null;
  redemption: RedemptionState | null;
}

function persistCup(): void {
  try {
    if (!RESUMABLE_VIEWS.includes(app.view)) {
      localStorage.removeItem(CUP_STORAGE_KEY);
      return;
    }
    const snapshot: CupSnapshot = {
      view: app.view,
      state: app.state,
      group: app.group,
      redemption: app.redemption,
    };
    localStorage.setItem(CUP_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 隐私模式/容量已满时 localStorage 可能不可用，静默放弃持久化，不影响当场游玩
  }
}

/** 存档里出现的所有选手 id，用来校验选手库改版后旧存档要能优雅失效 */
function snapshotIds(snap: CupSnapshot): string[] {
  const fromPairs = (pairs?: readonly [string, string | null][]) =>
    (pairs ?? []).flat().filter((x): x is string => !!x);
  return [
    ...fromPairs(snap.state?.pairs),
    ...(snap.state?.winners ?? []),
    ...(snap.group?.groups.flat() ?? []),
    ...fromPairs(snap.redemption?.pairs),
  ];
}

/** 尝试从 localStorage 恢复上次未完成的赛事；成功返回 true */
function restoreCup(): boolean {
  try {
    const raw = localStorage.getItem(CUP_STORAGE_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw) as CupSnapshot;
    if (!snap || typeof snap !== 'object' || !RESUMABLE_VIEWS.includes(snap.view)) return false;
    if (snapshotIds(snap).some((id) => !get(id))) return false;

    app.view = snap.view;
    app.state = snap.state;
    app.group = snap.group;
    app.redemption = snap.redemption;
    return true;
  } catch {
    return false;
  }
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
  // 不搞两套互相独立的静音状态（见 bgm.ts 顶部注释）。加了 sound-toggle 类
  // 是因为迷你播放器的暂停/播放键控制的是同一个状态，两个按钮点击后要互相
  // 同步文字，见 syncSoundControls()
  const sound = el('button', 'btn btn-secondary btn-sm sound-toggle', isMuted() ? '🔇 静音' : '🔊 有声');
  sound.addEventListener('click', () => {
    setMuted(!isMuted());
    setBgmMuted(isMuted());
    syncSoundControls();
  });
  bar.appendChild(sound);
  bar.appendChild(bgmPlayer());

  if (app.view !== 'library') {
    const lib = el('button', 'btn btn-secondary btn-sm', '选手库');
    lib.addEventListener('click', () => go('library'));
    bar.appendChild(lib);
  }

  if (app.view !== 'home') {
    const back = el('button', 'btn btn-secondary btn-sm', '返回');
    back.addEventListener('click', () => {
      if (RESUMABLE_VIEWS.includes(app.view)) {
        if (!confirm('返回将结束当前赛事，确定吗？')) return;
        app.state = null;
        app.group = null;
        app.redemption = null;
        app.picked = null;
        app.groupPicked = new Set();
      }
      go('home');
    });
    bar.appendChild(back);
  }

  return bar;
}

/**
 * 顶栏迷你 BGM 播放器：暂停/播放 + 切歌两颗图标按钮，不显示曲名。暂停按钮
 * 复用的还是那唯一一个全局静音状态（isMuted/setMuted/setBgmMuted）——没有
 * 另建一个"只暂停音乐、不影响选手视频音量"的独立状态。以前这个项目确实
 * 单独做过一颗 BGM 专属暂停键，后来产品所有者主动要求合并回统一开关，理由
 * 是两套独立的声音状态互相打架、容易把用户搞糊涂（见 PRD.md §六·21）——这里
 * 不重蹈那条覆辙，只是把同一个开关也摆进迷你播放器里、换成播放器味儿更足
 * 的 ⏸/▶ 图标，点哪颗按钮都会通过 syncSoundControls() 互相同步文字。
 */
function bgmPlayer(): HTMLElement {
  const wrap = el('div', 'bgm-player');

  const pause = el('button', 'btn btn-secondary btn-sm bgm-pause-btn', isMuted() ? '▶' : '⏸');
  pause.type = 'button';
  pause.setAttribute('aria-label', isMuted() ? '继续播放背景音乐' : '暂停背景音乐');
  pause.addEventListener('click', () => {
    setMuted(!isMuted());
    setBgmMuted(isMuted());
    syncSoundControls();
  });
  wrap.appendChild(pause);

  const skip = el('button', 'btn btn-secondary btn-sm bgm-skip-btn', '⏭');
  skip.type = 'button';
  skip.setAttribute('aria-label', '切换下一首背景音乐');
  skip.addEventListener('click', () => skipToNextTrack());
  wrap.appendChild(skip);

  return wrap;
}

/** 顶栏"🔊 有声 / 🔇 静音"按钮和迷你播放器的暂停/播放按钮控制的是同一个全局
 *  状态，点任意一个之后都要把另一个的文字也刷新过来，不然两颗按钮会显示
 *  不一致的状态 */
function syncSoundControls(): void {
  const sound = document.querySelector<HTMLElement>('.sound-toggle');
  if (sound) sound.textContent = isMuted() ? '🔇 静音' : '🔊 有声';
  const pause = document.querySelector<HTMLElement>('.bgm-pause-btn');
  if (pause) {
    pause.textContent = isMuted() ? '▶' : '⏸';
    pause.setAttribute('aria-label', isMuted() ? '继续播放背景音乐' : '暂停背景音乐');
  }
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
  main.appendChild(groupModeSection());
}

/**
 * 小组赛世界杯模式的入口区块：全员分组 → 小组赛 4 选 2 → 复活赛捞回遗珠 →
 * 淘汰赛决出冠军，赛制细节见 groupStage.ts / redemption.ts。固定使用全部
 * 选手（不受上面「随机抽取/自选参赛」的模式、分类选择影响），只有候选总数
 * 是 GROUP_SIZE 的整数倍时才能开赛——分组逻辑假设每组都是满编的 4 人。
 */
function groupModeSection(): HTMLElement {
  const box = el('div', 'stack group-mode');
  box.appendChild(el('div', 'divider', '或'));

  const all = poolFor(null);
  const ready = all.length >= GROUP_SIZE * 2 && all.length % GROUP_SIZE === 0;

  const cta = el('div', 'cta-badge-wrap');
  const btn = el(
    'button',
    'btn btn-primary btn-recommended',
    `🌍 小组赛世界杯模式（全部 ${all.length} 位）`,
  );
  btn.disabled = !ready;
  btn.addEventListener('click', () => {
    app.group = createGroupStage(all.map((c) => c.id));
    app.redemption = null;
    app.state = null;
    go('groupDraw');
  });
  cta.append(el('span', 'cta-badge', '推荐'), btn);
  box.appendChild(cta);
  box.appendChild(
    el(
      'p',
      'prose',
      ready
        ? `完整世界杯赛制：${all.length / GROUP_SIZE} 个小组 → 复活赛捞回遗珠 → 淘汰赛决出冠军`
        : `小组赛模式需要选手总数是 ${GROUP_SIZE} 的整数倍，当前 ${all.length} 位暂不满足`,
    ),
  );
  return box;
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
/* 小组赛世界杯模式：分组抽签 → 小组赛（4 选 2） → 复活赛 → 淘汰赛           */
/* 赛制说明见 groupStage.ts / redemption.ts 头部注释                     */
/* ------------------------------------------------------------------ */

function groupLabel(i: number): string {
  return String.fromCharCode(65 + i); // 0→A, 1→B, ...
}

/** 大于等于 n 的最小 2 的整数次幂（淘汰赛必须是这个规模，才能一路打到只剩 1 人） */
function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** 小组赛抽签结果展示页：仿 musiccup.app 的「分组抽签完毕」 */
function viewGroupDraw(main: HTMLElement): void {
  const gs = app.group;
  if (!gs) return go('home');

  main.appendChild(el('h1', 'page-title', '分组抽签完毕'));
  main.appendChild(
    el(
      'p',
      'prose',
      `${gs.groups.length * GROUP_SIZE} 位选手分成 ${gs.groups.length} 组，每组选出 ${GROUP_QUALIFIERS_PER_GROUP} 位直通；落选的选手会在复活赛里再战一次`,
    ),
  );

  const list = el('div', 'group-list');
  gs.groups.forEach((group, i) => {
    const box = el('div', 'group-box');
    box.appendChild(el('h3', 'group-box-title', `${groupLabel(i)} 组`));
    const names = el('div', 'group-box-names');
    for (const id of group) names.appendChild(el('span', 'group-box-name', get(id)?.name ?? id));
    box.appendChild(names);
    list.appendChild(box);
  });
  main.appendChild(list);

  const start = el('button', 'btn btn-primary', '开始小组赛');
  start.addEventListener('click', () => {
    app.groupPicked = new Set();
    go('group');
  });
  main.appendChild(start);
}

/** 小组赛投票页：一屏 4 人，一次性勾选喜欢的 2 位直通（不是两两对战） */
function viewGroup(main: HTMLElement): void {
  const gs = app.group;
  if (!gs) return go('home');
  if (isGroupStageDone(gs)) return finishGroupStage();

  const group = currentGroup(gs);
  if (!group) return go('home');

  const head = el('div', 'round-head');
  head.appendChild(el('h2', 'round-title', `小组赛 · ${groupLabel(gs.groupIndex)} 组`));
  head.appendChild(
    el(
      'div',
      'round-sub num',
      `第 ${gs.groupIndex + 1}/${gs.groups.length} 组 · 选出更喜欢的 ${GROUP_QUALIFIERS_PER_GROUP} 位直通`,
    ),
  );
  const bar = el('div', 'round-bar');
  const fill = el('i');
  fill.style.width = `${(gs.groupIndex / gs.groups.length) * 100}%`;
  bar.appendChild(fill);
  head.appendChild(bar);
  main.appendChild(head);

  const grid = el('div', 'grid group-grid');
  for (const id of group) {
    const c = get(id);
    if (!c) continue;
    const card = createCard(c, {
      showCategory: true,
      onSelect: (x) => {
        if (app.groupPicked.has(x.id)) {
          app.groupPicked.delete(x.id);
        } else if (app.groupPicked.size < GROUP_QUALIFIERS_PER_GROUP) {
          app.groupPicked.add(x.id);
        } else {
          showToast(`最多选 ${GROUP_QUALIFIERS_PER_GROUP} 位，先取消一位再选新的`);
          return;
        }
        card.classList.toggle('is-picked', app.groupPicked.has(x.id));
        count.textContent = `已选 ${app.groupPicked.size} / ${GROUP_QUALIFIERS_PER_GROUP}`;
        confirmBtn.disabled = app.groupPicked.size !== GROUP_QUALIFIERS_PER_GROUP;
      },
    });
    card.classList.toggle('is-picked', app.groupPicked.has(id));
    grid.appendChild(card);
  }
  main.appendChild(grid);

  const barWrap = el('div', 'confirm-bar');
  const count = el(
    'span',
    'pick-count',
    `已选 ${app.groupPicked.size} / ${GROUP_QUALIFIERS_PER_GROUP}`,
  );
  const confirmBtn = el('button', 'btn btn-confirm', '确认晋级');
  confirmBtn.disabled = app.groupPicked.size !== GROUP_QUALIFIERS_PER_GROUP;
  confirmBtn.addEventListener('click', () => {
    confirmGroup(gs, [...app.groupPicked]);
    app.groupPicked = new Set();
    persistCup();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  barWrap.append(count, confirmBtn);
  main.appendChild(barWrap);
}

/** 小组赛 10 组全部选完后调用：算出复活赛要捞回几人，进复活赛或直接进淘汰赛 */
function finishGroupStage(): void {
  const gs = app.group;
  if (!gs) {
    go('home');
    return;
  }

  const knockoutSize = nextPowerOfTwo(gs.qualifiers.length);
  const reviveTarget = knockoutSize - gs.qualifiers.length;

  if (reviveTarget <= 0) {
    startKnockout(knockoutSize);
    return;
  }

  app.redemption = createRedemption(gs.losers, reviveTarget);
  app.picked = null;
  if (isRedemptionDone(app.redemption)) {
    // 极端情况：复活赛无需任何真实对战（losers 数量恰好等于 reviveTarget），
    // 全员直接轮空复活，跳过复活赛投票页
    startKnockout(knockoutSize);
    return;
  }
  go('redemption');
}

/** 复活赛投票页：和 viewMatch 一样是两两对战，只是数据源换成复活赛的一轮对阵表 */
function viewRedemption(main: HTMLElement): void {
  const r = app.redemption;
  if (!r) return go('home');
  if (isRedemptionDone(r)) {
    const gs = app.group;
    const knockoutSize = nextPowerOfTwo((gs?.qualifiers.length ?? 0) + r.revived.length);
    startKnockout(knockoutSize);
    return;
  }

  const pair = currentRedemptionPair(r);
  if (!pair) return go('home');

  const a = get(pair[0]);
  const b = get(pair[1]);
  if (!a || !b) {
    showToast('选手数据缺失，已重置赛事');
    app.group = null;
    app.redemption = null;
    return go('home');
  }

  const head = el('div', 'round-head');
  head.appendChild(el('h2', 'round-title', '复活赛 · 遗珠再战'));
  const idx = playableIndex(r);
  const cnt = playableCount(r);
  head.appendChild(el('div', 'round-sub num', `第 ${idx}/${cnt} 场 · 选出 1 位复活`));
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
    confirmBtn.disabled = app.picked === null;
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
  const confirmBtn = el('button', 'btn btn-confirm', '确认复活');
  confirmBtn.disabled = app.picked === null;
  confirmBtn.addEventListener('click', () => {
    if (!app.picked) {
      showToast('先选一位再确认');
      return;
    }
    stopActiveClip();
    pickRedemptionWinner(r, app.picked);
    app.picked = null;
    persistCup();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  barWrap.appendChild(confirmBtn);
  main.appendChild(barWrap);
}

/** 小组赛直通者 + 复活赛复活者 拼成完整名单，交给现有淘汰赛引擎原样打完全程 */
function startKnockout(size: number): void {
  const gs = app.group;
  const revived = app.redemption?.revived ?? [];
  const ids = [...(gs?.qualifiers ?? []), ...revived];
  const s = createTournament(ids, ids.length || size, null);
  app.state = s;
  app.group = null;
  app.redemption = null;
  app.picked = null;
  startPreload(s);
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
    persistCup();

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
    case 'groupDraw':
      viewGroupDraw(main);
      break;
    case 'group':
      viewGroup(main);
      break;
    case 'redemption':
      viewRedemption(main);
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

  // 有未完成的赛事存档（普通淘汰赛或小组赛世界杯模式的任一阶段）就直接恢复
  // 到那一步，跳过开始页——刷新页面/关掉标签页不该让整场比赛清零
  if (restoreCup()) {
    render();
    setBgmMuted(isMuted());
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
