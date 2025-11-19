/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DASRunner } from '../DASRunner';
import { CredentialsManager } from '../../credentials';
import type { HttpExecutor, HttpRequest, HttpResponse } from '../HttpExecutor';
import type { ConnectionProvider } from '../ConnectionProvider';
import type { ConnectionDefinition } from '../types';

class MockHttpExecutor implements HttpExecutor {
  public lastRequest: HttpRequest | null = null;
  public mockBody: any = {};

  async execute(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: this.mockBody,
      rawBody: JSON.stringify(this.mockBody),
    };
  }
}

class MockConnectionProvider implements ConnectionProvider {
  private mockConnections: Record<string, ConnectionDefinition> = {};

  setMockConnection(name: string, connection: ConnectionDefinition) {
    this.mockConnections[name] = connection;
  }

  async getConnection(name: string): Promise<ConnectionDefinition> {
    const conn = this.mockConnections[name];
    if (!conn) {
      throw new Error(`Connection "${name}" not found`);
    }
    return conn;
  }

  async getAllConnections(): Promise<ConnectionDefinition[]> {
    return Object.values(this.mockConnections);
  }

  async getConnectionFile() {
    return { version: '1.0.0', connections: [] };
  }
}

describe('DASRunner - Google Sheets adapter (sheets-readonly)', () => {
  let runner: DASRunner;
  let mockHttpExecutor: MockHttpExecutor;
  let mockConnectionProvider: MockConnectionProvider;
  let credentialsManager: CredentialsManager;

  beforeEach(() => {
    mockHttpExecutor = new MockHttpExecutor();
    mockConnectionProvider = new MockConnectionProvider();
    credentialsManager = CredentialsManager.getInstance();

    vi.spyOn(credentialsManager, 'loadCredentials').mockResolvedValue({
      success: true,
      source: 'mock' as any,
    });
    vi.spyOn(credentialsManager, 'getProviderCredentials').mockReturnValue({
      access_token: 'test-token',
    });

    runner = new DASRunner(
      mockHttpExecutor,
      credentialsManager,
      mockConnectionProvider,
    );
  });

  function registerSheetsConnection() {
    const sheetsConnection: ConnectionDefinition = {
      name: 'sheets-readonly',
      provider: 'google-sheets',
      kind: 'http',
      enabled: true,
      auth_type: 'google-service-account',
      defaults: {
        api_version: 'v4',
      },
      adapter: {
        pre_request: {
          script: `
            // pre_request is intentionally minimal for sheets
            return dsl;
          `,
        },
        request: {
          url_template:
            'https://sheets.googleapis.com/v4/spreadsheets/{{{connection_string.spreadsheet_id}}}/values/{{{connection_string.range}}}',
          method: 'GET',
          headers: {
            Authorization: 'Bearer {{credentials.access_token}}',
          },
        },
        response: {
          extract: [
            { name: 'values', jmes: 'values' },
          ],
        },
        transform: [
          {
            name: 'parsed_result',
            jsonata: `
              (
                $dasHelpers := dasHelpers;

                $dasHelpers.parseSheetsRange ?
                  $dasHelpers.parseSheetsRange(values) :
                  {
                    "mode": "error",
                    "scalarValue": null,
                    "paramPack": {},
                    "errors": [
                      {
                        "row": 0,
                        "col": 0,
                        "message": "dasHelpers.parseSheetsRange not available"
                      }
                    ]
                  }
              )
            `,
          },
          {
            name: 'scalar_value',
            jsonata: 'parsed_result.scalarValue',
          },
          {
            name: 'param_pack',
            jsonata: 'parsed_result.paramPack',
          },
          {
            name: 'errors',
            jsonata: 'parsed_result.errors',
          },
        ],
        upsert: {
          mode: 'replace',
          writes: [],
        },
      },
    };

    mockConnectionProvider.setMockConnection('sheets-readonly', sheetsConnection);
  }

  it('parses single numeric cell into scalar_value via sheets adapter', async () => {
    registerSheetsConnection();
    mockHttpExecutor.mockBody = {
      values: [[0.45]],
    };

    const result = await runner.execute(
      'sheets-readonly',
      {},
      {
        connection_string: {
          spreadsheet_id: 'sheet-id',
          range: 'Sheet1!A1',
        },
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.raw.scalar_value).toBeCloseTo(0.45);
    expect(result.raw.param_pack).toBeUndefined();
    expect(result.raw.errors).toEqual([]);
  });

  it('parses single JSON cell into param_pack via sheets adapter', async () => {
    registerSheetsConnection();
    mockHttpExecutor.mockBody = {
      values: [[`{"p.mean": 0.5, "p.stdev": 0.1}`]],
    };

    const result = await runner.execute(
      'sheets-readonly',
      {},
      {
        connection_string: {
          spreadsheet_id: 'sheet-id',
          range: 'Sheet1!A1',
        },
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.raw.scalar_value).toBeUndefined();
    expect(result.raw.param_pack).toEqual({
      'p.mean': 0.5,
      'p.stdev': 0.1,
    });
    expect(result.raw.errors).toEqual([]);
  });

  it('parses name/value pairs into param_pack via sheets adapter', async () => {
    registerSheetsConnection();
    mockHttpExecutor.mockBody = {
      values: [
        ['p.mean', '0.45'],
        ['p.stdev', '3%'],
      ],
    };

    const result = await runner.execute(
      'sheets-readonly',
      {},
      {
        connection_string: {
          spreadsheet_id: 'sheet-id',
          range: 'Sheet1!A1:B2',
        },
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.raw.param_pack).toEqual({
      'p.mean': 0.45,
      'p.stdev': 0.03,
    });
    expect((result.raw.errors as any[]).some((e: any) => e.message.includes('even number'))).toBe(false);
  });

  it('returns error structure when parseSheetsRange helper is unavailable', async () => {
    // Register a connection that does NOT pass dasHelpers into JSONata to simulate missing helper
    const brokenConnection: ConnectionDefinition = {
      name: 'sheets-readonly-broken',
      provider: 'google-sheets',
      kind: 'http',
      enabled: true,
      auth_type: 'google-service-account',
      defaults: {
        api_version: 'v4',
      },
      adapter: {
        request: {
          url_template:
            'https://sheets.googleapis.com/v4/spreadsheets/{{{connection_string.spreadsheet_id}}}/values/{{{connection_string.range}}}',
          method: 'GET',
          headers: {
            Authorization: 'Bearer {{credentials.access_token}}',
          },
        },
        response: {
          extract: [
            { name: 'values', jmes: 'values' },
          ],
        },
        transform: [
          {
            name: 'parsed_result',
            jsonata: `
              (
                // Intentionally do NOT reference dasHelpers here
                {
                  "mode": "error",
                  "scalarValue": null,
                  "paramPack": {},
                  "errors": [
                    {
                      "row": 0,
                      "col": 0,
                      "message": "dasHelpers.parseSheetsRange not available"
                    }
                  ]
                }
              )
            `,
          },
          {
            name: 'scalar_value',
            jsonata: 'parsed_result.scalarValue',
          },
          {
            name: 'param_pack',
            jsonata: 'parsed_result.paramPack',
          },
          {
            name: 'errors',
            jsonata: 'parsed_result.errors',
          },
        ],
        upsert: {
          mode: 'replace',
          writes: [],
        },
      },
    };

    mockConnectionProvider.setMockConnection('sheets-readonly-broken', brokenConnection);
    mockHttpExecutor.mockBody = { values: [[0.45]] };

    const result = await runner.execute(
      'sheets-readonly-broken',
      {},
      {
        connection_string: {
          spreadsheet_id: 'sheet-id',
          range: 'Sheet1!A1',
        },
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected success');
    expect(result.raw.scalar_value).toBeNull();
    expect(result.raw.param_pack).toEqual({});
    expect((result.raw.errors as any[])[0].message).toContain('dasHelpers.parseSheetsRange not available');
  });
});


