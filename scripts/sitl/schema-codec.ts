/** Test-only stdin/stdout bridge to the production EEPROM codec. */
import { readFileSync } from 'node:fs';
import { decode, encode } from '../../packages/am32-core/src/eeprom/codec';
import { defaultSettings } from '../../packages/am32-core/src/eeprom/defaults';
import {
    contextFromImage, fromRaw, resolveSchema, toRaw, validateSchema
} from '../../packages/am32-core/src/eeprom/schema';

interface Request {
    schemaPath: string;
    image: number[];
    rawPatch?: Record<string, number>;
    displayPatch?: Record<string, number>;
    defaults?: boolean;
}

const request = JSON.parse(readFileSync(0, 'utf8')) as Request;
const schema: unknown = JSON.parse(readFileSync(request.schemaPath, 'utf8'));
validateSchema(schema);
const base = Uint8Array.from(request.image);
const context = contextFromImage(base);
const resolved = resolveSchema(schema, context);
const patch = { ...(request.defaults ? defaultSettings(schema, context) : {}), ...request.rawPatch };
for (const [alias, display] of Object.entries(request.displayPatch ?? {})) {
    const field = resolved.aliases[alias];
    if (!field) {
        throw new Error(`Field ${alias} absent for firmware ${context.firmware}`);
    }
    patch[alias] = toRaw(field, display);
}
const image = encode(patch, schema, base, context);
const settings = decode(image, schema, context);
const display: Record<string, number> = {};
for (const [alias, field] of Object.entries(resolved.aliases)) {
    const raw = settings[alias];
    if (typeof raw === 'number') {
        display[alias] = fromRaw(field, raw);
    }
}
process.stdout.write(JSON.stringify({
    context,
    image: Array.from(image),
    settings,
    display
}));
