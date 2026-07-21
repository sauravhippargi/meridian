import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from '@trigger.dev/sdk';

// Config is evaluated before the CLI injects .env.local into process.env for
// tasks — load it here so TRIGGER_PROJECT_REF resolves (otherwise we fall
// through to proj_placeholder and get a 404).
config({ path: resolve(process.cwd(), '.env.local') });

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_placeholder',
  dirs: ['./trigger'],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
});
