/**
 * Liveness probe — does not touch the database.
 */
export default defineEventHandler(() => {
    return {
        ok: true,
        time: new Date().toISOString()
    };
});
