import { defineConfig } from 'vitest/config';

// Deliberately a plain vitest config rather than Nuxt's test environment.
// Everything under packages/ is pure protocol code that must run without a DOM,
// so the default node environment is the correct one -- if a test starts needing
// jsdom, that is a signal the code under test drifted out of the core.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['packages/**/*.{test,spec}.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', '.nuxt/**', '.output/**'],
        // Protocol tests run against a virtual clock (block 2 onward), so a slow
        // test means a real hang, not a slow machine.
        testTimeout: 10_000
    }
});
