import { useSyncExternalStore } from 'react';
import {
  operationRegistryService,
  type Operation,
  type OperationRegistryState,
} from '../services/operationRegistryService';

/** Subscribe to the full operation registry state (active + recent). */
export function useOperations(): OperationRegistryState {
  return useSyncExternalStore(
    (cb) => operationRegistryService.subscribe(cb),
    () => operationRegistryService.getState(),
    () => ({ active: [], recent: [] })
  );
}

/** Subscribe to a single operation by ID (from active or recent). */
export function useOperation(id: string | undefined): Operation | undefined {
  const { active, recent } = useOperations();
  if (!id) return undefined;
  return active.find((o) => o.id === id) ?? recent.find((o) => o.id === id);
}
