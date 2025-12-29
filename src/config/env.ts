import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_EMBED_MODEL: z.string().default('openai/text-embedding-3-small'),

  // Playwright
  PLAYWRIGHT_ENABLED: z.coerce.boolean().default(true),

  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Sentry
  SENTRY_DSN: z.string().optional(),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  
  return result.data;
}

export const env = loadEnv();
