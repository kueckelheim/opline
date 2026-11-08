import express from "express";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ChatEditSession, ModelClient, type ModelClientConfig } from "../../executor/src/client.js";
import { WebSocket, WebSocketServer } from "ws";

export type ServerConfig = ModelClientConfig & {
  /** Optional NeMo-Speech.cpp server for press-to-speak; defaults to http://127.0.0.1:10300. */
  sttHttpUrl?: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const MARKED_UMD = join(HERE, "..", "node_modules", "marked", "lib", "marked.umd.js");

/**
 * Showcase demo backend: hands out blank documents and runs chat-driven edits
 * through the executor session. Edits live in memory only.
 */
export function createApp(config: ServerConfig): Server {
  const app = express();
  const client = new ModelClient(config);
  const sessions = new Map<string, ChatEditSession>();
  const sttHttpUrl = config.sttHttpUrl ?? "http://127.0.0.1:10300";
  const sttWsUrl = sttHttpUrl.replace(/^http/, "ws") + "/v1/realtime";

  app.use(express.json());

  function sessionFor(file: unknown): ChatEditSession | null {
    return typeof file === "string" ? sessions.get(file) ?? null : null;
  }

  // Fresh empty document on load and on "new file".
  app.get("/blank", (_req, res) => {
    const file = `blank-${Math.floor(Math.random() * 1e9)}.md`;
    const session = new ChatEditSession(client, "");
    sessions.set(file, session);
    res.json({ file, doc: session.doc });
  });

  app.post("/command", async (req, res) => {
    const { file, command } = req.body ?? {};
    const session = sessionFor(file);
    if (!session) return res.status(404).json({ error: "no such document — reload the page" });
    if (typeof command !== "string") return res.status(400).json({ error: "command must be a string" });
    const docBefore = session.doc;
    const turn = await session.send(command);
    // Rejections are invisible in the UI beyond a reason badge; log the raw op
    // so a format mismatch can be told apart from a genuinely bad model output.
    if (!turn.ok) console.warn(`[reject ${turn.reason}] ${JSON.stringify(turn.op)}`);
    res.json({ ...turn, doc: session.doc, docBefore });
  });

  // ── Press-to-speak: live mic streaming through a proxy to NeMo-Speech.cpp ──
  // The browser opens /stt/realtime and streams PCM16 @16kHz frames while the
  // mic is held; this pipes them to the upstream /v1/realtime WebSocket
  // (session.update on connect, binary frames, commit on release) and forwards
  // partial/final transcription events back verbatim.
  app.get("/stt/health", async (_req, res) => {
    try {
      const r = await fetch(`${sttHttpUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: "speech server unreachable — run npm run stt:serve" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (down) => {
    const up = new WebSocket(sttWsUrl);
    const queued: (Buffer | string)[] = []; // frames arriving before upstream opens
    up.on("open", () => {
      up.send(JSON.stringify({ type: "session.update", session: { sample_rate: 16000, language: "en" } }));
      for (const m of queued.splice(0)) up.send(m);
    });
    down.on("message", (data, isBinary) => {
      const m = isBinary ? Buffer.from(data as Buffer) : String(data);
      if (up.readyState === WebSocket.OPEN) up.send(m);
      else queued.push(m);
    });
    up.on("message", (data, isBinary) =>
      down.send(isBinary ? Buffer.from(data as Buffer) : String(data)));
    up.on("error", () => down.close());
    down.on("error", () => up.close());
    up.on("close", () => down.close());
    down.on("close", () => up.close());
  });

  const server = createServer(app);
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/stt/realtime") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else socket.destroy();
  });

  app.get("/vendor/marked.js", (_req, res) => res.sendFile(MARKED_UMD));
  app.use(express.static(PUBLIC_DIR));

  // JSON errors (e.g. unreachable model endpoint) instead of the HTML default page.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  return server;
}

export async function loadConfig(path: string): Promise<ServerConfig> {
  return JSON.parse(await readFile(path, "utf8")) as ServerConfig;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2] ?? "config.json";
  loadConfig(configPath)
    .then((config) => {
      const port = Number(process.env.PORT ?? 3000);
      createApp(config).listen(port, () => {
        console.log(`opline demo on http://127.0.0.1:${port}`);
      });
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
