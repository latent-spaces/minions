import { createServer } from 'node:http';
import type { Express } from 'express';

type LocalWorker = { stop(): Promise<void>; queue: { drained(): Promise<void> } };

/**
 * Signals that stop the standalone engine gracefully, releasing its lock. Windows also sends SIGBREAK for Ctrl+Break
 * and SIGHUP when its console window closes, then ends the process about 10 s later. On POSIX an engine supervised
 * over IPC (npm run setup) also stops on SIGHUP, which its closed terminal sends to it and its supervisor alike;
 * an unsupervised one keeps the default, so an engine started with nohup survives a closed terminal.
 */
export function standaloneStopSignals(platform: NodeJS.Platform = process.platform, supervised = false): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : supervised ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];
}

/** One API and worker share the same store and in-process change listeners. */
export async function startSelfHostedRuntime({ app, host, port, startWorker, drain, closeStore, httpGraceMs = 2_500 }: {
  app: Express;
  host: string;
  port: number;
  startWorker(): LocalWorker;
  drain(): void;
  closeStore(): void | Promise<void>;
  httpGraceMs?: number;
}) {
  const server = createServer(app);
  let worker: LocalWorker | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Release held control requests before waiting for HTTP connections to finish.
    drain();
    const stopped = new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      // Event streams can remain open indefinitely. Give in-flight requests a grace period,
      // then close their sockets so an idle viewer cannot prevent the store from closing.
      const grace = setTimeout(() => server.closeAllConnections(), httpGraceMs);
      grace.unref();
      server.close(error => { clearTimeout(grace); error ? reject(error) : resolve(); });
      server.closeIdleConnections();
    });
    // A running reconcile may enqueue hints, so stop it before draining the queue.
    const delivered = (async () => { if (worker) { await worker.stop(); await worker.queue.drained(); } })();
    // All store users must finish before the SQLite handle closes.
    const results = await Promise.allSettled([stopped, delivered]);
    await closeStore();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.removeListener('listening', ready); reject(error); };
      const ready = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, host);
    });
    worker = startWorker();
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}
