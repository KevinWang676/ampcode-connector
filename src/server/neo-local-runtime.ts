import type { ProxyConfig } from "../config/config.ts";
import { logger } from "../utils/logger.ts";
import { NeoCloudSync } from "./neo-cloud-sync.ts";
import { LocalThreadActor, type SocketData } from "./neo-local-actor.ts";
import { type LocalActorSnapshot, NeoLocalPersistence } from "./neo-local-persistence.ts";
import {
  type ActorRecord,
  actorRecord,
  contentTypeJson,
  extractActorIdFromProtocols,
  extractThreadIdFromActorBody,
  type JsonRecord,
  jsonRecord,
  newActorId,
  parseProtocols,
  readJsonRecord,
} from "./neo-protocol.ts";

const DEFAULT_PORT = 6420;
const METADATA = {
  runtime: "engine",
  version: "2.3.0-rc.4",
  git_sha: "local-ampcode-connector",
  build_timestamp: "2026-05-07T00:00:00Z",
  rustc_version: "local",
  rustc_host: process.platform,
  cargo_target: process.arch,
  cargo_profile: "release",
};

interface StoredActor {
  id: string;
  name: string;
  key: string | null;
  record: ActorRecord;
  actor: LocalThreadActor;
}

export function startNeoLocalRuntime(config: ProxyConfig, hostname: string): ReturnType<typeof Bun.serve> | null {
  const store = new ActorStore(config);
  try {
    const server = Bun.serve<SocketData>({
      port: DEFAULT_PORT,
      hostname,
      idleTimeout: 255,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
        const protocols = parseProtocols(req.headers.get("sec-websocket-protocol"));

        logger.info(
          `Neo local runtime request ${JSON.stringify({
            method: req.method,
            path: url.pathname,
            search: redactNeoSearch(url.search),
            upgrade,
            protocols: redactProtocols(protocols),
            host: req.headers.get("host"),
            xRivetActor: req.headers.get("x-rivet-actor"),
            xRivetTarget: req.headers.get("x-rivet-target"),
          })}`,
        );

        if (upgrade) {
          // RivetKit gateway path: /gateway/<actorName>/websocket/?rvt-method=getOrCreate&rvt-key=<key>&rvt-input=<json>
          const gateway = parseGatewayRequest(url, protocols);
          let resolvedActorId: string | null = null;
          if (gateway) {
            try {
              const stored = await store.upsertFromGateway(gateway);
              resolvedActorId = stored.id;
              logger.info(
                `Neo local runtime gateway resolved ${JSON.stringify({
                  actorName: gateway.actorName,
                  method: gateway.method,
                  key: gateway.key,
                  actorId: stored.id,
                  created: stored.created,
                })}`,
              );
            } catch (err) {
              logger.warn(
                `Neo local runtime gateway upsert failed ${JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                  actorName: gateway.actorName,
                  key: gateway.key,
                })}`,
              );
            }
          }

          const actorId = resolvedActorId ?? actorIdFromRequest(url, protocols, req);

          logger.info(
            `Neo local runtime WebSocket upgrade ${JSON.stringify({
              path: url.pathname,
              search: redactNeoSearch(url.search),
              protocols: redactProtocols(protocols),
              actorId,
              knownActor: actorId ? Boolean(store.get(actorId)) : false,
            })}`,
          );

          if (!actorId) {
            logger.warn(
              `Neo local runtime WebSocket rejected — missing actor id ${JSON.stringify({
                path: url.pathname,
                protocols: redactProtocols(protocols),
              })}`,
            );
            return new Response("Unknown local Neo actor", { status: 404 });
          }

          // Resolve actor id via key lookup if it isn't a known id (DTW gateway
          // paths may carry an actor id that is actually a thread key).
          const resolved = store.get(actorId)
            ? actorId
            : (store.resolveActorIdByKey(actorId) ?? actorId);
          if (!store.get(resolved)) {
            logger.warn(
              `Neo local runtime WebSocket rejected — unknown actor ${JSON.stringify({
                actorId: resolved,
                originalActorId: actorId,
                path: url.pathname,
                protocols: redactProtocols(protocols),
              })}`,
            );
            return new Response("Unknown local Neo actor", { status: 404 });
          }

          // Negotiate the rivet subprotocol set. For a clean handshake we echo
          // back the rivet base + skip-ready-wait + encoding so the client
          // confirms its intended encoding/options.
          const negotiated = chooseSubprotocol(protocols);
          const headers = negotiated ? { "Sec-WebSocket-Protocol": negotiated } : undefined;
          return srv.upgrade(req, { data: { actorId: resolved }, headers })
            ? undefined
            : new Response("Upgrade failed", { status: 400 });
        }
        return store.handleHttp(req, url);
      },
      websocket: {
        open(ws) {
          store.get(ws.data.actorId)?.actor.open(ws);
        },
        message(ws, message) {
          if (message === "ping") {
            ws.send("pong");
            return;
          }
          store.get(ws.data.actorId)?.actor.message(ws, message);
        },
        close(ws) {
          store.get(ws.data.actorId)?.actor.close(ws);
        },
      },
    });

    logger.info(`ampcode-connector local Neo runtime listening on http://${hostname}:${DEFAULT_PORT}`);
    return server;
  } catch (err) {
    logger.warn("Local Neo runtime not started", { port: DEFAULT_PORT, error: String(err) });
    return null;
  }
}

