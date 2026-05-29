/// <reference types="vite/client" />

import type { ViewerApi } from "../shared/types";

declare global {
  interface Window {
    audioLog: ViewerApi;
  }
}
