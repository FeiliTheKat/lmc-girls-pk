/**
 * 分层预加载器。
 *
 * 策略（见 DESIGN.md §4 加载闸门）：
 *   L0 阻塞 —— 全部缩略图（每张几 KB，1 秒内跑完，进度条只反映这一层 + L1）
 *   L1 阻塞 —— 首场对阵的两条片段
 *   L2 后台 —— 其余片段按对阵顺序排队，并发 3，用户看片的空档里悄悄铺完
 *
 * 落盘用 Cache Storage 而不是 Blob：不占 JS 堆、跨会话持久、第二次访问秒开。
 * 非安全上下文（http 直开文件）下自动退化成普通 fetch，交给浏览器 HTTP 缓存。
 */

const CACHE_NAME = 'mgc-assets-v1';
const BG_CONCURRENCY = 3;

export interface Progress {
  loaded: number;
  total: number;
  /** 0–1 */
  ratio: number;
}

export class Preloader {
  private cache: Cache | null = null;
  private ready: Promise<void>;
  private done = new Set<string>();
  private inflight = new Map<string, Promise<void>>();

  /** 后台队列，越靠前越先取 */
  private queue: string[] = [];
  private bgActive = 0;
  private bgPaused = false;

  constructor() {
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    try {
      if (typeof caches !== 'undefined') {
        this.cache = await caches.open(CACHE_NAME);
      }
    } catch {
      this.cache = null; // 隐私模式 / 非安全上下文
    }
  }

  isReady(url: string): boolean {
    return this.done.has(url);
  }

  /** 取一个资源进缓存；重复调用会复用同一个 in-flight promise */
  fetchOne(url: string): Promise<void> {
    if (this.done.has(url)) return Promise.resolve();
    const running = this.inflight.get(url);
    if (running) return running;

    const p = (async () => {
      await this.ready;
      try {
        if (this.cache) {
          const hit = await this.cache.match(url);
          if (!hit) {
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`${res.status} ${url}`);
            await this.cache.put(url, res.clone());
          }
        } else {
          const res = await fetch(url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`${res.status} ${url}`);
          await res.arrayBuffer();
        }
        this.done.add(url);
      } catch {
        // 单个资源失败不能拖垮开赛：标记为已处理，播放时再由 <video> 自己报错
        this.done.add(url);
      } finally {
        this.inflight.delete(url);
      }
    })();

    this.inflight.set(url, p);
    return p;
  }

  /**
   * 阻塞加载一批资源，带进度回调。
   * 并发放宽到 6：这批通常是小缩略图，HTTP/2 下多路复用不吃亏。
   */
  async loadBlocking(urls: string[], onProgress?: (p: Progress) => void): Promise<void> {
    const list = urls.filter((u) => !this.done.has(u));
    const total = urls.length;
    let loaded = urls.length - list.length;

    const report = () => onProgress?.({ loaded, total, ratio: total ? loaded / total : 1 });
    report();

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        await this.fetchOne(list[i]);
        loaded++;
        report();
      }
    };

    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  }

  /** 把一批 URL 排进后台队列（已在队列里的会被提到对应位置） */
  enqueue(urls: string[]): void {
    const wanted = urls.filter((u) => !this.done.has(u));
    const rest = this.queue.filter((u) => !wanted.includes(u));
    this.queue = [...wanted, ...rest];
    this.pump();
  }

  /** 把某几个 URL 顶到队首（用户即将看到它们） */
  prioritize(urls: string[]): void {
    this.enqueue(urls);
  }

  /** 用户正在播放视频时暂停后台预取，把带宽让给当前这条流 */
  pauseBackground(): void {
    this.bgPaused = true;
  }

  resumeBackground(): void {
    this.bgPaused = false;
    this.pump();
  }

  private pump(): void {
    if (this.bgPaused) return;
    while (this.bgActive < BG_CONCURRENCY && this.queue.length) {
      const url = this.queue.shift()!;
      if (this.done.has(url)) continue;
      this.bgActive++;
      void this.fetchOne(url).finally(() => {
        this.bgActive--;
        this.pump();
      });
    }
  }

  /** 后台进度，用于角落里的小提示 */
  backgroundStatus(): { pending: number; active: number } {
    return { pending: this.queue.length, active: this.bgActive };
  }
}

export const preloader = new Preloader();
