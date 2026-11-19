import { shuffle } from './tournament';
import type { GroupStageState } from './types';

/** 每组固定 4 人，选出 2 人直通——照搬 musiccup.app 的"4 选 2" */
export const GROUP_SIZE = 4;
export const GROUP_QUALIFIERS_PER_GROUP = 2;

/** 随机洗牌后按 GROUP_SIZE 切块。调用前应确保候选数是 GROUP_SIZE 的整数倍 */
export function makeGroups(poolIds: readonly string[]): string[][] {
  const s = shuffle(poolIds);
  const groups: string[][] = [];
  for (let i = 0; i < s.length; i += GROUP_SIZE) groups.push(s.slice(i, i + GROUP_SIZE));
  return groups;
}

export function createGroupStage(poolIds: readonly string[]): GroupStageState {
  return {
    groups: makeGroups(poolIds),
    groupIndex: 0,
    qualifiers: [],
    losers: [],
  };
}

/** 当前正在选的那一组；小组赛已经跑完时为 null */
export function currentGroup(gs: GroupStageState): string[] | null {
  return gs.groups[gs.groupIndex] ?? null;
}

export function isGroupStageDone(gs: GroupStageState): boolean {
  return gs.groupIndex >= gs.groups.length;
}

/**
 * 确认当前组的晋级名单：必须精确选出 GROUP_QUALIFIERS_PER_GROUP 人，且都属于
 * 当前组，否则整次调用被忽略（由调用方的确认按钮 disabled 状态兜底，这里
 * 是防御第二道）。确认后把直通者/落选者各自累加，推进到下一组。
 */
export function confirmGroup(gs: GroupStageState, pickedIds: readonly string[]): void {
  const group = currentGroup(gs);
  if (!group) return;
  if (pickedIds.length !== GROUP_QUALIFIERS_PER_GROUP) return;
  if (!pickedIds.every((id) => group.includes(id))) return;

  const picked = new Set(pickedIds);
  gs.qualifiers.push(...pickedIds);
  gs.losers.push(...group.filter((id) => !picked.has(id)));
  gs.groupIndex++;
}
