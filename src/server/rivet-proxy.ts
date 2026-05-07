/** Local RivetKit/Neo actor entrypoint.
 *
 * Amp Neo derives a local Rivet endpoint (http://localhost:6420) when amp.url is
 * localhost. By default the connector serves a local ThreadActor-compatible
 * runtime there so model calls can use connector-local provider accounts.
 *
 * Set AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG=1 to run the older hosted actor
 * bridge for debugging protocol changes against Amp's upstream actor service.
 * The hosted actor token may be present in a local env file without changing
 * the default local runtime.
 */

import type { ProxyConfig } from "../config/config.ts";
import { logger } from "../utils/logger.ts";
import { startNeoLocalRuntime } from "./neo-local-runtime.ts";

const HOSTED_ACTORS_URL = "https://actors.ampcode.com";
const HOSTED_ACTORS_WS = "wss://actors.ampcode.com";
const ACTORS_NAMESPACE = "default";
const DEFAULT_PORT = 6420;

interface SocketData {
  targetUrl: string;
  protocols: string[];
  upstream?: WebSocket;
  pending: Array<string | ArrayBuffer | Uint8Array>;
}

export function startRivetProxy(config: ProxyConfig): ReturnType<typeof Bun.serve> | null {
  if (!hostedNeoDebugEnabled()) {
    return startNeoLocalRuntime(config, config.hostname);
  }
  const token = process.env.AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN;
  if (!token) {
    logger.warn("Hosted Neo actor bridge disabled: AMPCODE_CONNECTOR_HOSTED_ACTORS_TOKEN is not set");
    return null;
  }
  return startHostedRivetProxy(config.hostname, token);
}

function hostedNeoDebugEnabled(): boolean {
  const value = process.env.AMPCODE_CONNECTOR_NEO_HOSTED_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function startHostedRivetProxy(hostname: string, token: string): ReturnType<typeof Bun.serve> | null {
  try {
    const server = Bun.serve<SocketData>({
      port: DEFAULT_PORT,
      hostname,
      idleTimeout: 255,

      fetch(req, srv) {
        const upgrade = req.headers.get("upgrade");
        if (upgrade?.toLowerCase() === "websocket") {
          const source = new URL(req.url);
          const target = hostedActorsUrl(source, HOSTED_ACTORS_WS);
          const targetUrl = target.toString();
          const protocols = parseProtocols(req.headers.get("sec-websocket-protocol"));
          logger.info(
            `Neo actor proxy WebSocket upgrade ${JSON.stringify({
              path: source.pathname,
              search: redactSearch(source.search),
              targetUrl: redactActorUrl(targetUrl),
              protocols,
            })}`,
          );
          const headers = protocols[0] ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined;
          const upgraded = srv.upgrade(req, { data: { targetUrl, protocols, pending: [] }, headers });
          return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }
        return forwardHttp(req, token);
      },

      websocket: {
        open(ws) {
          const upstream = openUpstreamWebSocket(ws, token);
          ws.data.upstream = upstream;
        },
        message(ws, message) {
          const upstream = ws.data.upstream;
          if (upstream?.readyState === WebSocket.OPEN) {
            upstream.send(message);
          } else {
            ws.data.pending.push(message);
          }
        },
        close(ws, code, reason) {
          const upstream = ws.data.upstream;
          if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason);
        },
      },
    });

    logger.info(`ampcode-connector Neo actor proxy listening on http://${hostname}:${DEFAULT_PORT}`);
    return server;
  } catch (err) {
    logger.warn("Neo actor proxy not started", { port: DEFAULT_PORT, error: String(err) });
    return null;
  }
}

