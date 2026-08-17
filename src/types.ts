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
