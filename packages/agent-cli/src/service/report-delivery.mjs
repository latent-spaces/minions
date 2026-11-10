// Independent delivery only: no controller, run registration or model dependency.
export function createReportDelivery({ store, send, now = Date.now, intervalMs = 20000 }) {
  if (!store || typeof send !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Delivery requires a store, sender and positive interval');
  const abort = new AbortController();
  let closed = false, task = null, lastError = null, counts = {};
  const status = () => ({ closed, running: Boolean(task), lastError, counts: { ...counts } });
  function drain() {
    if (closed) return Promise.resolve(status());
    if (task) return task;
    task = (async () => {
      const entries = await store.listDueReports({ now: now(), limit: 32 });
      const groups = new Map();
      for (const entry of entries) {
        const key = JSON.stringify(entry.target);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      const batches = [...groups.values()];
      let nextBatch = 0, storageError;
      async function deliver(entry) {
        try {
          const receipt = await send(entry, { signal: abort.signal });
          if (closed) return;
          if (receipt?.receiptId !== entry.expectedReceiptId) {
            const error = new Error('Cloud receipt does not match saved evidence');
            error.code = 'receipt_mismatch'; error.fatal = true; throw error;
          }
          await store.acknowledgeReport({ reportId: entry.reportId, receiptId: receipt.receiptId });
          return true;
        } catch (error) {
          if (closed) return;
          const code = typeof error.code === 'string' && /^[A-Za-z0-9_:.-]{1,100}$/.test(error.code) ? error.code : 'delivery_unavailable';
          lastError = code;
          // Never turn uncertain local persistence into a delivery retry/acknowledgement.
          if (code.startsWith('storage_')) throw error;
          const exponent = Math.min(entry.attempts ?? 0, 12);
          const retrySeconds = Math.min(3600, Math.max(1, Number(error.retryAfter) || 0, 2 ** exponent));
          await store.failReport({ reportId: entry.reportId, errorCode: code,
            retryAt: error.fatal === true ? null : now() + Math.ceil(retrySeconds * 1000) });
          return false;
        }
      }
      async function worker() {
        while (!closed && !storageError) {
          const batch = batches[nextBatch++];
          if (!batch) return;
          for (const entry of batch) {
            if (closed || storageError) break;
            try { if (await deliver(entry) !== true) break; } catch (error) { storageError ??= error; break; }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
      if (storageError) throw storageError;
      const health = await store.health(); counts = health.reports ?? {};
      return status();
    })().catch(error => { lastError = typeof error.code === 'string' ? error.code : 'delivery_storage_failure'; throw error; })
      .finally(() => { task = null; });
    return task;
  }
  const timer = setInterval(() => { void drain().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { drain, status, async close() { if (closed) return; closed = true; clearInterval(timer); abort.abort(); await task?.catch(() => {}); } };
}
