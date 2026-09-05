<template>
  <div :class="{ 'opacity-50': isDisabled }">
    <UFormGroup :label="definition.name || definition.key" :help="definition.description" :error="melodyError || undefined">
      <template #hint>
        <UButton v-if="definition.default && !definition.preserveOnDefaults" size="2xs" variant="ghost" :disabled="isDisabled" @click="resetField">
          Reset
        </UButton>
      </template>
      <UCheckbox v-if="widget === 'checkbox'" v-model="boolValue" :disabled="isDisabled" :aria-label="definition.name || definition.key" />
      <USelect v-else-if="widget === 'select'" v-model="value" :disabled="isDisabled" :options="options" />
      <URadioGroup v-else-if="widget === 'radio'" v-model="value" :disabled="isDisabled" :options="options" />
      <div v-else-if="widget === 'slider'" class="space-y-2">
        <UCheckbox v-if="definition.disabledValue" v-model="limitEnabled" label="Enabled" :disabled="isDisabled" />
        <URange v-model="value" :disabled="isDisabled || isOff" :min="bounds.min" :max="bounds.max" :step="bounds.step" />
        <div v-if="isOff">
          Disabled
        </div>
        <div v-else>
          {{ value.toFixed(bounds.decimals) }} {{ definition.unit }}
        </div>
      </div>
      <UTextarea v-else-if="widget === 'rtttl'" v-model="rtttlValue" :disabled="isDisabled" placeholder="RTTTL String" />
      <div v-if="escInfo.length > 1 && widget !== 'rtttl'" class="flex gap-1 pt-2" aria-label="Selected ESC values">
        <span
          v-for="(esc, index) in escInfo"
          :key="index"
          class="w-2.5 h-2.5 rounded-full"
          :class="esc.settings[alias] === rawValue ? 'bg-green-500' : 'bg-red-500'"
          :title="`ESC ${index + 1}: ${esc.settings[alias]}`"
        />
      </div>
    </UFormGroup>
  </div>
</template>
<script setup lang="ts">
import Rtttl from 'bluejay-rtttl-parse';
import { evaluatePredicate, fieldDefaultRaw, fromRaw, isDisabledRaw, toRaw } from 'am32-core/eeprom/schema';
import type { ResolvedField, ResolvedSchema } from 'am32-core/eeprom/schema';
import type { McuInfo } from 'am32-core/mcu';
import { sliderBounds, widgetForField } from '~/utils/schema-settings';
import type { SettingChange } from '~/utils/schema-settings';

const props = withDefaults(defineProps<{
    definition: ResolvedField;
    schema: ResolvedSchema;
    escInfo: McuInfo[];
    individual?: number;
    disabled?: boolean;
}>(), { individual: undefined, disabled: false });
const emit = defineEmits<{(e: 'change', change: SettingChange): void}>();
const alias = computed(() => props.definition.alias![0]);
const info = computed(() => props.escInfo[props.individual ?? 0]);
const rawValue = computed(() => info.value?.settings[alias.value]);
const widget = computed(() => widgetForField(props.definition));
const bounds = computed(() => sliderBounds(props.definition));
const options = computed(() => props.definition.values?.map(entry => ({ value: entry.raw, label: entry.name })) ?? []);
const isDisabled = computed(() => props.disabled || (props.definition.ui?.disabledWhen
    ? evaluatePredicate(props.definition.ui.disabledWhen, info.value.settings, props.schema)
    : false));
const isOff = computed(() => typeof rawValue.value === 'number' && isDisabledRaw(props.definition, rawValue.value));
const change = (value: number | number[]) => {
    if (!isDisabled.value) {
        emit('change', { field: alias.value, value, individual: props.individual });
    }
};
const value = computed({
    get: () => widget.value === 'slider' ? fromRaw(props.definition, Number(rawValue.value)) : Number(rawValue.value),
    set: (display: number | string) => change(widget.value === 'slider' ? toRaw(props.definition, Number(display)) : Number(display))
});
const boolValue = computed({
    get: () => Number(rawValue.value) !== 0 && Number(rawValue.value) !== 255,
    set: (enabled: boolean) => change(enabled ? 1 : 0)
});
const limitEnabled = computed({
    get: () => !isOff.value,
    set: (enabled: boolean) => {
        if (!enabled) {
            change(props.definition.disabledValue!.raw);
            return;
        }
        const fallback = fieldDefaultRaw(props.definition);
        const minimum = props.definition.raw?.min ?? 0;
        change(typeof fallback === 'number' && !isDisabledRaw(props.definition, fallback)
            ? fallback
            : (isDisabledRaw(props.definition, minimum) ? minimum + 1 : minimum));
    }
});
const resetField = () => {
    const raw = fieldDefaultRaw(props.definition);
    if (raw !== undefined) {
        change(raw);
    }
};
const melodyError = ref('');
const rtttlValue = computed({
    get: () => {
        let bytes = Array.isArray(rawValue.value) ? rawValue.value : [];
        for (let i = 0; i < bytes.length - 1; ++i) {
            if ((bytes[i] === 0 && bytes[i + 1] === 0) || (bytes[i] === 255 && bytes[i + 1] === 255)) {
                bytes = bytes.slice(0, i);
                break;
            }
        }
        try {
            return Rtttl.fromBluejayStartupMelody(new Uint8Array(bytes));
        } catch {
            return '';
        }
    },
    set: (text: string) => {
        try {
            const { data, errorCodes } = Rtttl.toBluejayStartupMelody(text, props.definition.size);
            if (errorCodes.includes(2)) {
                throw new Error(`Melody exceeds ${props.definition.size} bytes`);
            }
            if (errorCodes.includes(1)) {
                throw new Error('Melody contains an unsupported note');
            }
            melodyError.value = '';
            change(Array.from(data));
        } catch (error) {
            melodyError.value = error instanceof Error ? error.message : 'Invalid RTTTL melody';
        }
    }
});
</script>
