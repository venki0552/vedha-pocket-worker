import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import * as Sentry from '@sentry/node';
import { createServiceClient } from '@vedha/db';
import { env } from './config/env.js';
import { processIngestUrl } from './processors/ingest-url.js';
import { processIngestFile } from './processors/ingest-file.js';
import { processChunkMemory } from './processors/chunk-memory.js';

// Initialize Sentry
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}

// Redis connection
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Supabase service client
const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log('🚀 Starting Vedha Pocket Worker...');
console.log(`📡 Connected to Redis: ${env.REDIS_URL.replace(/:[^:@]*@/, ':***@')}`);

// Job types
interface IngestUrlJob {
  type: 'ingest_url';
  sourceId: string;
  orgId: string;
  pocketId: string;
  url: string;
}

interface IngestFileJob {
  type: 'ingest_file';
  sourceId: string;
  orgId: string;
  pocketId: string;
  storagePath: string;
  mimeType: string;
}

type IngestJob = IngestUrlJob | IngestFileJob;

// Memory job type
interface ChunkMemoryJob {
  memoryId: string;
  orgId: string;
  userId: string;
}

// Create ingest worker
const ingestWorker = new Worker<IngestJob>(
  'ingest',
  async (job: Job<IngestJob>) => {
    console.log(`📋 Processing job ${job.id}: ${job.name}`);
    
    try {
      if (job.data.type === 'ingest_url') {
        await processIngestUrl(supabase, job.data);
      } else if (job.data.type === 'ingest_file') {
        await processIngestFile(supabase, job.data);
      }
      
      console.log(`✅ Job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`❌ Job ${job.id} failed:`, error);
      
      // Log error to Sentry
      if (env.SENTRY_DSN) {
        Sentry.captureException(error, {
          extra: { jobId: job.id, jobData: job.data },
        });
      }
      
      // Update source status to failed
      await supabase
        .from('sources')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', job.data.sourceId);
      
      // Log audit event
      await supabase.from('audit_events').insert({
        org_id: job.data.orgId,
        pocket_id: job.data.pocketId,
        event_type: 'pipeline_failed',
        metadata: {
          source_id: job.data.sourceId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
  }
);

// Create memory worker
const memoryWorker = new Worker<ChunkMemoryJob>(
  'memory',
  async (job: Job<ChunkMemoryJob>) => {
    console.log(`🧠 Processing memory job ${job.id}: ${job.name}`);
    
    try {
      await processChunkMemory(supabase, job.data);
      console.log(`✅ Memory job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`❌ Memory job ${job.id} failed:`, error);
      
      // Log error to Sentry
      if (env.SENTRY_DSN) {
        Sentry.captureException(error, {
          extra: { jobId: job.id, jobData: job.data },
        });
      }
      
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
  }
);

// Worker event handlers
ingestWorker.on('completed', (job) => {
  console.log(`📦 Ingest job ${job.id} has been completed`);
});

ingestWorker.on('failed', (job, err) => {
  console.error(`💥 Ingest job ${job?.id} has failed:`, err.message);
});

ingestWorker.on('error', (err) => {
  console.error('Ingest worker error:', err);
});

memoryWorker.on('completed', (job) => {
  console.log(`📦 Memory job ${job.id} has been completed`);
});

memoryWorker.on('failed', (job, err) => {
  console.error(`💥 Memory job ${job?.id} has failed:`, err.message);
});

memoryWorker.on('error', (err) => {
  console.error('Memory worker error:', err);
});

// Graceful shutdown
async function shutdown() {
  console.log('🛑 Shutting down workers...');
  await ingestWorker.close();
  await memoryWorker.close();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('✅ Workers are ready and listening for jobs');
