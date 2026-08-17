/**
 * 全站背景音乐——从开始页挂载时起持续播放，不是开始页专属。没有独立的
 * 静音状态：顶栏那颗"🔊 有声 / 🔇 静音"按钮是全局的，同时控制选手视频
 * 片段的音量（card.ts 的 isMuted/setMuted）和这里的 BGM 音量，只有一个
 * 开关，不搞两套互相独立的静音状态出来迷惑人。
 *
 * 三首歌轮播（PLAYLIST）：不是各自单曲循环，是一首放完自动接下一首，到
 * 结尾绕回第一首。播放位置不做跨刷新持久化——和原来单曲循环一样，每次
 * 新开页面都从歌单第一首、从头播。数组顺序就是播放顺序，和文件名编号不必
 * 一一对应（bgm-3.mp4 是后加的第三首，但排在队列最前面，产品所有者要求的）
 *
 * 契约：
 *   - main.ts 在静音按钮的点击回调里调用 setBgmMuted(isMuted())，
 *     两边状态永远同步
 *   - 打开视频弹层时自动闪避（duck）：不叠加两条音轨，关闭弹层后如果
 *     没有处于全局静音状态就自动恢复播放（恢复的是闪避前那首歌的原播放
 *     位置，不会因为闪避而跳歌）
 *   - 浏览器只允许静音自动播放，带声音的自动播放大概率被拦截——这不是
 *     bug，是所有主流浏览器的统一行为。兜底：播放被拒绝后监听下一次
 *     用户手势（点击/按键/触摸），在那次手势的同一个事件循环里补播
 */

import { assetUrl } from './data';

const PLAYLIST = ['audio/bgm-3.mp4', 'audio/bgm-1.mp4', 'audio/bgm-2.mp4'];

let audio: HTMLAudioElement | null = null;
let trackIndex = 0;
let muted = false;
let duckDepth = 0;
let retryCleanup: (() => void) | null = null;

function loadTrack(el: HTMLAudioElement): void {
  el.src = assetUrl(PLAYLIST[trackIndex]);
}

function ensure(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    // 单曲不循环——播完交给 'ended' 监听器切下一首，见下方 skipToNextTrack()
    audio.loop = false;
    // 混音惯例里，背景音乐同时出现时一般比人声低 15–20dB；这里 BGM 和片段人声
    // 从不真正同时播放（duckBgm 是整段暂停，不是压低），不需要压到那么狠，
    // 但"独自出现时也不该跟内容抢注意力"——原按 ~9dB 降到 0.2，产品所有者
    // 2026-08-17 反馈偏小，调到 0.35（约 +5dB，比原始 0.55 还是明显更低）
    audio.volume = 0.35;
    audio.addEventListener('ended', skipToNextTrack);
    loadTrack(audio);
  }
  return audio;
}

/**
 * 切到歌单下一首（到底则绕回第一首）。一首自然放完（audio 的 'ended' 事件）
 * 和顶栏迷你播放器上手动点"切歌"走的是同一个函数——没理由把"被动切歌"和
 * "主动切歌"分成两套逻辑。静音播放完不会走到这儿（paused 的 <audio> 不会
 * 触发 'ended'），歌单指针在自动模式下天然只在真正播放到底时才前进；手动
 * 点按钮则不受此限制。
 */
export function skipToNextTrack(): void {
  trackIndex = (trackIndex + 1) % PLAYLIST.length;
  const el = ensure();
  loadTrack(el);
  if (!muted && duckDepth === 0) {
    const p = el.play();
    if (p) p.catch(() => armRetry());
  }
}

function armRetry(): void {
  retryCleanup?.();
  const retry = (): void => {
    if (!muted && duckDepth === 0) void ensure().play().catch(() => {});
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

/** 开始页挂载时调用一次；处于全局静音状态时不会真的尝试播放 */
export function startBgm(): void {
  if (muted || duckDepth > 0) return;
  const p = ensure().play();
  if (p) p.catch(() => armRetry());
}

/** 顶栏静音开关的统一入口，和 card.ts 的 setMuted 在同一次点击里成对调用 */
export function setBgmMuted(v: boolean): void {
  muted = v;
  if (muted) {
    retryCleanup?.();
    audio?.pause();
  } else {
    startBgm();
  }
}

/** 视频弹层打开：临时闪避，不叠加音轨。可能嵌套（防御性），用计数器配对 */
export function duckBgm(): void {
  duckDepth++;
  audio?.pause();
}

/** 视频弹层关闭：闪避计数清零后，如果不在全局静音状态就恢复播放 */
export function unduckBgm(): void {
  duckDepth = Math.max(0, duckDepth - 1);
  if (duckDepth === 0) startBgm();
}
