/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_SANDBOX_HOST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
