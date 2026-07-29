export default defineEventHandler(async () => {
    try {
        const sponsors = await getActiveSponsors();
        return { data: sponsors };
    } catch (error) {
        // No MariaDB in local passthrough mode — homepage logos are optional.
        console.warn('[api/sponsors] database unavailable, returning empty list:',
            error instanceof Error ? error.message : error);
        return { data: [] as Sponsor[] };
    }
});
