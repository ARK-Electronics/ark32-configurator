export default defineEventHandler(async () => {
    try {
        const sponsors = await getActiveSponsors();
        return { data: sponsors };
    } catch (err) {
        // Public homepage must not 500 if DB is missing/misconfigured.
        console.error('[api/sponsors] database unavailable:', err);
        return { data: [] as Sponsor[] };
    }
});
