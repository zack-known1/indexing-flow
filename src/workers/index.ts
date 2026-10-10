import { Worker } from 'bullmq';
import { queueRedis } from '../lib/redis';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { processUrlJob } from '../services/job/processor';
import { UrlJobPayload } from '../services/job/queue';

const worker = new Worker<UrlJobPayload>(
  'url-indexing-jobs',
  async (job) => {
    logger.info({ jobId: job.id, jobType: job.name }, 'Processing job');
    await processUrlJob(job.data);
  },
  {
    connection: queueRedis,
    prefix: env.REDIS_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
  }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
});

logger.info('Worker started');
