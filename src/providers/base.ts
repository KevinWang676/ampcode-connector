/** Provider interface — the contract every provider must implement. */

import type { ProxyConfig } from "../config/config.ts";
import type { ParsedBody } from "../server/body.ts";
import type { RouteDecision } from "../utils/logger.ts";

export interface Provider {
  readonly name: string;
  readonly routeDecision: RouteDecision;
  isAvailable(account?: number, config?: ProxyConfig): boolean;
  accountCount(config?: ProxyConfig): number;
  forward(
    path: string,
    body: ParsedBody,
    headers: Headers,
    rewrite?: (data: string) => string,
    account?: number,
    config?: ProxyConfig,
    signal?: AbortSignal,
  ): Promise<Response>;
}
