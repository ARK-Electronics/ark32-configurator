import { refreshUiSchema } from '~/utils/load-ui-schema';

export default defineNuxtPlugin(() => {
    refreshUiSchema();
});
