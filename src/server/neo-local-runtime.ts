import type { ProxyConfig } from "../config/config.ts";
import { logger } from "../utils/logger.ts";
import { NeoCloudSync } from "./neo-cloud-sync.ts";
import { LocalThreadActor, type SocketData } from "./neo-local-actor.ts";
import { NeoLocalPersistence, type LocalActorSnapshot } from "./neo-local-persistence.ts";
import {
  actorRecord,
  contentTypeJson,
  extractActorIdFromProtocols,
  extractThreadIdFromActorBody,
  jsonRecord,
  newActorId,
  parseProtocols,
  readJsonRecord,
  type ActorRecord,
  type JsonRecord,
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
      fetch(req, srv) {
        const url = new URL(req.url);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const protocols = parseProtocols(req.headers.get("sec-websocket-protocol"));
          const actorId = extractActorIdFromProtocols(protocols) ?? url.searchParams.get("actorId");
          if (!actorId || !store.get(actorId)) return new Response("Unknown local Neo actor", { status: 404 });
          const headers = protocols[0] ? { "Sec-WebSocket-Protocol": protocols[0] } : undefined;
          return srv.upgrade(req, { data: { actorId }, headers }) ? undefined : new Response("Upgrade failed", { status: 400 });
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

class ActorStore {
  private actors = new Map<string, StoredActor>();
  private byNameKey = new Map<string, string>();
  private persistence = new NeoLocalPersistence();
  private cloudSync: NeoCloudSync;

  constructor(private readonly config: ProxyConfig) {
    this.cloudSync = new NeoCloudSync(config);
    for (const persisted of this.persistence.loadActors()) {
      const actor = this.createActor(persisted.id, persisted.name, persisted.key, persisted.record, persisted.snapshot);
      this.actors.set(persisted.id, { id: persisted.id, name: persisted.name, key: persisted.key, record: persisted.record, actor });
      if (persisted.key) this.byNameKey.set(this.nameKey(persisted.name, persisted.key), persisted.id);
    }
    if (this.actors.size > 0) logger.info(`Loaded ${this.actors.size} local Neo thread actor(s) from disk`);
  }

  get(actorId: string): StoredActor | undefined {
    return this.actors.get(actorId);
  }

  async handleHttp(req: Request, url: URL): Promise<Response> {
    logger.info(`Neo local runtime HTTP ${JSON.stringify({ method: req.method, path: url.pathname })}`);
    if (url.pathname === "/metadata" && req.method === "GET") return Response.json(METADATA);
    if (url.pathname.endsWith("/import") && req.method === "POST") return this.importThread(req, url);
    if (url.pathname === "/actors" && req.method === "GET") return Response.json({ actors: this.findActors(url) });
    if (url.pathname === "/actors" && (req.method === "PUT" || req.method === "POST")) {
      const body = await readJsonRecord(req);
      const stored = await this.upsert(body, req.method === "PUT");
      return Response.json({ actor: stored.record, created: stored.created });
    }

    const actorExport = url.pathname.match(/^\/actors\/([^/]+)\/(export|transcript\.md)$/);
    if (actorExport && req.method === "GET") return this.exportActor(decodeURIComponent(actorExport[1]!), actorExport[2]!);

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
    const stored = (actorId ? this.actors.get(actorId) : undefined) ?? [...this.actors.values()].find((actor) => actor.actor.snapshot().threadId === threadId || actor.key === threadId);
    if (!stored) return Response.json({ error: "actor_not_found" }, { status: 404 });
    stored.actor.importCloudThread(thread);
    this.save(stored.id, stored.name, stored.key, stored.record, stored.actor.snapshot());
    return Response.json({ ok: true });
  }

  private findActors(url: URL): ActorRecord[] {
    const actorIds = url.searchParams.get("actor_ids");
    if (actorIds) return actorIds.split(",").flatMap((id) => (this.actors.get(id)?.record ? [this.actors.get(id)!.record] : []));

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
      if (existing) return { ...existing, created: false };
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

  private createActor(id: string, name: string, key: string | null, record: ActorRecord, snapshot?: LocalActorSnapshot, threadId?: string, input?: JsonRecord): LocalThreadActor {
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
