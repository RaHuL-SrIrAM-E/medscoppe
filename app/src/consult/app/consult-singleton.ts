import { createConsultRuntime } from './consult-runtime.js';

/** The one consultation app instance for the running application. Spatial systems read it; they never own consultation state. */
export const consultApp = createConsultRuntime();
