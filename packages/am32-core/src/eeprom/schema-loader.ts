/** Fetch/cache policy independent of HTTP, crypto, filesystem, and DOM APIs. */
import { BUNDLED_SCHEMA, BUNDLED_SCHEMA_SHA256, validateSchema, type EepromSchema } from './schema';

export interface LoadedSchema {
    schema: EepromSchema;
    source: 'bundled' | 'cached' | 'fetched';
    sha256: string;
}
export interface SchemaAsset { url: string; sha256?: string }
export interface SchemaCache {
    read(): Promise<string | null>;
    write(json: string): Promise<void>;
}
export interface SchemaLoaderOptions {
    latest(): Promise<SchemaAsset | null>;
    download(url: string): Promise<string>;
    sha256(text: string): Promise<string>;
    cache?: SchemaCache;
    bundledOnly?: boolean;
    log?: (message: string) => void;
}

export function bundledSchemaInfo (): LoadedSchema {
    return { schema: BUNDLED_SCHEMA, source: 'bundled', sha256: BUNDLED_SCHEMA_SHA256 };
}

export async function loadSchema (options: SchemaLoaderOptions): Promise<LoadedSchema> {
    if (options.bundledOnly) { return bundledSchemaInfo(); }
    let cached: LoadedSchema | null = null;
    try {
        const json = await options.cache?.read();
        if (json) {
            const schema: unknown = JSON.parse(json);
            validateSchema(schema);
            cached = { schema, source: 'cached', sha256: await options.sha256(json) };
        }
    } catch (error) { options.log?.(`Ignoring invalid EEPROM schema cache: ${String(error)}`); }
    try {
        const asset = await options.latest();
        if (!asset) { return cached ?? bundledSchemaInfo(); }
        const digest = asset.sha256?.replace(/^sha256:/, '').toLowerCase();
        if (cached && digest === cached.sha256) { return cached; }
        const json = await options.download(asset.url);
        const sha256 = await options.sha256(json);
        if (digest && sha256 !== digest) { throw new Error('EEPROM release asset SHA256 mismatch'); }
        const schema: unknown = JSON.parse(json);
        // Refuse unsupported languages even with a warm cache: use the known bundle.
        try { validateSchema(schema); } catch (error) {
            options.log?.(`Refusing EEPROM release schema: ${String(error)}`);
            return bundledSchemaInfo();
        }
        try { await options.cache?.write(json); } catch (error) {
            options.log?.(`Could not cache EEPROM schema: ${String(error)}`);
        }
        return { schema, source: 'fetched', sha256 };
    } catch (error) {
        options.log?.(`EEPROM schema refresh failed: ${String(error)}`);
        return cached ?? bundledSchemaInfo();
    }
}
