/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADDITIONAL_DETAILS_OPEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
