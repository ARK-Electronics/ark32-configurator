import { defineConfig } from 'prisma/config';
import 'dotenv/config';

// prisma generate does not open a DB connection, but Prisma still requires a URL
// string. Use a non-routable placeholder only when unset — never bake this into
// the Nuxt server bundle (do not export DATABASE_URL during `nuxt build`).
const databaseUrl =
    process.env.DATABASE_URL ||
    'mysql://build:build@prisma-generate.invalid:3306/build';

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
