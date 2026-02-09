/**
 * Shared filtering, sorting, and grouping logic
 * Used by Navigator and SelectorModal for consistent behavior
 */

export type FilterMode = 'all' | 'dirty' | 'open' | 'local';
export type SortMode = 'name' | 'modified' | 'opened' | 'status' | 'type';
export type GroupMode = 'type' | 'tags' | 'status' | 'none';

export interface ItemBase {
  id: string;
  name: string;
  type: string;
  hasFile?: boolean;
  isLocal?: boolean;
  isDirty?: boolean;
  isOpen?: boolean;
  tags?: string[];
  lastModified?: number;
  lastOpened?: number;
  description?: string;
  path?: string;
}

export interface FilterOptions {
  searchQuery: string;
  filterMode: FilterMode;
  viewMode?: 'all' | 'files-only';
}

export interface GroupedItems<T> {
  group: string;
  items: T[];
}

/**
 * Filter items based on search query and filter mode
 */
export function filterItems<T extends ItemBase>(
  items: T[],
  options: FilterOptions
): T[] {
  const { searchQuery, filterMode, viewMode = 'all' } = options;
  
  return items.filter(item => {
    // View mode filter
    if (viewMode === 'files-only' && !item.hasFile) {
      return false;
    }
    
    // State filters
    if (filterMode === 'local' && !item.isLocal) {
      return false;
    }
    
    if (filterMode === 'dirty' && !item.isDirty) {
      return false;
    }
    
    if (filterMode === 'open' && !item.isOpen) {
      return false;
    }
    
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        item.name.toLowerCase().includes(query) ||
        item.id.toLowerCase().includes(query) ||
        item.tags?.some(t => t.toLowerCase().includes(query)) ||
        item.description?.toLowerCase().includes(query) ||
        item.path?.toLowerCase().includes(query)
      );
    }
    
    return true;
  });
}

/**
 * Sort items based on sort mode
 */
export function sortItems<T extends ItemBase>(
  items: T[],
  sortBy: SortMode
): T[] {
  const sorted = [...items];
  
  sorted.sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      
      case 'modified':
        return (b.lastModified || 0) - (a.lastModified || 0);
      
      case 'opened':
        return (b.lastOpened || 0) - (a.lastOpened || 0);
      
      case 'status':
        // Dirty first, then open, then others
        if (a.isDirty !== b.isDirty) return a.isDirty ? -1 : 1;
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        return 0;
      
      case 'type':
        return a.type.localeCompare(b.type);
      
      default:
        return 0;
    }
  });
  
  return sorted;
}

/**
 * Group items based on group mode
 */
export function groupItems<T extends ItemBase>(
  items: T[],
  groupBy: GroupMode
): GroupedItems<T>[] {
  if (groupBy === 'none') {
    return [{ group: 'All Items', items }];
  }
  
  const groups = new Map<string, T[]>();
  
  items.forEach(item => {
    let groupKey: string;
    
    switch (groupBy) {
      case 'type':
        groupKey = item.type || 'unknown';
        break;
      
      case 'status':
        if (item.isDirty) {
          groupKey = 'Dirty';
        } else if (item.isOpen) {
          groupKey = 'Open';
        } else if (item.isLocal) {
          groupKey = 'Local';
        } else {
          groupKey = 'Registry';
        }
        break;
      
      case 'tags': {
        // Group by ALL tags — item appears in every tag group it belongs to
        const itemTags = item.tags && item.tags.length > 0 ? item.tags : ['Untagged'];
        for (const tag of itemTags) {
          if (!groups.has(tag)) {
            groups.set(tag, []);
          }
          groups.get(tag)!.push(item);
        }
        return; // Skip the common push below — we've already added to groups
      }
      
      default:
        groupKey = 'Unknown';
    }
    
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(item);
  });
  
  // Convert to array and sort groups by name
  const result = Array.from(groups.entries())
    .map(([group, items]) => ({ group, items }))
    .sort((a, b) => a.group.localeCompare(b.group));
  
  return result;
}

/**
 * Complete filtering, sorting, and grouping pipeline
 */
export function useItemFiltering<T extends ItemBase>(
  items: T[],
  filterOptions: FilterOptions,
  sortBy: SortMode,
  groupBy: GroupMode
): {
  filteredItems: T[];
  groupedItems: GroupedItems<T>[];
  stats: {
    total: number;
    filtered: number;
    groups: number;
  };
} {
  // 1. Filter
  const filtered = filterItems(items, filterOptions);
  
  // 2. Sort
  const sorted = sortItems(filtered, sortBy);
  
  // 3. Group
  const grouped = groupItems(sorted, groupBy);
  
  return {
    filteredItems: sorted,
    groupedItems: grouped,
    stats: {
      total: items.length,
      filtered: sorted.length,
      groups: grouped.length
    }
  };
}

