import { createBrokkClient } from "@brokk/sdk";

/** Browser client for the control plane. Defaults to the same-origin `/api`
 *  proxy (see next.config rewrites); override with NEXT_PUBLIC_BROKK_API_URL. */
export const brokk = createBrokkClient({
  baseUrl: process.env.NEXT_PUBLIC_BROKK_API_URL || "/api",
});
