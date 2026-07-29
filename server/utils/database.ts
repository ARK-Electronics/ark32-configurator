import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '~/prisma/generated/client';

type DbConfig = {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
};

/**
 * Resolve MariaDB/MySQL connection settings.
 * Prefer DATABASE_URL (Sevalla internal URL), then discrete MYSQL_* vars.
 * Never silently fall back to 127.0.0.1 — that only works in local docker-compose.
 */
function resolveDbConfig (): DbConfig {
    const databaseUrl = process.env.DATABASE_URL?.trim();

    if (databaseUrl) {
        try {
            const parsed = new URL(databaseUrl);
            const database = parsed.pathname.replace(/^\//, '').split('/')[0];
            if (!parsed.hostname || !database) {
                throw new Error('DATABASE_URL must include host and database name');
            }
            return {
                host: parsed.hostname,
                port: Number(parsed.port || 3306),
                user: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password),
                database
            };
        } catch (err) {
            console.error('[db] Invalid DATABASE_URL:', err);
            throw new Error(
                'Invalid DATABASE_URL. Expected mysql://user:pass@host:3306/dbname'
            );
        }
    }

    const host = process.env.MYSQL_HOST || process.env.NUXT_MARIADB_HOST;
    const user = process.env.MYSQL_USER || process.env.NUXT_MARIADB_USER;
    const password = process.env.MYSQL_PASSWORD || process.env.NUXT_MARIADB_PASSWORD || '';
    const database = process.env.MYSQL_DATABASE || process.env.NUXT_MARIADB_DATABASE;
    const port = Number(
        process.env.MYSQL_PORT || process.env.NUXT_MARIADB_PORT || 3306
    );

    if (host && user && database) {
        return { host, port, user, password, database };
    }

    throw new Error(
        'Database not configured. Set DATABASE_URL (recommended) or MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE in Sevalla environment variables. Use the internal hostname from Sevalla Database, not 127.0.0.1.'
    );
}

const prismaClientSingleton = () => {
    const config = resolveDbConfig();

    console.info(
        `[db] Connecting to mysql://${config.user}@${config.host}:${config.port}/${config.database}`
    );

    const adapter = new PrismaMariaDb({
        host: config.host,
        user: config.user,
        password: config.password,
        port: config.port,
        database: config.database,
        connectionLimit: 10,
        connectTimeout: 10_000
    });
    return new PrismaClient({ adapter });
};

type PrismaClientSingleton = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClientSingleton | undefined;
};

function getPrisma (): PrismaClientSingleton {
    if (!globalForPrisma.prisma) {
        globalForPrisma.prisma = prismaClientSingleton();
    }
    return globalForPrisma.prisma;
}

/** Lazy proxy so missing env does not crash the process at import time. */
export const prisma = new Proxy({} as PrismaClientSingleton, {
    get (_target, prop, receiver) {
        const client = getPrisma();
        const value = Reflect.get(client, prop, receiver);
        return typeof value === 'function' ? value.bind(client) : value;
    }
});

// Sponsor database functions
function mapSponsor (sponsor: {
    id: string;
    name: string;
    image: string;
    url: string;
    class: string;
    hideAfter: Date | null;
    createdAt: Date;
    updatedAt: Date;
}): Sponsor {
    return {
        ...sponsor,
        hideAfter: sponsor.hideAfter ? sponsor.hideAfter.toISOString() : null,
        createdAt: sponsor.createdAt.toISOString(),
        updatedAt: sponsor.updatedAt.toISOString()
    };
}

export async function getAllSponsors (): Promise<Sponsor[]> {
    const sponsors = await prisma.sponsor.findMany({
        orderBy: { createdAt: 'desc' }
    });
    return sponsors.map(mapSponsor);
}

export async function getActiveSponsors (): Promise<Sponsor[]> {
    const sponsors = await prisma.sponsor.findMany({
        where: {
            OR: [
                { hideAfter: null },
                { hideAfter: { gt: new Date() } }
            ]
        },
        orderBy: { createdAt: 'desc' }
    });
    return sponsors.map(mapSponsor);
}

export async function getSponsorById (id: string): Promise<Sponsor | null> {
    const sponsor = await prisma.sponsor.findUnique({
        where: { id }
    });
    if (!sponsor) {
        return null;
    }
    return mapSponsor(sponsor);
}

