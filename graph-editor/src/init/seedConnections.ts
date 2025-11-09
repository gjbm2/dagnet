import { db } from '../db/appDatabase';
import { gitConfig } from '../config/gitConfig';
import yaml from 'js-yaml';

/**
 * Loads default connections.yaml from public/defaults/
 */
async function loadDefaultConnections(): Promise<any> {
  try {
    const response = await fetch('/defaults/connections.yaml');
    if (!response.ok) {
      throw new Error(`Failed to fetch default connections: ${response.status}`);
    }
    const text = await response.text();
    return yaml.load(text);
  } catch (error) {
    console.error('[seedConnections] Failed to load default connections.yaml:', error);
    // Fallback to minimal empty structure
    return {
      version: '1.0.0',
      connections: []
    };
  }
}

/**
 * Seeds connections.yaml - priority: git > local > defaults
 * Called during app initialization (mirrors credential and registry file loading)
 */
export async function seedConnectionsFile(): Promise<void> {
  try {
    const fileId = 'connections-connections';
    const existing = await db.files.get(fileId);
    
    // Try to load from git first (similar to how paramRegistryService loads files)
    try {
      console.log('[seedConnections] Attempting to load connections.yaml from git...');
      
      // Use credentials manager to get configured repo
      const { credentialsManager } = await import('../lib/credentials');
      const credResult = await credentialsManager.loadCredentials();
      
      if (credResult.success && credResult.credentials?.git && credResult.credentials.git.length > 0) {
        // Use first git credential (or could be smarter about selection)
        const gitCred = credResult.credentials.git[0];
        const basePath = gitCred.basePath || '';
        const fullPath = basePath ? `${basePath}/connections/connections.yaml` : 'connections/connections.yaml';
        
        const apiUrl = `${gitConfig.githubApiBase}/repos/${gitCred.owner}/${gitCred.repo}/contents/${fullPath}?ref=${gitCred.branch || 'main'}`;
        
        const headers: HeadersInit = {
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        };
        
        if (gitCred.token) {
          headers['Authorization'] = `token ${gitCred.token}`;
        }
        
        console.log(`[seedConnections] Fetching from: ${gitCred.owner}/${gitCred.repo} - ${fullPath}`);
        const response = await fetch(apiUrl, { headers });
        
        if (response.ok) {
          const data = await response.json();
          const content = atob(data.content.replace(/\n/g, ''));
          const parsedData = yaml.load(content);
          
          // Check if we need to update or create
          if (!existing || JSON.stringify(existing.data) !== JSON.stringify(parsedData)) {
            console.log('[seedConnections] Syncing connections.yaml from git');
            await db.files.put({
              fileId,
              type: 'connections',
              data: parsedData as any,
              lastModified: Date.now(),
              viewTabs: existing?.viewTabs || []
            });
            console.log('[seedConnections] connections.yaml synced successfully from git');
          } else {
            console.log('[seedConnections] connections.yaml already up-to-date');
          }
          return;
        } else {
          console.log(`[seedConnections] File not found in git (${response.status}), will create empty locally`);
        }
      } else {
        console.log('[seedConnections] No git credentials configured, skipping git sync');
      }
    } catch (gitError) {
      console.log('[seedConnections] Could not load from git (expected if using local mode or file does not exist):', gitError);
      // Continue to local fallback
    }
    
    // Fallback: Load default connections.yaml if it doesn't exist locally
    const defaultData = await loadDefaultConnections();
    const defaultConnections = defaultData?.connections;
    const defaultCount = Array.isArray(defaultConnections) ? defaultConnections.length : 0;
    const existingConnections = existing?.data?.connections;
    const existingCount = Array.isArray(existingConnections) ? existingConnections.length : 0;
    const shouldReseedFromDefaults =
      (!existing || (!existing.isDirty && existingCount === 0 && defaultCount > 0));

    if (shouldReseedFromDefaults) {
      console.log(
        `[seedConnections] ${existing ? 'Reseeding' : 'Creating'} connections.yaml from defaults (${defaultCount} connections)`
      );

      await db.files.put({
        fileId,
        type: 'connections',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: defaultData
      });
      console.log(
        '[seedConnections] ✅ connections.yaml',
        existing ? 'reseeded' : 'created',
        'with',
        defaultCount,
        'default connections'
      );
    } else {
      console.log('[seedConnections] connections.yaml already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedConnections] Failed to seed connections.yaml:', error);
    // Don't throw - this is a nice-to-have initialization
  }
}

