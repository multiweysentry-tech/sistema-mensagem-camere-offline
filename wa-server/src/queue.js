import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fila sequencial em memória. Não há paralelismo: cada job espera um intervalo
// aleatório e respeita um teto de envios por janela deslizante de 60 segundos.
export function createSendQueue({ logger, minDelayMs = 3000, maxDelayMs = 8000, maxPerMinute = 20, worker }) {
  const jobs = [];
  const enviadosNoMinuto = [];
  let processando = false;

  function intervalo() {
    return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
  }

  async function aguardarVaga() {
    await sleep(intervalo());
    while (true) {
      const agora = Date.now();
      while (enviadosNoMinuto.length && enviadosNoMinuto[0] <= agora - 60000) enviadosNoMinuto.shift();
      if (enviadosNoMinuto.length < maxPerMinute) return;
      const espera = Math.max(1000, enviadosNoMinuto[0] + 60000 - agora + intervalo());
      logger.warn({ event: 'queue.rate_limit', esperaMs: espera, limite: maxPerMinute });
      await sleep(espera);
    }
  }

  async function loop() {
    if (processando) return;
    processando = true;
    try {
      while (jobs.length) {
        const job = jobs[0];
        await aguardarVaga();
        jobs.shift();
        enviadosNoMinuto.push(Date.now());
        try {
          const resultado = await worker(job);
          job.resolve(resultado);
        } catch (error) {
          logger.error({
            event: 'send.failed',
            queueId: job.queueId,
            id: job.id,
            destino: job.destinoMascarado,
            erro: error.message
          });
          job.reject(error);
        }
      }
    } finally {
      processando = false;
    }
  }

  function enqueue(job) {
    const queueId = `fila_${randomUUID()}`;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Evita unhandled rejection se o chamador desistir da requisição.
    promise.catch(() => {});
    jobs.push({ ...job, queueId, resolve, reject });
    logger.info({
      event: 'send.enqueued',
      queueId,
      id: job.id,
      destino: job.destinoMascarado,
      posicao: jobs.length
    });
    queueMicrotask(() => { loop().catch(error => logger.error({ event: 'queue.error', erro: error.message })); });
    return { queueId, promise };
  }

  return { enqueue, pending: () => jobs.length, get processando() { return processando; } };
}
