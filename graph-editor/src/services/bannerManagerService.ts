export interface BannerSpec {
  /** Stable id for this banner (single owner controls updates). */
  id: string;
  /** Higher numbers win (rendered first). */
  priority: number;
  label: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionTitle?: string;
}

export interface BannerManagerState {
  /** Sorted by priority desc, then id asc for deterministic ordering. */
  banners: BannerSpec[];
}

type BannerListener = () => void;

class BannerManagerService {
  private static instance: BannerManagerService;

  static getInstance(): BannerManagerService {
    if (!BannerManagerService.instance) {
      BannerManagerService.instance = new BannerManagerService();
    }
    return BannerManagerService.instance;
  }

  private bannersById = new Map<string, BannerSpec>();
  private listeners: Set<BannerListener> = new Set();
  private version = 0;
  private cachedVersion = -1;
  private cachedState: BannerManagerState = { banners: [] };

  subscribe(listener: BannerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  getState(): BannerManagerState {
    // IMPORTANT: useSyncExternalStore requires getSnapshot() to return a cached/stable
    // reference unless the underlying store actually changed.
    if (this.cachedVersion === this.version) return this.cachedState;

    const banners = Array.from(this.bannersById.values()).sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });

    this.cachedState = { banners };
    this.cachedVersion = this.version;
    return this.cachedState;
  }

  setBanner(spec: BannerSpec): void {
    this.bannersById.set(spec.id, spec);
    this.version += 1;
    this.emit();
  }

  clearBanner(id: string): void {
    if (!this.bannersById.has(id)) return;
    this.bannersById.delete(id);
    this.version += 1;
    this.emit();
  }

  clearAll(): void {
    if (this.bannersById.size === 0) return;
    this.bannersById.clear();
    this.version += 1;
    this.emit();
  }
}

export const bannerManagerService = BannerManagerService.getInstance();

