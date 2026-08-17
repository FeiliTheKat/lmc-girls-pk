import type { Contestant, ContestantFile } from './types';

/** 把 contestants.json 里的相对路径转成实际可 fetch 的 URL（兼容子目录部署） */
export function assetUrl(p: string): string {
  if (/^(https?:)?\/\//.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const base = import.meta.env.BASE_URL || '/';
  return (base.endsWith('/') ? base : base + '/') + p.replace(/^\//, '');
}

export let contestants: Contestant[] = [];
export let byId = new Map<string, Contestant>();
export let categories: string[] = [];
export let libraryTitle = '猴女郎巅峰对决';

export async function loadData(): Promise<void> {
  const res = await fetch(assetUrl('data/contestants.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`选手库加载失败：HTTP ${res.status}`);
  const file = (await res.json()) as ContestantFile;

  contestants = (file.contestants ?? []).filter((c) => c && c.id && c.name && c.thumb);
  byId = new Map(contestants.map((c) => [c.id, c]));
  categories = [...new Set(contestants.map((c) => c.category).filter((x): x is string => !!x))];
  if (file.title) libraryTitle = file.title;

  const dupes = contestants.length - byId.size;
  if (dupes > 0) console.warn(`[选手库] 发现 ${dupes} 个重复 id，后者已覆盖前者`);
}

export function get(id: string): Contestant | undefined {
  return byId.get(id);
}

export function poolFor(category: string | null): Contestant[] {
  if (!category) return contestants;
  return contestants.filter((c) => c.category === category);
}

export function clipUrls(ids: readonly string[]): string[] {
  return ids.map((id) => byId.get(id)?.clip).filter((x): x is string => !!x).map(assetUrl);
}
