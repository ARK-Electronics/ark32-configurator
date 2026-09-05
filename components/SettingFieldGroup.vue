<template>
  <fieldset class="relative min-w-[100px] border border-gray-600 rounded p-4" :disabled="disabled" :class="{ 'opacity-50': disabled }">
    <legend class="px-2">
      {{ title }}
    </legend>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <slot />
    </div>
  </fieldset>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ title: string; disabled?: boolean }>(), { disabled: false });
</script>
