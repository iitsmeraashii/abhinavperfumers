/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADDITIONAL_DETAILS_OPEN?: string;
  readonly VITE_USE_ALPE_PROCESSING?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
