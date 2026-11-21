import { defineConfig, type ViteDevServer } from "vite";
import { resolve } from "node:path";
import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config as loadDotenv } from "dotenv";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

loadDotenv();

// Clean-URL middleware: rewrite extensionless /sound → /sound.html and
// /music → /music.html so the address bar can show clean paths in dev/preview.
const cleanUrls = () => {
  const rewrite = (req: { url?: string }) => {
    if (req.url === "/sound") req.url = "/sound.html";
    else if (req.url === "/music") req.url = "/music.html";
    else if (req.url === "/piano-roll") req.url = "/piano-roll.html";
    else if (req.url === "/sprites") req.url = "/sprites.html";
  };
  return {
    name: "clean-urls",
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
    configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => { rewrite(req); next(); });
    },
  };
};

// Dev-only writer that POSTs a JSON config blob back to disk so commits can
// capture tuning changes (the /sound and /music pages do this on every knob
// change). Only active under `vite dev`; the production build never receives
// these writes — the pages still work in prod-preview, the POST just no-ops.
const makeConfigWriter = (opts: { name: string; route: string; targetPath: string }) => {
  const target = resolve(__dirname, opts.targetPath);
  return {
    name: opts.name,
    configureServer(server: {
      middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void };
    }) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== opts.route || req.method !== "POST") {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            // Validate JSON before writing — don't trash the file on a
            // malformed payload.
            JSON.parse(body);
            await writeFile(target, body, "utf8");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
        req.on("error", () => {
          res.statusCode = 500;
          res.end("read error");
        });
      });
    },
  };
};

// Dev-only writer for offline-rendered Tone.js bake buffers. The browser POSTs
// a WAV blob via POST /__bake-dump__?key=<name>__<pitchKey>; this plugin pipes
// it through ffmpeg into an MP3 at public/sounds/baked/<key>.mp3. Same idea
// as makeConfigWriter — playing the game in dev produces the static files
// you then commit, and prod fetches them with no Tone.js bake at all.
//
// "Existing file wins": we skip the write if the file is already on disk so
// regular gameplay doesn't churn already-good bakes. Delete the file (or the
// whole baked/ dir) to force a re-bake on next play.
const bakeDumpWriter = () => {
  const dir = resolve(__dirname, "public/sounds/baked");
  // Path-traversal guard: a malicious key like "../../etc/foo" would escape
  // the baked/ dir. Allow only the alphabet our bakedKey() function emits.
  const safeKey = (k: string) => /^[A-Za-z0-9_.\-]+$/.test(k);
  const fileExists = async (p: string) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  const encodeWavToMp3 = (wav: Buffer, outPath: string): Promise<void> =>
    new Promise((resolveEncode, rejectEncode) => {
      // -y overwrite, -i pipe:0 WAV in, -codec:a libmp3lame, -q:a 2 (~190kbps VBR)
      // -loglevel error keeps the dev console quiet on success. The whole
      // baked/ tree is a few MB, so the quality step above the old -q:a 4 buys
      // headroom on the tonal voices for a size nobody will notice.
      const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", "pipe:0", "-codec:a", "libmp3lame", "-q:a", "2", outPath]);
      let stderr = "";
      ff.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      ff.on("error", rejectEncode);
      ff.on("close", (code: number) => {
        if (code === 0) resolveEncode();
        else rejectEncode(new Error(`ffmpeg exited ${code}: ${stderr}`));
      });
      ff.stdin.end(wav);
    });
  // bake-gains.json maps file slug → the multiplier Sound applies after decode
  // to undo the encode-time normalization. Merged rather than rewritten so a
  // partial bake run never drops the gains of the files already on disk.
  const gainsPath = resolve(dir, "bake-gains.json");
  let gainWrite: Promise<void> = Promise.resolve();
  const recordBakeGain = (key: string, gain: number) => {
    if (!Number.isFinite(gain) || gain <= 0) return gainWrite;
    gainWrite = gainWrite.then(async () => {
      let gains: Record<string, number> = {};
      try {
        gains = JSON.parse(await readFile(gainsPath, "utf8")) as Record<string, number>;
      } catch {
        // No manifest yet — this bake starts one.
      }
      gains[key] = Number(gain.toFixed(6));
      const sorted = Object.fromEntries(Object.entries(gains).sort(([a], [b]) => a.localeCompare(b)));
      await writeFile(gainsPath, `${JSON.stringify(sorted, null, 2)}\n`);
    });
    return gainWrite;
  };
  return {
    name: "bake-dump-writer",
    configureServer(server: {
      middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
    }) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__bake-dump__") || req.method !== "POST") {
          next();
          return;
        }
        const [, search = ""] = url.split("?");
        const params = new URLSearchParams(search);
        const key = params.get("key") ?? "";
        if (!key || !safeKey(key)) {
          res.statusCode = 400;
          res.end("invalid key");
          return;
        }
        // Playback multiplier that undoes the encode-time normalization. It
        // lives beside the mp3s rather than inside them so the loader can read
        // every gain in one fetch, before the first buffer decodes.
        const gain = Number(params.get("gain") ?? "1");
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
          const out = resolve(dir, `${key}.mp3`);
          try {
            await mkdir(dir, { recursive: true });
            if (await fileExists(out)) {
              // Existing file wins — don't overwrite on every replay.
              res.statusCode = 200;
              res.end(JSON.stringify({ ok: true, skipped: true }));
              return;
            }
            const wav = Buffer.concat(chunks);
            await encodeWavToMp3(wav, out);
            await recordBakeGain(key, gain);
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, wrote: out }));
            // eslint-disable-next-line no-console
            console.log(`[bake-dump] wrote ${out}`);
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
        req.on("error", () => {
          res.statusCode = 500;
          res.end("read error");
        });
      });
    },
  };
};

