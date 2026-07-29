import { defineConfig } from 'prisma/config';
import 'dotenv/config';

// `prisma generate` only needs a URL shape; it does not connect to the DB.
// Allow CI/Nixpacks builds without secrets. Runtime still requires a real
// DATABASE_URL (see server/utils/database.ts).
const databaseUrl =
    process.env.DATABASE_URL ??
    'mysql://am32:am32password@127.0.0.1:3306/am32';

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
