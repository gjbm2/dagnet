import { credentialsManager } from '../credentials';
import { BrowserHttpExecutor } from './BrowserHttpExecutor';
import { ServerHttpExecutor } from './ServerHttpExecutor';
import { IndexedDBConnectionProvider } from './IndexedDBConnectionProvider';
import { FileSystemConnectionProvider } from './FileSystemConnectionProvider';
import { DASRunner } from './DASRunner';

interface DASRunnerFactoryOptions {
  /**
   * Custom HTTP executor (used mainly for testing/mocking).
   */
  httpExecutor?: BrowserHttpExecutor | ServerHttpExecutor;
  /**
   * Custom connection provider.
   */
  connectionProvider?: IndexedDBConnectionProvider | FileSystemConnectionProvider;
  /**
   * Path to connections.yaml when running outside the browser.
   */
  serverConnectionsPath?: string;
}

export function createDASRunner(options: DASRunnerFactoryOptions = {}): DASRunner {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  const httpExecutor =
    options.httpExecutor ??
    (isBrowser ? new BrowserHttpExecutor() : new ServerHttpExecutor());

  const connectionProvider =
    options.connectionProvider ??
    (isBrowser
      ? new IndexedDBConnectionProvider()
      : new FileSystemConnectionProvider(options.serverConnectionsPath));

  return new DASRunner(httpExecutor, credentialsManager, connectionProvider);
}








