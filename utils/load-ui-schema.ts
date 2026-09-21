import { validateSchema } from 'am32-core/eeprom/schema';
import { bundledSchemaInfo } from 'am32-core/eeprom/schema-loader';
import type { LoadedSchema } from 'am32-core/eeprom/schema-loader';

/** Server owns release discovery and persistent checksum caching. */
export async function loadUiSchema (): Promise<LoadedSchema> {
    try {
        const response = await fetch('/api/eeprom-schema', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            throw new Error(`Schema fetch failed: ${response.status}`);
        }
        const result: LoadedSchema = await response.json();
        validateSchema(result.schema);
        if (!['cached', 'fetched', 'bundled'].includes(result.source) || !/^[a-f0-9]{64}$/.test(result.sha256)) {
            throw new Error('Invalid schema response metadata');
        }
        return result;
    } catch {
        return bundledSchemaInfo();
    }
}

// Share an in-flight startup fetch with Connect, but refresh on subsequent connects.
let pending: Promise<LoadedSchema> | undefined;
export function refreshUiSchema (): Promise<LoadedSchema> {
    if (!pending) {
        pending = loadUiSchema().finally(() => { pending = undefined; });
    }
    return pending;
}
