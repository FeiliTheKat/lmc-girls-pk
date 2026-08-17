/**
 * 全站背景音乐——从开始页挂载时起持续播放，不是开始页专属。没有独立的
 * 静音状态：顶栏那颗"🔊 有声 / 🔇 静音"按钮是全局的，同时控制选手视频
 * 片段的音量（card.ts 的 isMuted/setMuted）和这里的 BGM 音量，只有一个
 * 开关，不搞两套互相独立的静音状态出来迷惑人。
 *
 * 契约：
 *   - main.ts 在静音按钮的点击回调里调用 setBgmMuted(isMuted())，
 *     两边状态永远同步
 *   - 打开视频弹层时自动闪避（duck）：不叠加两条音轨，关闭弹层后如果
 *     没有处于全局静音状态就自动恢复播放
 *   - 浏览器只允许静音自动播放，带声音的自动播放大概率被拦截——这不是
 *     bug，是所有主流浏览器的统一行为。兜底：播放被拒绝后监听下一次
 *     用户手势（点击/按键/触摸），在那次手势的同一个事件循环里补播
 */

import { assetUrl } from './data';

let audio: HTMLAudioElement | null = null;
let muted = false;
let duckDepth = 0;
let retryCleanup: (() => void) | null = null;

function ensure(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(assetUrl('audio/theme.mp4'));
    audio.loop = true;
    // 混音惯例里，背景音乐同时出现时一般比人声低 15–20dB；这里 BGM 和片段人声
    // 从不真正同时播放（duckBgm 是整段暂停，不是压低），不需要压到那么狠，
    // 但"独自出现时也不该跟内容抢注意力"——按 ~9dB 降，0.55→约 0.2
    audio.volume = 0.2;
  }
  return audio;
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
