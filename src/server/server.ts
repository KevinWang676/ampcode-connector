/** HTTP server — routes provider requests through local OAuth or Amp upstream. */

import { maybeShowAd } from "../cli/ads.ts";
import type { ProxyConfig } from "../config/config.ts";
import * as rewriter from "../proxy/rewriter.ts";
import * as upstream from "../proxy/upstream.ts";
import { affinity } from "../routing/affinity.ts";
import { tryReroute, tryWithCachePreserve } from "../routing/retry.ts";
import { recordSuccess, routeRequest } from "../routing/router.ts";
import { handleInternal, isLocalMethod } from "../tools/internal.ts";
import { logger } from "../utils/logger.ts";
import * as path from "../utils/path.ts";
import { apiError } from "../utils/responses.ts";
import { stats } from "../utils/stats.ts";
import { type ParsedBody, parseBody } from "./body.ts";
import { NeoLocalPersistence } from "./neo-local-persistence.ts";
import { jsonRecord } from "./neo-protocol.ts";
import { startRivetProxy } from "./rivet-proxy.ts";

export function startServer(config: ProxyConfig): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: config.port,
    hostname: config.hostname,
    idleTimeout: 255, // seconds — LLM streaming responses can take minutes

    async fetch(req) {
      const startTime = Date.now();
      const url = new URL(req.url);
      let status = 500;
      try {
        const response = await handle(req, url, config);
        status = response.status;
        return response;
      } catch (err) {
        logger.error("Unhandled server error", { error: String(err) });
        return apiError(status, "Internal proxy error");
      } finally {
        logger.info(`${req.method} ${url.pathname}${url.search} ${status}`, { duration: Date.now() - startTime });
      }
    },
  });

  const rivetProxy = startRivetProxy(config);

  affinity.startCleanup();
  logger.info(`ampcode-connector listening on http://${config.hostname}:${config.port}`);

  const shutdown = () => {
    logger.info("Shutting down...");
    server.stop();
    rivetProxy?.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}

async function handle(req: Request, url: URL, config: ProxyConfig): Promise<Response> {
  const { pathname, search } = url;

  if ((pathname === "/" || pathname === "/status") && req.method === "GET") {
    return healthCheck(config);
  }

  if (path.browser(pathname)) {
    const target = new URL(pathname + search, config.ampUpstreamUrl);
    return Response.redirect(target.toString(), 302);
  }

  const localThreadMutation = await handleLocalThreadMutation(req, url);
  if (localThreadMutation) return localThreadMutation;

  const localThread = await handleLocalThreadApi(req, url);
  if (localThread) return localThread;

  if (pathname === "/api/threads/sync" && req.method === "POST") {
    return forwardThreadSync(req, config);
  }

  if (path.passthrough(pathname)) {
    if (pathname.startsWith("/api/internal") && isLocalMethod(search)) {
      return handleInternal(req, search, config);
    }
    return upstream.forward(req, config.ampUpstreamUrl, config.ampApiKey);
  }

  const providerName = path.provider(pathname);
  if (providerName) return handleProvider(req, providerName, pathname, config);

  return upstream.forward(req, config.ampUpstreamUrl, config.ampApiKey);
}

