import { defineConfig } from 'prisma/config';
import 'dotenv/config';

// Dummy default so `yarn dev` / ./run.sh work without MariaDB for passthrough-only use.
// Admin / sponsors / sessions need a real DATABASE_URL pointing at MySQL/MariaDB.
const databaseUrl = process.env.DATABASE_URL ??
    'mysql://am32:am32password@127.0.0.1:3308/am32';

export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: {
        path: 'prisma/migrations',
        seed: 'tsx prisma/seed.ts'
    },
    datasource: {
        url: databaseUrl
    }
});
