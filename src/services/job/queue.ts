import { Queue } from 'bullmq';
import { queueRedis } from '../../lib/redis';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export interface UrlJobPayload {
  jobId: string;
  workspaceId: string;
  urlId: string;
  propertyId: string;
  jobType: 'SUBMIT' | 'STATUS_CHECK' | 'PRECHECK';
  userId?: string;
}

export const urlJobsQueue = new Queue<UrlJobPayload>('url-indexing-jobs', {
  connection: queueRedis,
  prefix: env.REDIS_PREFIX,
  defaultJobOptions: {
    attempts: env.JOB_MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: env.JOB_BACKOFF_BASE_MS,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueUrlJob(payload: UrlJobPayload): Promise<string> {
  const job = await urlJobsQueue.add(payload.jobType, payload, {
    jobId: payload.jobId,
  });

  logger.info({ jobId: payload.jobId, urlId: payload.urlId, jobType: payload.jobType }, 'Enqueued URL job');
  return job.id!;
}
