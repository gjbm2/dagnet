/**
 * credentialsShareLinkService – share link generation (git-only)
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { CredentialsData } from '../../types/credentials';
import { buildCredsShareUrl, buildGitOnlyCredentialsForShare } from '../credentialsShareLinkService';

describe('credentialsShareLinkService', () => {
  it('builds a git-only payload with exactly one repo and forces isDefault=true (preserving other fields)', () => {
    const original: CredentialsData = {
      version: '1.0.0',
      git: [
        {
          name: 'repo-a',
          owner: 'acme',
          token: 'tok-a',
          branch: 'main',
          graphsPath: 'graphs',
          paramsPath: 'parameters',
          contextsPath: 'contexts',
          casesPath: 'cases',
          nodesPath: 'nodes',
          eventsPath: 'events',
          // explicitly false: should be forced true in share payload
          isDefault: false,
        },
        {
          name: 'repo-b',
          owner: 'acme',
          token: 'tok-b',
          branch: 'main',
          isDefault: true,
        },
      ],
      providers: {
        amplitude: { api_key: 'k', secret_key: 's' },
      },
    };

    const payload = buildGitOnlyCredentialsForShare(original, 'repo-a');
    expect(payload.version).toBe('1.0.0');
    expect(payload.providers).toBeUndefined();
    expect(payload.git).toHaveLength(1);
    expect(payload.git[0]).toEqual({
      name: 'repo-a',
      owner: 'acme',
      token: 'tok-a',
      branch: 'main',
      graphsPath: 'graphs',
      paramsPath: 'parameters',
      contextsPath: 'contexts',
      casesPath: 'cases',
      nodesPath: 'nodes',
      eventsPath: 'events',
      isDefault: true,
    });
  });

  it('builds an app-root URL with creds param', () => {
    const payload: CredentialsData = {
      version: '1.0.0',
      git: [{ name: 'repo-a', owner: 'acme', token: 'tok', isDefault: true }],
    };
    const url = buildCredsShareUrl('https://dagnet-nine.vercel.app/some/path?x=1', payload);
    expect(url.startsWith('https://dagnet-nine.vercel.app/?creds=')).toBe(true);

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/');
    const credsParam = parsed.searchParams.get('creds');
    expect(credsParam).toBeTruthy();
  });
});


