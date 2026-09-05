<template>
  <div class="flex flex-col gap-4">
    <SettingFieldGroup v-for="group in groups" :key="group.key" :title="group.name || group.key" :disabled="disabled || group.disabled">
      <SettingField
        v-for="field in group.fields"
        :key="field.key"
        :definition="field"
        :schema="schema!"
        :esc-info="escInfo"
        :individual="individual"
        :disabled="disabled || group.disabled"
        @change="emit('change', $event)"
      />
    </SettingFieldGroup>
  </div>
</template>
<script setup lang="ts">
import type { McuInfo } from 'am32-core/mcu';
import { panelGroups, schemaForEsc } from '~/utils/schema-settings';
import type { SettingChange } from '~/utils/schema-settings';

const props = withDefaults(defineProps<{
    panel: 'settings' | 'tune' | 'esc';
    escInfo: McuInfo[];
    individual?: number;
    disabled?: boolean;
}>(), { individual: undefined, disabled: false });
const emit = defineEmits<{(e: 'change', change: SettingChange): void}>();
const info = computed(() => props.escInfo[props.individual ?? 0]);
const schema = computed(() => info.value ? schemaForEsc(info.value) : undefined);
const groups = computed(() => schema.value && info.value ? panelGroups(schema.value, info.value.settings, props.panel) : []);
</script>