async function forwardHttp(req: Request, token: string): Promise<Response> {
  const url = new URL(req.url);
  const target = hostedActorsUrl(url, HOSTED_ACTORS_URL);
  logger.info(`Neo actor proxy HTTP ${JSON.stringify({ method: req.method, path: url.pathname, search: redactSearch(url.search) })}`);
  const headers = copyHeaders(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Host", new URL(HOSTED_ACTORS_URL).host);

  try {
    const response = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual",
      duplex: "half" as const,
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("Content-Encoding");
    responseHeaders.delete("Content-Length");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (err) {
    logger.error("Neo actor proxy HTTP error", { error: String(err) });
    return Response.json({ error: "Failed to connect to hosted Amp actor service", details: String(err) }, { status: 502 });
  }
}

function openUpstreamWebSocket(client: Bun.ServerWebSocket<SocketData>, token: string): WebSocket {
  const protocols = hostedWebSocketProtocols(client.data.protocols, token);
  const headers = hostedWebSocketHeaders(protocols, token);
  logger.info(
    `Neo actor proxy upstream WebSocket ${JSON.stringify({
      targetUrl: redactActorUrl(client.data.targetUrl),
      protocols,
      headerNames: Object.keys(headers),
      rivetTarget: headers["x-rivet-target"],
      hasRivetActor: Boolean(headers["x-rivet-actor"]),
      hasRivetToken: Boolean(headers["x-rivet-token"]),
      hasConnParams: Boolean(headers["x-rivet-conn-params"]),
    })}`,
  );
  const upstream = new WebSocket(client.data.targetUrl, {
    headers,
    protocols,
  });

  upstream.addEventListener("open", () => {
    logger.info(
      `Neo actor proxy upstream WebSocket open ${JSON.stringify({ targetUrl: redactActorUrl(client.data.targetUrl), protocol: upstream.protocol })}`,
    );
    for (const message of client.data.pending.splice(0)) upstream.send(message);
  });
  upstream.addEventListener("message", (event) => {
    if (client.readyState === WebSocket.OPEN) client.send(event.data as string | ArrayBuffer | Uint8Array);
  });
  upstream.addEventListener("close", (event) => {
    logger.warn(`Neo actor proxy upstream WebSocket close ${JSON.stringify({ code: event.code, reason: event.reason })}`);
    if (client.readyState === WebSocket.OPEN) client.close(event.code, event.reason);
  });
  upstream.addEventListener("error", () => {
    logger.error(`Neo actor proxy upstream WebSocket error ${JSON.stringify({ targetUrl: redactActorUrl(client.data.targetUrl) })}`);
    if (client.readyState === WebSocket.OPEN) client.close(1011, "Hosted actor websocket error");
  });

  return upstream;
}

function parseProtocols(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function hostedWebSocketProtocols(protocols: string[], token: string): string[] {
  if (protocols.some((protocol) => protocol.startsWith("rivet_token."))) return protocols;
  return [...protocols, `rivet_token.${token}`];
}

function hostedWebSocketHeaders(protocols: string[], token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "x-rivet-token": token };
  if (protocols.length > 0) headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
  for (const protocol of protocols) {
    if (protocol.startsWith("rivet_encoding.")) headers["x-rivet-encoding"] = protocol.slice("rivet_encoding.".length);
    if (protocol.startsWith("rivet_conn_params.")) {
      headers["x-rivet-conn-params"] = decodeURIComponent(protocol.slice("rivet_conn_params.".length));
    }
    if (protocol.startsWith("rivet_token.")) headers["x-rivet-token"] = protocol.slice("rivet_token.".length);
    if (protocol.startsWith("rivet_target.")) headers["x-rivet-target"] = protocol.slice("rivet_target.".length);
    if (protocol.startsWith("rivet_actor.")) headers["x-rivet-actor"] = protocol.slice("rivet_actor.".length);
    if (protocol === "rivet_skip_ready_wait") headers["x-rivet-skip-ready-wait"] = "1";
  }
  return headers;
}

function hostedActorsUrl(source: URL, base: string): URL {
  const target = new URL(source.pathname + source.search, base);
  if (!target.searchParams.has("namespace")) target.searchParams.set("namespace", ACTORS_NAMESPACE);
  return target;
}

function copyHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");
  headers.delete("sec-websocket-key");
  headers.delete("sec-websocket-version");
  headers.delete("sec-websocket-extensions");
  headers.delete("sec-websocket-protocol");
  return headers;
}

function redactSearch(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    if (key.toLowerCase().includes("token")) params.set(key, "[redacted]");
    if (key === "rvt-input") params.set(key, "[redacted]");
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

function redactActorUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().includes("token")) url.searchParams.set(key, "[redacted]");
      if (key === "rvt-input") url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}
