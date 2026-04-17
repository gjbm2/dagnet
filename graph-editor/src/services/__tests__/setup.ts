import { vi } from 'vitest';

// Mock the BE topo pass to return empty results (simulate failure)
vi.mock('../beTopoPassService', () => ({
  runBeTopoPass: async () => [],
}));