async function forwardThreadSync(req: Request, config: ProxyConfig): Promise<Response> {
  const response = await upstream.forward(req, config.ampUpstreamUrl, config.ampApiKey);
  void importThreadSyncResponse(response.clone()).catch((err) => {
    logger.warn("Failed to import Amp thread sync response into local Neo store", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return response;
}

async function importThreadSyncResponse(response: { ok: boolean; json(): Promise<unknown> }): Promise<void> {
  if (!response.ok) return;
  const body = jsonRecord(await response.json().catch(() => ({})));
  const actions = Array.isArray(body.threadActions) ? body.threadActions.map(jsonRecord) : [];
  if (actions.length === 0) return;
  const store = new NeoLocalPersistence();
  let imported = 0;
  for (const action of actions) {
    const threadId = typeof action.id === "string" ? action.id : undefined;
    if (action.action === "download") {
      const thread = normalizeSyncThread(action.thread, threadId);
      if (thread && store.importCloudThread(thread)) imported++;
    }
    if (action.action === "meta" && threadId) store.updateCloudState(threadId, { meta: jsonRecord(action.meta) });
  }
  if (imported > 0) logger.info("Imported Amp thread sync downloads into local Neo store", { count: imported });
}

function normalizeSyncThread(value: unknown, fallbackId?: string): Record<string, unknown> | null {
  const raw = jsonRecord(value);
  const data = jsonRecord(raw.data);
  const thread = Object.keys(data).length > 0 ? data : raw;
  if (typeof thread.id !== "string" && fallbackId) thread.id = fallbackId;
  return typeof thread.id === "string" && Array.isArray(thread.messages) ? thread : null;
}

async function handleLocalThreadMutation(req: Request, url: URL): Promise<Response | null> {
  const store = new NeoLocalPersistence();
  if (req.method === "DELETE" && url.pathname.startsWith("/api/threads/")) {
    store.deleteThread(decodeURIComponent(url.pathname.slice("/api/threads/".length)));
    return null;
  }

  if (req.method !== "POST" || url.pathname !== "/api/internal") return null;
  const method = url.search.replace("?", "");
  if (!["deleteThread", "archiveThread", "setThreadMeta", "uploadThread"].includes(method)) return null;
  const params = await internalParams(req.clone());
  const threadId = typeof params.thread === "string" ? params.thread : jsonRecord(params.thread).id;
  if (typeof threadId !== "string") return null;

  if (method === "deleteThread") store.deleteThread(threadId);
  if (method === "archiveThread") store.updateCloudState(threadId, { archived: true });
  if (method === "setThreadMeta") store.updateCloudState(threadId, { meta: jsonRecord(params.meta) });
  if (method === "uploadThread") store.updateCloudState(threadId, { meta: jsonRecord(jsonRecord(params.thread).meta) });
  return null;
}

async function internalParams(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return jsonRecord(body.params);
  } catch {
    return {};
  }
}

async function handleLocalThreadApi(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const store = new NeoLocalPersistence();
  const { pathname, searchParams } = url;

  if (pathname === "/api/threads/find") {
    const limit = Number(searchParams.get("limit") ?? 20);
    const offset = Number(searchParams.get("offset") ?? 0);
    const threads = store.findThreads(
      searchParams.get("q") ?? "",
      Number.isFinite(limit) ? limit : 20,
      Number.isFinite(offset) ? offset : 0,
    );
    if (threads.length > 0 || searchParams.get("local") === "1") return Response.json({ threads });
    return null;
  }

  if (!pathname.startsWith("/api/threads/")) return null;
  let threadPath = pathname.slice("/api/threads/".length);
  let kind: ".md" | "/export" | undefined;
  if (threadPath.endsWith(".md")) {
    kind = ".md";
    threadPath = threadPath.slice(0, -3);
  } else if (threadPath.endsWith("/export")) {
    kind = "/export";
    threadPath = threadPath.slice(0, -"/export".length);
  }
  const threadId = decodeURIComponent(threadPath);
  if (kind === ".md") {
    const markdown = store.markdownForThread(threadId);
    return markdown ? new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } }) : null;
  }
  if (kind === "/export" || searchParams.get("local") === "1") {
    const json = store.jsonForThread(threadId);
    return json ? Response.json(json) : null;
  }
  return null;
}

async function handleProvider(
  req: Request,
  providerName: string,
  pathname: string,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = Date.now();
  const sub = path.subpath(pathname);
  const threadId = req.headers.get("x-amp-thread-id") ?? req.headers.get("x-session-id") ?? undefined;

  const rawBody = req.method === "POST" ? await req.text() : "";
  const body = parseBody(rawBody, sub);
  const ampModel = body.ampModel;
  const route = routeRequest(providerName, ampModel, config, threadId);

  logger.info(
    `ROUTE ${route.decision} provider=${providerName} model=${ampModel ?? "?"} account=${route.account} sub=${sub}`,
  );

  let response: Response;

  if (route.handler) {
    const rewrite = ampModel ? rewriter.rewrite(ampModel) : undefined;
    const handlerResponse = await route.handler.forward(sub, body, req.headers, rewrite, route.account, config);

    if (
      (handlerResponse.status === 429 || handlerResponse.status === 403 || handlerResponse.status === 404) &&
      route.pool
    ) {
      const ctx = { providerName, ampModel, config, sub, body, headers: req.headers, rewrite, threadId };
      // 429: try short wait to preserve prompt cache first
      const cached =
        handlerResponse.status === 429
          ? await tryWithCachePreserve(route, sub, body, req.headers, rewrite, handlerResponse)
          : null;
      if (cached) {
        response = cached;
      } else {
        const rerouted = await tryReroute(ctx, route, handlerResponse.status);
        response = rerouted ?? (await fallbackUpstream(req, body, config));
      }
    } else if (handlerResponse.status === 401) {
      logger.debug("Local provider denied, falling back to upstream");
      response = await fallbackUpstream(req, body, config);
    } else {
      if (route.pool) recordSuccess(route.pool, route.account);
      response = handlerResponse;
    }
  } else {
    response = await fallbackUpstream(req, body, config);
  }

  stats.record({
    timestamp: new Date().toISOString(),
    route: route.decision,
    provider: providerName,
    model: ampModel ?? "unknown",
    statusCode: response.status,
    durationMs: Date.now() - startTime,
  });

  maybeShowAd();

  return response;
}

/** Fall back to Amp upstream when local providers fail. */
function fallbackUpstream(req: Request, body: ParsedBody, config: ProxyConfig): Promise<Response> {
  const upstreamReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: body.raw || undefined,
  });
  return upstream.forward(upstreamReq, config.ampUpstreamUrl, config.ampApiKey);
}

function healthCheck(config: ProxyConfig): Response {
  return Response.json({
    status: "ok",
    service: "ampcode-connector",
    port: config.port,
    upstream: config.ampUpstreamUrl,
    providers: config.providers,
    stats: stats.snapshot(),
  });
}
