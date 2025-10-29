import { VercelRequest, VercelResponse } from '@vercel/node';
import { CredentialsManager } from '../src/lib/credentials';

/**
 * Vercel serverless function to fetch graphs from GitHub
 * 
 * Query params:
 * - name: Graph name (required)
 * - branch: Git branch (default: main)
 * - raw: Return raw JSON string (default: false)
 * - format: Return formatted JSON (default: false)
 * - secret: Webhook secret for authentication (optional, enables system credentials)
 */

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS for Google Sheets API calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS for CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, branch = 'main', raw, format, secret } = req.query;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Graph name is required' });
    }

    // Load credentials using the existing CredentialsManager
    const credentialsManager = CredentialsManager.getInstance();
    let credentialsResult;
    
    if (secret && typeof secret === 'string') {
      // Use provided secret to load system credentials
      credentialsResult = await credentialsManager.loadFromSystemSecretWithKey(secret);
    } else {
      // Try loading without a secret (will use public access or fail)
      credentialsResult = await credentialsManager.loadCredentials();
    }

    if (!credentialsResult.success || !credentialsResult.credentials) {
      return res.status(401).json({ 
        error: 'No valid credentials available',
        details: credentialsResult.error 
      });
    }

    // Get the default git repository
    const gitRepo = credentialsManager.getDefaultGitCredentials();
    if (!gitRepo) {
      return res.status(500).json({ error: 'No git repositories in credentials' });
    }

    const repoOwner = gitRepo.owner;
    const repoName = gitRepo.repo;
    const graphsPath = gitRepo.graphsPath || 'graphs';
    const githubToken = gitRepo.token;

    // Construct file path
    const fileName = name.endsWith('.json') ? name : `${name}.json`;
    const filePath = `${graphsPath}/${fileName}`;

    // Call GitHub API
    const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}?ref=${branch}`;
    
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Dagnet-Apps-Script'
    };

    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ 
        error: `GitHub API error: ${response.statusText}`,
        details: errorText,
        url: url.replace(githubToken || '', '***')
      });
    }

    const data: GitHubFile = await response.json();

    // Decode content (GitHub returns base64)
    if (!data.content || data.encoding !== 'base64') {
      return res.status(500).json({ error: 'Invalid file content from GitHub' });
    }

    const decodedContent = Buffer.from(data.content, 'base64').toString('utf-8');
    
    // Parse JSON to validate
    let graphData;
    try {
      graphData = JSON.parse(decodedContent);
    } catch (parseError) {
      return res.status(500).json({ 
        error: 'Invalid JSON in graph file',
        details: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      });
    }

    // Return based on requested format
    if (raw === 'true' || raw === '1') {
      // Return raw JSON string (for Google Sheets)
      if (format === 'pretty') {
        return res.status(200).send(JSON.stringify(graphData, null, 2));
      } else {
        return res.status(200).send(JSON.stringify(graphData));
      }
    } else {
      // Return as JSON response with metadata
      return res.status(200).json({
        success: true,
        data: {
          name: name,
          path: filePath,
          branch: branch,
          sha: data.sha,
          size: data.size,
          content: graphData
        }
      });
    }

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

