/**
 * 全站背景音乐——从开始页挂载时起持续播放，不是开始页专属。静音/暂停/
 * 切歌这一整套控制**只管 BGM 自己**，不影响选手视频片段的音量——两者
 * 以前共用过同一个全局静音开关（见 PRD.md §六·21 那次"合并回统一开关"
 * 的决定），2026-08-17 产品所有者明确要求"这些只控制 bgm，不对视频造成
 * 任何控制"，拆开成两套独立状态：选手视频片段现在永远带声播放（见
 * card.ts 的 toggleActive，不再读任何全局静音标志），这里的 muted 状态
 * 只属于 BGM 自己，静音偏好存在 localStorage、和视频那边完全无关。
 *
 * 三首歌轮播（PLAYLIST）：不是各自单曲循环，是一首放完自动接下一首，到
 * 结尾绕回第一首。播放位置不做跨刷新持久化——和原来单曲循环一样，每次
 * 新开页面都从歌单第一首、从头播。数组顺序就是播放顺序，和文件名编号不必
 * 一一对应（bgm-3.mp4 是后加的第三首，但排在队列最前面，产品所有者要求的）
 *
 * 播放选手视频片段时 BGM 不受任何影响：不暂停、不压低音量——两条音轨各自
 * 按自己的音量播放，互不干预（同一天试过压低音量的 duck 方案又被撤回，见
 * PRD.md §六·38/39）。
 *
 * 浏览器只允许静音自动播放，带声音的自动播放大概率被拦截——这不是 bug，
 * 是所有主流浏览器的统一行为。兜底：播放被拒绝后监听下一次用户手势
 * （点击/按键/触摸），在那次手势的同一个事件循环里补播。
 */

import { assetUrl } from './data';

const PLAYLIST = ['audio/bgm-3.mp4', 'audio/bgm-1.mp4', 'audio/bgm-2.mp4'];

// 播放音量；原按 ~9dB 降到 0.2，产品所有者 2026-08-17 反馈偏小调到 0.35
// （约 +5dB，比最初的 0.55 仍明显更低）。视频片段播放时不再压低这个值——
// 试过 0.05 的闪避音量，产品所有者要求撤回："不要压低音量，本来就不高"
const BASE_VOLUME = 0.35;

// BGM 专属的静音偏好，只属于这个模块——不再和选手视频片段共用同一个
// localStorage key（那个 key 曾经是 card.ts 的 isMuted/setMuted 在管）
const MUTE_KEY = 'mgc:bgm-muted';

let audio: HTMLAudioElement | null = null;
let trackIndex = 0;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();
let retryCleanup: (() => void) | null = null;

function loadTrack(el: HTMLAudioElement): void {
  el.src = assetUrl(PLAYLIST[trackIndex]);
}

function ensure(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    // 单曲不循环——播完交给 'ended' 监听器切下一首，见下方 skipToNextTrack()
    audio.loop = false;
    audio.volume = BASE_VOLUME;
    audio.addEventListener('ended', skipToNextTrack);
    loadTrack(audio);
  }
  return audio;
}

/**
 * 切到歌单下一首（到底则绕回第一首）。一首自然放完（audio 的 'ended' 事件）
 * 和顶栏迷你播放器上手动点"切歌"走的是同一个函数——没理由把"被动切歌"和
 * "主动切歌"分成两套逻辑。静音时不会走到这儿（paused 的 <audio> 不会触发
 * 'ended'），歌单指针在自动模式下天然只在真正播放到底时才前进；手动点
 * 按钮则不受此限制。
 */
export function skipToNextTrack(): void {
  trackIndex = (trackIndex + 1) % PLAYLIST.length;
  const el = ensure();
  loadTrack(el);
  if (!muted) {
    const p = el.play();
    if (p) p.catch(() => armRetry());
  }
}

function armRetry(): void {
  retryCleanup?.();
  const retry = (): void => {
    if (!muted) void ensure().play().catch(() => {});
    retryCleanup?.();
  };
  retryCleanup = () => {
    window.removeEventListener('pointerdown', retry);
    window.removeEventListener('keydown', retry);
    window.removeEventListener('touchstart', retry);
    retryCleanup = null;
  };
  window.addEventListener('pointerdown', retry, { once: true });
  window.addEventListener('keydown', retry, { once: true });
  window.addEventListener('touchstart', retry, { once: true });
}

/** 开始页挂载时调用一次；处于静音状态时不会真的尝试播放 */
export function startBgm(): void {
  if (muted) return;
  const p = ensure().play();
  if (p) p.catch(() => armRetry());
}

export function isBgmMuted(): boolean {
  return muted;
}

/** 顶栏静音按钮 / 迷你播放器暂停键的统一入口，只影响 BGM 自己 */
export function setBgmMuted(v: boolean): void {
  muted = v;
  try {
    localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (muted) {
    retryCleanup?.();
    audio?.pause();
  } else {
    startBgm();
  }
}
