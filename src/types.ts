export interface Contestant {
  /** 稳定唯一 ID，同时用作缩略图/片段的文件名 */
  id: string;
  name: string;
  /** 分类标签，用于开赛前筛选；留空表示不参与分类筛选 */
  category?: string;
  /** 缩略图相对路径（相对站点根） */
  thumb: string;
  /** 10 秒片段相对路径；缺省表示该选手暂无视频，卡片会退化成纯图片 */
  clip?: string;
  /** 可选：夺冠时显示的一句台词 */
  championLine?: string;
  /**
   * 缩略图/视频在 3:4 卡片里的裁切锚点，CSS object-position 语法
   * （如 "top"、"50% 20%"）。素材原始比例和卡片差异较大、又不想用
   * scripts/transcode.mjs 重新裁切编码时，用这个字段快速调整裁切位置。
   * 更推荐的做法是在 raw/crop.json 里给源文件配裁切锚点后重新转码——
   * 那样缩略图和视频会裁得完全一致，这个字段只影响客户端渲染，是补丁不是根治。
   */
  focus?: string;
}

export interface ContestantFile {
  version: number;
  title?: string;
  contestants: Contestant[];
}

/** 一场比赛的结果记录，用于赛后生成「晋级之路」 */
export interface MatchRecord {
  round: number;
  roundName: string;
  winnerId: string;
  /** 轮空时为 null */
  loserId: string | null;
}

/**
 * 赛事状态。内部一律只存 id，天然可 JSON 序列化，
 * 直接 localStorage.setItem 即可断点续赛。
 */
export interface TournamentState {
  size: number;
  category: string | null;
  /** 本轮的对阵表，[a, b]；b 为 null 表示轮空 */
  pairs: [string, string | null][];
  /** 当前进行到第几场（pairs 的下标） */
  matchIndex: number;
  round: number;
  /** 本轮已产生的晋级者 */
  winners: string[];
  history: MatchRecord[];
  championId: string | null;
  createdAt: number;
}

/**
 * 小组赛阶段状态：候选池分成若干组（每组固定 4 人），每组一屏选出更喜欢
 * 的 2 位直通，另外 2 位落选进复活赛池。同样只存 id，可直接序列化。
 */
export interface GroupStageState {
  /** 分组结果，赛前一次性随机产生，之后不再变化 */
  groups: string[][];
  /** 当前展示到第几组（0-based） */
  groupIndex: number;
  /** 已确认直通的 id，随每组确认累加 */
  qualifiers: string[];
  /** 已确认落选的 id，随每组确认累加，交给复活赛 */
  losers: string[];
}

/**
 * 复活赛阶段状态：只跑一轮——从小组赛落选者里淘汰掉多余的人，幸存者
 * （对战胜者 + 直接轮空者）凑满目标人数后交给淘汰赛。不是 TournamentState
 * 那种"打到只剩 1 人"的循环，语义不同，所以单独建模。
 */
export interface RedemptionState {
  /** 本轮对阵表，[a, b]；b 为 null 表示直接复活（轮空） */
  pairs: [string, string | null][];
  /** 当前进行到第几场（pairs 的下标） */
  matchIndex: number;
  /** 已确定复活的 id（含对战胜者与轮空者） */
  revived: string[];
}