// Dev-only adapter that serves /api/* by loading the Vercel-style handlers
// (api/*.ts) through Vite's SSR module loader and feeding them a minimal
// VercelRequest/VercelResponse shape. In prod these run on Vercel; this just
// closes the gap locally so the leaderboard can talk to the dev DB.
const devApi = () => {
  type Handler = (req: any, res: any) => void | Promise<void>;
  const routes: Record<string, string> = {
    "/api/highscores": "/api/highscores.ts",
    "/api/replays": "/api/replays.ts",
    "/api/auth": "/api/auth.ts",
  };

  const decorateRes = (res: ServerResponse) => {
    const r = res as ServerResponse & {
      status: (code: number) => typeof r;
      json: (body: unknown) => typeof r;
      send: (body: unknown) => typeof r;
    };
    r.status = (code) => {
      r.statusCode = code;
      return r;
    };
    r.json = (body) => {
      if (!r.getHeader("content-type")) r.setHeader("content-type", "application/json");
      r.end(JSON.stringify(body));
      return r;
    };
    r.send = (body) => {
      if (body == null) r.end();
      else if (typeof body === "string" || Buffer.isBuffer(body)) r.end(body as any);
      else r.json(body);
      return r;
    };
    return r;
  };

  const parseBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
      const method = (req.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") return resolveBody(undefined);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length === 0) return resolveBody(undefined);
        const ct = String(req.headers["content-type"] ?? "");
        if (ct.includes("application/json")) {
          try {
            resolveBody(JSON.parse(raw));
          } catch (err) {
            rejectBody(err);
          }
        } else {
          resolveBody(raw);
        }
      });
      req.on("error", rejectBody);
    });

  return {
    name: "dev-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "";
        const [pathname, search = ""] = rawUrl.split("?");
        const handlerPath = routes[pathname];
        if (!handlerPath) return next();

        try {
          const mod = await server.ssrLoadModule(handlerPath);
          const handler = (mod.default ?? mod.handler) as Handler | undefined;
          if (typeof handler !== "function") {
            res.statusCode = 500;
            res.end(`No default export from ${handlerPath}`);
            return;
          }

          const query: Record<string, string | string[]> = {};
          for (const [k, v] of new URLSearchParams(search)) {
            const existing = query[k];
            if (existing === undefined) query[k] = v;
            else if (Array.isArray(existing)) existing.push(v);
            else query[k] = [existing, v];
          }

          const body = await parseBody(req);
          const vReq = Object.assign(req, { query, cookies: {}, body });
          const vRes = decorateRes(res);
          await handler(vReq, vRes);
        } catch (err) {
          console.error(`[dev-api] ${pathname} failed:`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "dev-api handler threw" }));
          } else {
            res.end();
          }
        }
      });
    },
  };
};

export default defineConfig({
  server: {
    host: true,
    // A bake run writes into public/sounds/baked/ from the page it is driving.
    // Vite full-reloads on any public/ write, which tore down that page mid-run
    // — the bake would stop wherever the first file landed.
    watch: { ignored: ["**/public/sounds/baked/**"] },
  },
  plugins: [
    react(),
    tailwindcss(),
    cleanUrls(),
    makeConfigWriter({ name: "music-config-writer", route: "/__music-config__", targetPath: "public/sounds/music-config.json" }),
    makeConfigWriter({ name: "halo-full-config-writer", route: "/__halo-full-config__", targetPath: "public/sounds/halo-full-config.json" }),
    bakeDumpWriter(),
    devApi(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        sound: resolve(__dirname, "sound.html"),
        music: resolve(__dirname, "music.html"),
        "piano-roll": resolve(__dirname, "piano-roll.html"),
        sprites: resolve(__dirname, "sprites.html"),
      },
    },
  },
});
