// Fila persistente em Postgres: idempotente, com retries e sem perder tarefas no restart.
const { randomUUID } = require('crypto');
const { log } = require('./logger');

function createQueue({ db, workerId = `worker-${process.pid}`, pollMs = 1000, batchSize = 5 } = {}) {
  if (!db || typeof db.claimJobs !== 'function') throw new Error('createQueue exige db com claimJobs');
  const handlers = new Map();
  let timer = null;
  let running = false;

  function register(kind, handler) {
    if (typeof handler !== 'function') throw new Error('Handler invalido');
    handlers.set(kind, handler);
  }

  async function enqueue({ kind, payload = {}, tenantId = 'default', instanceId = 'default', idempotencyKey, maxAttempts = 3, runAt }) {
    const key = idempotencyKey || `${kind}:${tenantId}:${instanceId}:${JSON.stringify(payload)}`;
    const result = await db.createJob({
      id: randomUUID(),
      kind,
      payload,
      tenantId,
      instanceId,
      idempotencyKey: key,
      maxAttempts,
      runAt: runAt || new Date().toISOString()
    });
    return { queued: Boolean(result?.rowCount), key };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const kinds = [...handlers.keys()];
      if (!kinds.length) return;
      const jobs = await db.claimJobs({ kinds, limit: batchSize, workerId });
      for (const job of jobs) {
        const handler = handlers.get(job.kind);
        try {
          const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
          await handler(payload, job);
          await db.finishJob(job.id, { ok: true });
          log('info', 'queue.job_done', { jobId: job.id, kind: job.kind, tenantId: job.tenant_id });
        } catch (error) {
          await db.failJob(job.id, error);
          log('error', 'queue.job_failed', { jobId: job.id, kind: job.kind, tenantId: job.tenant_id, error });
        }
      }
    } catch (error) {
      log('error', 'queue.poll_failed', { error });
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch(() => {}), pollMs);
    timer.unref?.();
    log('info', 'queue.started', { workerId, pollMs });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { register, enqueue, tick, start, stop, handlers };
}

module.exports = { createQueue };
