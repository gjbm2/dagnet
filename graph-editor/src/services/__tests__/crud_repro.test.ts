
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileOperationsService } from '../fileOperationsService';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// Mock dependencies
vi.mock('../../contexts/TabContext', () => ({
    fileRegistry: {
        getOrCreateFile: vi.fn(),
        getFile: vi.fn(),
        updateFile: vi.fn(),
        deleteFile: vi.fn(),
        updateIndexOnDelete: vi.fn(),
        notifyListeners: vi.fn(),
        getAllFiles: vi.fn().mockReturnValue([]),
    }
}));

vi.mock('../../db/appDatabase', () => ({
    db: {
        files: {
            put: vi.fn(),
            get: vi.fn(),
            delete: vi.fn(),
        }
    }
}));

describe('CRUD and Navigator Sync Reproduction', () => {
    let fileOps: FileOperationsService;
    let mockNavigatorOps: any;
    let mockTabOps: any;

    beforeEach(() => {
        vi.clearAllMocks();
        fileOps = new FileOperationsService();

        mockNavigatorOps = {
            addLocalItem: vi.fn(),
            refreshItems: vi.fn(),
        };

        mockTabOps = {
            openTab: vi.fn(),
        };

        fileOps.initialize({
            navigatorOps: mockNavigatorOps,
            tabOps: mockTabOps,
        });
    });

    it('createFile should add to localItems but NOT trigger full refresh', async () => {
        // Setup
        const fileName = 'test-param';
        const fileType = 'parameter';

        (fileRegistry.getOrCreateFile as any).mockResolvedValue({
            fileId: 'parameter-test-param',
            type: 'parameter',
            data: { id: 'test-param' },
            source: { repository: 'local' }
        });

        // Act
        await fileOps.createFile(fileName, fileType, { openInTab: false });

        // Assert
        // 1. It should call addLocalItem
        expect(mockNavigatorOps.addLocalItem).toHaveBeenCalled();

        // 2. It should NOT call refreshItems (which would update items.length and trigger NavigatorContent)
        expect(mockNavigatorOps.refreshItems).not.toHaveBeenCalled();

        // This confirms that if NavigatorContent depends on items.length (from refreshItems/loadItems),
        // it will NOT see this update unless it also listens to localItems (which is missing from context value).
    });

    it('deleteFile should trigger full refresh', async () => {
        // Setup
        const fileId = 'parameter-test-param';
        (fileRegistry.getFile as any).mockReturnValue({
            fileId,
            type: 'parameter',
            data: { id: 'test-param' },
            viewTabs: [],
            isDirty: false
        });

        // Act
        await fileOps.deleteFile(fileId, { skipConfirm: true });

        // Assert
        expect(mockNavigatorOps.refreshItems).toHaveBeenCalled();
    });
});
