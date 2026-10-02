/// <reference types="vite/client" />

declare const __HEED_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENV?: string;
}
