import { shuffle } from './tournament';
import type { RedemptionState } from './types';

/**
 * 复活赛只跑一轮：从小组赛落选者（losers）里淘汰掉多余的人，幸存者
 * （对战胜者 + 直接轮空者）凑满 targetSize，交给淘汰赛阶段。
 *
 * 不复用 tournament.ts 的 settle()——那是"胜者再洗牌进入下一轮，直到只剩
 * 1 个冠军"的循环，复活赛只要一轮、产出多个幸存者，语义不同。
 *
 * eliminations = losers.length - targetSize 场真实对战（每场淘汰 1 人），
 * 剩下的人直接轮空复活。targetSize >= losers.length 时（理论上不会发生，
 * 分组人数固定后 losers 和 qualifiers 同源等长）没有人需要淘汰，全员轮空。
 */
export function createRedemption(losers: readonly string[], targetSize: number): RedemptionState {
  const eliminations = Math.max(0, Math.min(losers.length, losers.length - targetSize));
  const shuffled = shuffle(losers);
  const dueling = shuffled.slice(0, eliminations * 2);
  const byes = shuffled.slice(eliminations * 2);

  const pairs: [string, string | null][] = [];
  for (let i = 0; i + 1 < dueling.length; i += 2) pairs.push([dueling[i], dueling[i + 1]]);
  for (const id of byes) pairs.push([id, null]);

  const state: RedemptionState = { pairs, matchIndex: 0, revived: [] };
  settleByes(state);
  return state;
}

/** 消化排在队首的连续轮空（本模块里轮空对总是排在真实对战之后，见上） */
function settleByes(s: RedemptionState): void {
  while (s.matchIndex < s.pairs.length && s.pairs[s.matchIndex][1] === null) {
    s.revived.push(s.pairs[s.matchIndex][0]);
    s.matchIndex++;
  }
}

/** 当前待打的对阵；null 表示复活赛已经结束 */
export function currentRedemptionPair(s: RedemptionState): [string, string] | null {
  const p = s.pairs[s.matchIndex];
  if (!p || p[1] === null) return null;
  return [p[0], p[1]];
}

export function isRedemptionDone(s: RedemptionState): boolean {
  return s.matchIndex >= s.pairs.length;
}

/** 记录一次复活并推进赛程 */
export function pickRedemptionWinner(s: RedemptionState, winnerId: string): void {
  const pair = s.pairs[s.matchIndex];
  if (!pair || pair[1] === null) return;
  if (winnerId !== pair[0] && winnerId !== pair[1]) return;

  s.revived.push(winnerId);
  s.matchIndex++;
  settleByes(s);
}
