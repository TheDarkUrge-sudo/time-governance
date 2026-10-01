import { defineConfig } from 'vitest/config';

// Tests never talk to the real Karbon, SendGrid or a real database: Karbon and
// SendGrid go through fake transports, and the database is an in-process
// PGlite. Blank the credentials so a stray .env can't turn a test into a live call.
process.env.KARBON_API_KEY = '';
process.env.KARBON_API_SECRET = '';
process.env.SENDGRID_API_KEY = '';
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
