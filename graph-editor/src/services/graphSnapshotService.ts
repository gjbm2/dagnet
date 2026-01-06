import { activeGraphTrackerService } from './activeGraphTrackerService';

const SNAPSHOT_ENDPOINT = '/__dagnet/graph-snapshot';

type SnapshotPayload = {
  ts_ms: number;
  label: string;
  fileId?: string;
  tabId?: string;
  graph?: unknown;
  note?: string;
};

class GraphSnapshotService {
  async snapshotAtMark(label: string): Promise<void> {
    if (!import.meta.env.DEV) return;

    const active = activeGraphTrackerService.getActiveGraph();
    const payload: SnapshotPayload = {
      ts_ms: Date.now(),
      label,
      fileId: active?.fileId,
      tabId: active?.tabId,
      graph: active?.graph ?? null,
      note: active?.graph ? undefined : 'no-active-graph',
    };

    try {
      await fetch(SNAPSHOT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      // Best-effort; never interfere with app behaviour
    }
  }
}

export const graphSnapshotService = new GraphSnapshotService();