function actorIdFromRequest(url: URL, protocols: string[], req: Request): string | null {
  return (
    extractActorIdFromProtocols(protocols) ??
    url.searchParams.get("actorId") ??
    url.searchParams.get("actor") ??
    req.headers.get("x-rivet-actor") ??
    actorIdFromGatewayPath(url.pathname)
  );
}

function actorIdFromGatewayPath(pathname: string): string | null {
  // Legacy form: /gateway/{actorId}@{token}/websocket/... or /gateway/{actorId}/websocket/...
  // and /actors?/{actorId}/...
  // Note: newer RivetKit gateway uses the *actor name* not id in this segment;
  // the actor must be resolved from query params `rvt-method`/`rvt-key`/`rvt-input`.
  const gateway = pathname.match(/^\/gateway\/([^/@]+)(?:@[^/]+)?(?:\/.*)?$/);
  if (gateway) return decodeURIComponent(gateway[1]!);
  const actor = pathname.match(/^\/actors?\/([^/]+)(?:\/.*)?$/);
  if (actor) return decodeURIComponent(actor[1]!);
  return null;
}

interface GatewayRequest {
  actorName: string;
  method: "getOrCreate" | "get" | "create";
  key: string | null;
  input: JsonRecord | null;
  connParams: JsonRecord | null;
  encoding: string | null;
  skipReadyWait: boolean;
}

