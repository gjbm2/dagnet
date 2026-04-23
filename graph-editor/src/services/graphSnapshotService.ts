import { activeGraphTrackerService } from './activeGraphTrackerService';
import { getMappingsFileAsync, type HashMappingsFile } from './hashMappingsService';

const SNAPSHOT_ENDPOINT = '/__dagnet/graph-snapshot';

type SnapshotPayload = {
  ts_ms: number;
  label: string;
  fileId?: string;
  tabId?: string;
  graph?: unknown;
  mappings?: HashMappingsFile;
  note?: string;
};

class GraphSnapshotService {
  async snapshotAtMark(label: string): Promise<void> {
    if (!import.meta.env.DEV) return;

    const active = activeGraphTrackerService.getActiveGraph();
    let mappings: HashMappingsFile | undefined;
    try {
      mappings = await getMappingsFileAsync();
    } catch {
      // Best-effort; snapshot still useful without mappings
    }
    const payload: SnapshotPayload = {
      ts_ms: Date.now(),
      label,
      fileId: active?.fileId,
      tabId: active?.tabId,
      graph: active?.graph ?? null,
      mappings,
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