export async function createSponsor (sponsorData: Omit<Sponsor, 'createdAt' | 'updatedAt'>): Promise<Sponsor> {
    const sponsor = await prisma.sponsor.create({
        data: {
            id: sponsorData.id,
            name: sponsorData.name,
            image: sponsorData.image,
            url: sponsorData.url,
            class: sponsorData.class,
            hideAfter: sponsorData.hideAfter ? new Date(sponsorData.hideAfter) : null
        }
    });
    return mapSponsor(sponsor);
}

export async function updateSponsor (id: string, updates: Partial<Omit<Sponsor, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Sponsor | null> {
    const existing = await prisma.sponsor.findUnique({ where: { id } });
    if (!existing) {
        return null;
    }

    const sponsor = await prisma.sponsor.update({
        where: { id },
        data: {
            ...(updates.name !== undefined && { name: updates.name }),
            ...(updates.image !== undefined && { image: updates.image }),
            ...(updates.url !== undefined && { url: updates.url }),
            ...(updates.class !== undefined && { class: updates.class }),
            ...(updates.hideAfter !== undefined && {
                hideAfter: updates.hideAfter ? new Date(updates.hideAfter) : null
            })
        }
    });

    return mapSponsor(sponsor);
}

export async function deleteSponsor (id: string): Promise<boolean> {
    try {
        await prisma.sponsor.delete({ where: { id } });
        return true;
    } catch {
        return false;
    }
}

// Session database functions
export async function getSession (token: string): Promise<{ username: string; expiresAt: number } | null> {
    const session = await prisma.session.findUnique({
        where: { token }
    });
    if (!session) {
        return null;
    }
    return {
        username: session.username,
        expiresAt: Number(session.expiresAt)
    };
}

export async function createSession (token: string, username: string, expiresAt: number): Promise<void> {
    await prisma.session.create({
        data: {
            token,
            username,
            expiresAt
        }
    });
}

export async function deleteSession (token: string): Promise<void> {
    await prisma.session.delete({ where: { token } }).catch(() => {});
}

export async function cleanExpiredSessions (): Promise<void> {
    await prisma.session.deleteMany({
        where: {
            expiresAt: { lt: BigInt(Date.now()) }
        }
    });
}

// Helper function to validate admin session
export async function validateAdminSession (event: any): Promise<{ username: string; expiresAt: number }> {
    const sessionToken = getCookie(event, 'session');

    if (!sessionToken) {
        throw createError({
            statusCode: 401,
            statusMessage: 'unauthorized'
        });
    }

    const session = await getSession(sessionToken);

    if (!session || session.expiresAt < Date.now()) {
        if (session) {
            await deleteSession(sessionToken);
        }
        deleteCookie(event, 'session');
        throw createError({
            statusCode: 401,
            statusMessage: 'unauthorized'
        });
    }

    return session;
}

// User database functions
export async function getAllUsers (): Promise<User[]> {
    const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' }
    });
    return users.map(user => ({
        ...user,
        password: undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    })) as User[];
}

export async function getUserById (id: string): Promise<User | null> {
    const user = await prisma.user.findUnique({
        where: { id }
    });
    if (!user) {
        return null;
    }
    return {
        ...user,
        password: undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    } as User;
}

export async function getUserByUsername (username: string): Promise<(User & { password: string }) | null> {
    return await prisma.user.findUnique({
        where: { username }
    });
}

export async function createUser (userData: { username: string; password: string; email?: string; role?: string }): Promise<User> {
    const user = await prisma.user.create({
        data: {
            username: userData.username,
            password: userData.password,
            email: userData.email || null,
            role: userData.role || 'user'
        }
    });
    return {
        ...user,
        password: undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    } as User;
}

export async function updateUser (id: string, updates: { username?: string; password?: string; email?: string | null; role?: string; active?: boolean }): Promise<User | null> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
        return null;
    }

    const user = await prisma.user.update({
        where: { id },
        data: {
            ...(updates.username !== undefined && { username: updates.username }),
            ...(updates.password !== undefined && { password: updates.password }),
            ...(updates.email !== undefined && { email: updates.email }),
            ...(updates.role !== undefined && { role: updates.role }),
            ...(updates.active !== undefined && { active: updates.active })
        }
    });

    return {
        ...user,
        password: undefined,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    } as User;
}

export async function deleteUser (id: string): Promise<boolean> {
    try {
        await prisma.user.delete({ where: { id } });
        return true;
    } catch {
        return false;
    }
}
