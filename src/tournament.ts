import type { TournamentState } from './types';

export function shuffle<T>(input: readonly T[]): T[] {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 把一批选手排成本轮对阵表。人数为奇数时最后一位轮空（bye），
 * 参赛人数因此不必是 2 的整数次幂——自选参赛可以是任意人数。
 */
function buildPairs(ids: readonly string[]): [string, string | null][] {
  const s = shuffle(ids);
  const pairs: [string, string | null][] = [];
  for (let i = 0; i + 1 < s.length; i += 2) pairs.push([s[i], s[i + 1]]);
  if (s.length % 2 === 1) pairs.push([s[s.length - 1], null]);
  return pairs;
}

export function roundName(remaining: number): string {
  if (remaining <= 2) return '决赛';
  if (remaining <= 4) return '半决赛';
  if (remaining <= 8) return '8 强';
  if (remaining <= 16) return '16 强';
  if (remaining <= 32) return '32 强';
  if (remaining <= 64) return '64 强';
  return `${remaining} 强`;
}

/**
 * 本轮开赛时的总人数。
 * 轮次名必须用它而不是「实时剩余人数」——后者在一轮之内会一路递减，
 * 会出现同一轮里标题从「8 强」跳成「半决赛」的情况。
 */
export function roundPlayerCount(s: TournamentState): number {
  return s.pairs.reduce((n, p) => n + (p[1] === null ? 1 : 2), 0);
}

export function currentRoundName(s: TournamentState): string {
  return roundName(roundPlayerCount(s));
}

/** 本轮需要玩家真正做选择的场次总数（不含轮空） */
export function playableCount(s: TournamentState): number {
  return s.pairs.filter((p) => p[1] !== null).length;
}

/** 当前是本轮第几场（1-based，不含轮空） */
export function playableIndex(s: TournamentState): number {
  let n = 0;
  for (let i = 0; i <= s.matchIndex && i < s.pairs.length; i++) {
    if (s.pairs[i][1] !== null) n++;
  }
  return n;
}

export function createTournament(
  poolIds: readonly string[],
  size: number,
  category: string | null,
): TournamentState {
  const players = shuffle(poolIds).slice(0, size);
  const state: TournamentState = {
    size: players.length,
    category,
    pairs: buildPairs(players),
    matchIndex: 0,
    round: 1,
    winners: [],
    history: [],
    championId: null,
    createdAt: Date.now(),
  };
  settle(state);
  return state;
}

/** 当前待打的对阵；null 表示赛事已结束 */
export function currentPair(s: TournamentState): [string, string] | null {
  if (s.championId) return null;
  const p = s.pairs[s.matchIndex];
  if (!p || p[1] === null) return null;
  return [p[0], p[1]];
}

/** 记录一次晋级并推进赛程 */
export function pickWinner(s: TournamentState, winnerId: string): void {
  const pair = s.pairs[s.matchIndex];
  if (!pair || pair[1] === null) return;
  if (winnerId !== pair[0] && winnerId !== pair[1]) return;

  const loserId = winnerId === pair[0] ? pair[1] : pair[0];
  s.history.push({
    round: s.round,
    roundName: currentRoundName(s),
    winnerId,
    loserId,
  });
  s.winners.push(winnerId);
  s.matchIndex++;
  settle(s);
}

/**
 * 消化轮空、翻到下一轮、判定冠军。
 * 每次推进后调用，保证 currentPair() 要么是一场真实对局，要么赛事已结束。
 */
function settle(s: TournamentState): void {
  for (;;) {
    // 吃掉连续的轮空
    while (s.matchIndex < s.pairs.length && s.pairs[s.matchIndex][1] === null) {
      const byeId = s.pairs[s.matchIndex][0];
      s.history.push({
        round: s.round,
        roundName: currentRoundName(s),
        winnerId: byeId,
        loserId: null,
      });
      s.winners.push(byeId);
      s.matchIndex++;
    }

    if (s.matchIndex < s.pairs.length) return; // 本轮还有得打

    // 本轮打完
    if (s.winners.length <= 1) {
      s.championId = s.winners[0] ?? null;
      return;
    }
    s.round++;
    s.pairs = buildPairs(s.winners);
    s.winners = [];
    s.matchIndex = 0;
  }
}

/**
 * 本轮及以后大概率会用到的选手顺序，用于给预加载器排优先级：
 * 先是当前这场的两位，然后按对阵表顺序往后铺。
 */
export function upcomingIds(s: TournamentState): string[] {
  const out: string[] = [];
  for (let i = s.matchIndex; i < s.pairs.length; i++) {
    out.push(s.pairs[i][0]);
    if (s.pairs[i][1]) out.push(s.pairs[i][1]!);
  }
  return out.concat(s.winners);
}