function parseGatewayRequest(url: URL, protocols: string[]): GatewayRequest | null {
  const match = url.pathname.match(/^\/gateway\/([^/@]+)(?:\/.*)?$/);
  if (!match) return null;
  const actorName = decodeURIComponent(match[1]!);
  const methodRaw = url.searchParams.get("rvt-method") ?? "";
  if (!methodRaw) return null;
  const method =
    methodRaw === "getOrCreate" || methodRaw === "get" || methodRaw === "create" ? methodRaw : "getOrCreate";
  const key = url.searchParams.get("rvt-key");
  const input = parseJson(url.searchParams.get("rvt-input"));
  const skipReadyWait = url.searchParams.get("rvt-skip-ready-wait") === "true";
  let connParams: JsonRecord | null = null;
  let encoding: string | null = null;
  for (const protocol of protocols) {
    if (protocol.startsWith("rivet_conn_params.")) {
      connParams = parseJson(protocol.slice("rivet_conn_params.".length));
    }
    if (protocol.startsWith("rivet_encoding.")) {
      encoding = protocol.slice("rivet_encoding.".length);
    }
  }
  return {
    actorName,
    method,
    key,
    input: jsonRecordOrNull(input),
    connParams: jsonRecordOrNull(connParams),
    encoding,
    skipReadyWait,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}

function jsonRecordOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

/** Pick the WebSocket subprotocol to confirm during the handshake.
 *  RivetKit uses the chosen subprotocol primarily as metadata acknowledgement.
 *  We echo the first offered protocol (typically "rivet") so the client treats
 *  the handshake as accepted. */
function chooseSubprotocol(protocols: string[]): string | null {
  return protocols[0] ?? null;
}

function redactNeoSearch(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    if (key.toLowerCase().includes("token")) params.set(key, "[redacted]");
    if (key === "rvt-input") params.set(key, "[redacted]");
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

function redactProtocols(protocols: string[]): string[] {
  return protocols.map((protocol) => {
    if (protocol.startsWith("rivet_token.")) return "rivet_token.[redacted]";
    if (protocol.startsWith("rivet_conn_params.")) return "rivet_conn_params.[redacted]";
    return protocol;
  });
}

class ActorStore {
  private actors = new Map<string, StoredActor>();
  private byNameKey = new Map<string, string>();
  private persistence = new NeoLocalPersistence();
  private cloudSync: NeoCloudSync;

  constructor(private readonly config: ProxyConfig) {
    this.cloudSync = new NeoCloudSync(config);
    for (const persisted of this.persistence.loadActors()) {
      const actor = this.createActor(persisted.id, persisted.name, persisted.key, persisted.record, persisted.snapshot);
      this.actors.set(persisted.id, {
        id: persisted.id,
        name: persisted.name,
        key: persisted.key,
        record: persisted.record,
        actor,
      });
      if (persisted.key) this.byNameKey.set(this.nameKey(persisted.name, persisted.key), persisted.id);
    }
    if (this.actors.size > 0) logger.info(`Loaded ${this.actors.size} local Neo thread actor(s) from disk`);
  }

  get(actorId: string): StoredActor | undefined {
    return this.actors.get(actorId);
  }

  /** Resolve a thread key (or any key fragment) to a known actor id. Used so
   *  WebSocket gateway paths that carry the thread id (rather than a generated
   *  actor id) still find the correct local actor. */
  resolveActorIdByKey(candidate: string): string | undefined {
    if (this.actors.has(candidate)) return candidate;
    for (const actor of this.actors.values()) {
      if (actor.key === candidate) return actor.id;
      if (actor.actor.snapshot().threadId === candidate) return actor.id;
    }
    return undefined;
  }

  /** Upsert from a RivetKit gateway WebSocket request. Treats the path's actor
   *  name segment as the actor name and the `rvt-key` query as the actor key.
   *  The `rvt-input` JSON becomes the actor's input. */
  async upsertFromGateway(gateway: GatewayRequest): Promise<StoredActor & { created: boolean }> {
    const body: JsonRecord = {
      name: gateway.actorName,
      key: gateway.key ?? undefined,
      input: gateway.input ?? undefined,
    };
    const reuse = gateway.method !== "create";
    return this.upsert(body, reuse);
  }

  async handleHttp(req: Request, url: URL): Promise<Response> {
    logger.info(
      `Neo local runtime HTTP ${JSON.stringify({
        method: req.method,
        path: url.pathname,
        search: url.search,
      })}`,
    );
    if (url.pathname === "/metadata" && req.method === "GET") return Response.json(METADATA);
    if (url.pathname.endsWith("/import") && req.method === "POST") return this.importThread(req, url);
    if (url.pathname === "/actors" && req.method === "GET") return Response.json({ actors: this.findActors(url) });
    if (url.pathname === "/actors" && (req.method === "PUT" || req.method === "POST")) {
      const body = await readJsonRecord(req);
      const stored = await this.upsert(body, req.method === "PUT");
      return Response.json({ actor: stored.record, created: stored.created });
    }

    // RivetKit "manage"/"manager" style endpoints used by newer clients.
    if (
      (url.pathname === "/manage/getOrCreateForKey" ||
        url.pathname === "/manager/getOrCreateForKey" ||
        url.pathname === "/actors/getOrCreateForKey" ||
        url.pathname === "/actors/get-or-create-for-key" ||
        url.pathname === "/actors/get-or-create") &&
      req.method === "POST"
    ) {
      const body = await readJsonRecord(req);
      const stored = await this.upsert(body, true);
      return Response.json({ actor: stored.record, created: stored.created });
    }

    const actorExport = url.pathname.match(/^\/actors\/([^/]+)\/(export|transcript\.md)$/);
    if (actorExport && req.method === "GET")
      return this.exportActor(decodeURIComponent(actorExport[1]!), actorExport[2]!);

    if (url.pathname.startsWith("/actors/") && req.method === "DELETE") {
      const actorId = decodeURIComponent(url.pathname.slice("/actors/".length));
      this.delete(actorId);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404, headers: contentTypeJson() });
  }

  private async importThread(req: Request, url: URL): Promise<Response> {
    const body = await readJsonRecord(req);
    const thread = jsonRecord(body.thread);
    const threadId = typeof thread.id === "string" ? thread.id : null;
    const actorId = url.searchParams.get("actorId") ?? req.headers.get("x-rivet-actor") ?? undefined;
    const stored =
      (actorId ? this.actors.get(actorId) : undefined) ??
      [...this.actors.values()].find((actor) => actor.actor.snapshot().threadId === threadId || actor.key === threadId);
    if (!stored) return Response.json({ error: "actor_not_found" }, { status: 404 });
    stored.actor.importCloudThread(thread);
    this.save(stored.id, stored.name, stored.key, stored.record, stored.actor.snapshot());
    return Response.json({ ok: true });
  }

  private findActors(url: URL): ActorRecord[] {
    const actorIds = url.searchParams.get("actor_ids");
    if (actorIds)
      return actorIds.split(",").flatMap((id) => (this.actors.get(id)?.record ? [this.actors.get(id)!.record] : []));

    const name = url.searchParams.get("name");
    const key = url.searchParams.get("key");
    if (name && key !== null) {
      const id = this.byNameKey.get(this.nameKey(name, key));
      return id && this.actors.get(id) ? [this.actors.get(id)!.record] : [];
    }
    if (name) return [...this.actors.values()].filter((actor) => actor.name === name).map((actor) => actor.record);
    return [...this.actors.values()].map((actor) => actor.record);
  }

  private async upsert(body: JsonRecord, reuse: boolean): Promise<StoredActor & { created: boolean }> {
    const name = typeof body.name === "string" ? body.name : "thread-actor";
    const key = typeof body.key === "string" ? body.key : null;
    const existingId = key ? this.byNameKey.get(this.nameKey(name, key)) : undefined;
    if (reuse && existingId) {
      const existing = this.actors.get(existingId);
      if (existing) {
        // Reuse path: the local snapshot may be stale if the user used another
        // client (official AMP Neo, web UI, second machine) for this thread
        // since we last touched it. Pull the latest from cloud and import it
        // if cloud has progressed beyond our local copy. Without this, the
        // connector serves a snapshot whose `seq` counter is behind what the
        // CLI already has cached, so newly-broadcast messages get filtered
        // out by the CLI as "older than what I already saw" and the prompt
        // visually disappears.
        await this.refreshFromCloudIfStale(existing);
        return { ...existing, created: false };
      }
    }

    const id = newActorId();
    const threadId = extractThreadIdFromActorBody(body, key);
    const record = actorRecord(id, name, key);
    const actor = this.createActor(id, name, key, record, undefined, threadId, body);
    const stored: StoredActor = { id, name, key, record, actor };
    this.actors.set(id, stored);
    if (key) this.byNameKey.set(this.nameKey(name, key), id);
    const cloudThread = threadId ? await this.cloudSync.fetchThread(threadId) : null;
    if (cloudThread) actor.importCloudThread(cloudThread);
    this.save(id, name, key, record, actor.snapshot());
    return { ...stored, created: true };
  }

  /** When reusing an existing local actor, fetch the cloud thread and import
   *  it iff cloud has more messages than local. Conservative: never overwrites
   *  local when local has unsynced messages cloud does not yet know about. */
  private async refreshFromCloudIfStale(stored: StoredActor): Promise<void> {
    const localSnap = stored.actor.snapshot();
    const threadId = localSnap.threadId;
    if (!threadId) return;
    let cloudThread: JsonRecord | null = null;
    try {
      cloudThread = await this.cloudSync.fetchThread(threadId);
    } catch (err) {
      logger.warn("Failed to refresh local Neo actor from cloud", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!cloudThread) return;
    const cloudMessages = Array.isArray(cloudThread.messages) ? cloudThread.messages : [];
    if (cloudMessages.length <= localSnap.messages.length) return;
    logger.info("Refreshing local Neo actor from cloud", {
      threadId,
      localMessages: localSnap.messages.length,
      cloudMessages: cloudMessages.length,
    });
    stored.actor.importCloudThread(cloudThread);
    this.save(stored.id, stored.name, stored.key, stored.record, stored.actor.snapshot());
  }

  private createActor(
    id: string,
    name: string,
    key: string | null,
    record: ActorRecord,
    snapshot?: LocalActorSnapshot,
    threadId?: string,
    input?: JsonRecord,
  ): LocalThreadActor {
    return new LocalThreadActor({
      config: this.config,
      actorId: id,
      threadId: snapshot?.threadId ?? threadId ?? record.key ?? id,
      input,
      snapshot,
      persist: (next) => this.save(id, name, key, record, next),
    });
  }

  private save(id: string, name: string, key: string | null, record: ActorRecord, snapshot: LocalActorSnapshot): void {
    const state = { version: 1 as const, id, name, key, record, snapshot, updatedAt: snapshot.updatedAt };
    this.persistence.saveActor(state);
    this.cloudSync.schedule(state);
  }

  private exportActor(actorId: string, kind: string): Response {
    const stored = this.actors.get(actorId);
    if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
    const threadId = stored.actor.snapshot().threadId;
    if (kind === "transcript.md") {
      const markdown = this.persistence.markdownForThread(threadId) ?? "";
      return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }
    return Response.json(this.persistence.jsonForThread(threadId) ?? stored.actor.snapshot());
  }

  private delete(actorId: string): void {
    const stored = this.actors.get(actorId);
    if (!stored) return;
    if (stored.key) this.byNameKey.delete(this.nameKey(stored.name, stored.key));
    stored.actor.dispose();
    this.actors.delete(actorId);
    this.persistence.deleteActor(actorId);
  }

  private nameKey(name: string, key: string): string {
    return `${name}\0${key}`;
  }
}
