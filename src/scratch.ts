import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

const DAY = 86400;
const KEEP = 14 * DAY;
const MAX_REPOS = 500;
const MAX_UPLOADS = 32;
const MAX_BYTES = 256 * 1024 * 1024 * 1024;
const IDLE = 3600;
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const PART = 8 * 1024 * 1024;
const WINDOW = 256 * 1024;
const TUS = "1.0.0";

type Repo = { id: string; created: number; expire: number; bytes: number };
type User = {
  tokenHash: string;
  created: number;
  publishCount: number;
  lastExpire: number;
  repos: Repo[];
  // Older builds stored the one allowed upload here. It is ignored and removed.
  pending?: { id: string; bytes: number };
};
type Up = {
  account: string;
  id: string;
  length: number;
  offset: number;
  at: number;
  parts: { off: number; len: number }[];
  replace?: boolean;
};

export class HTTPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const keepDays = KEEP / DAY;

export const scratchDocs = `# Scratchpad

Temporary rpm repositories. A repo is deleted ${keepDays} days after it is published or replaced. The account is deleted ${keepDays} days after its last repo expired, or ${keepDays} days after registration if it never published. Publishing again requires a new proof of work.

## Register

\`POST /v1/challenge\` returns \`challenge\`, \`bits\`, and \`exp\`.

Find a decimal \`solution\` such that SHA-256 of the bytes \`challenge + solution\` has at least \`bits\` leading zero bits. \`POST /v1/register\` with \`{"challenge","solution"}\` returns \`account\` and \`token\`. The token is shown once.

Later requests send \`Authorization: Bearer <token>\`. \`GET /v1/account\` returns \`account\` when that token still matches a stored account, and 401 when it does not.

## Upload

[tus](https://tus.io/protocols/resumable-upload) ${TUS}, creation and PATCH only.

1. \`POST /v1/repos\` with \`Upload-Length\`, \`Tus-Resumable: ${TUS}\`, and \`X-Ftuna-Id\`. The id is 1-80 characters from \`a-z\`, \`0-9\`, \`_\`, and \`-\`. Publishing that name again replaces the repo, including files the new archive does not contain.
2. \`PATCH\` the \`Location\` with \`Upload-Offset\` and \`Content-Type: application/offset+octet-stream\`.
3. \`HEAD\` the same URL to read \`Upload-Offset\` after a dropped connection.

The body is one uncompressed ustar archive of a repo. Allowed paths:

- \`aarch64\` / \`armv7hl\` / \`i486\` \`/**/*.rpm\`
- \`<arch>/repodata/repomd.xml\`
- \`<arch>/repodata/<hex>-primary.xml.gz\`, \`filelists\`, \`other\`
- \`<arch>/repodata/repomd.xml.asc\`
- \`info.json.xz\`

At least one rpm and one \`repomd.xml\`. Anything else is rejected. A chunk that is not the last must be at least ${iec(MIN_CHUNK)}. No chunk may be larger than ${iec(MAX_CHUNK)}.

Caps: ${MAX_REPOS} repos in ${DAY / 3600} hours, ${iec(MAX_BYTES)} of live files, ${MAX_UPLOADS} uploads at a time. An upload with no new data for an hour is deleted. Starting another upload with the same name drops the unfinished one.

\`ftuna scratch register\` saves the token. \`ftuna scratch publish <dir> <name>\` packs that directory as a tar and uploads it.

The public URL is \`/<account>/<id>/\`.
`;

function iec(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && value % 1024 === 0 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value} ${units[i]}`;
}

const arches = new Set(["aarch64", "armv7hl", "i486"]);
const seg = /^[A-Za-z0-9._+-]+$/;
const REPO_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export function allowPath(name: string): boolean {
  if (name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return false;
  }
  if (name === "info.json.xz") return true;
  const parts = name.split("/");
  if (!arches.has(parts[0])) return false;
  if (parts[1] === "repodata") {
    if (parts.length !== 3) return false;
    const file = parts[2];
    return file === "repomd.xml" || file === "repomd.xml.asc" || /^[0-9a-fA-F]+-(primary|filelists|other)\.xml\.gz$/.test(file);
  }
  if (!name.endsWith(".rpm") || !seg.test(parts[parts.length - 1])) return false;
  return parts.slice(1, -1).every((part) => seg.test(part));
}

export async function handleAPI(request: Request, env: Env, store: Store): Promise<Response | null> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (!url.pathname.startsWith("/v1/")) return null;
  if (host !== "scratchpad-repo.ftuna.eu" && host !== "127.0.0.1" && host !== "localhost") return null;
  try {
    return await dispatch(request, url, env, store);
  } catch (err) {
    if (err instanceof HTTPError) return text(err.message, err.status);
    console.error(err);
    return text("storage error", 502);
  }
}

async function dispatch(request: Request, url: URL, env: Env, store: Store): Promise<Response> {
  const path = url.pathname;
  if (request.method === "POST" && path === "/v1/challenge") return challenge(env);
  if (request.method === "POST" && path === "/v1/register") return register(request, env, store);
  if (request.method === "GET" && path === "/v1/account") return currentAccount(request, store);
  const repo = path.match(/^\/v1\/repos(?:\/([a-z0-9][a-z0-9_-]{0,79}))?$/);
  if (!repo) return text("not found", 404);
  requireTus(request);
  if (request.method === "POST" && !repo[1]) return createUpload(request, url, store);
  if (!repo[1]) return text("not found", 404);
  if (request.method === "HEAD") return headUpload(request, store, repo[1]);
  if (request.method === "PATCH") return patchUpload(request, store, repo[1]);
  return text("method not allowed", 405);
}

function challenge(env: Env): Response {
  const secret = env.POW_SECRET;
  if (!secret) return text("not configured", 500);
  const bits = bitsOf(env);
  const exp = now() + 45 * 60;
  const nonce = randomBytes(16).toString("hex");
  const body = `${exp}.${bits}.${nonce}`;
  const challenge = `${body}.${hmacHex(secret, body)}`;
  return json({ challenge, bits, exp });
}

async function register(request: Request, env: Env, store: Store): Promise<Response> {
  const secret = env.POW_SECRET;
  if (!secret) return text("not configured", 500);
  const body = (await readJSON(request)) as { challenge?: string; solution?: string };
  if (!body.challenge || typeof body.solution !== "string") return text("bad request", 400);
  const parts = body.challenge.split(".");
  if (parts.length !== 4) return text("bad challenge", 400);
  const [exp, bits, nonce, mac] = parts;
  if (hmacHex(secret, `${exp}.${bits}.${nonce}`) !== mac) return text("bad challenge", 400);
  if (Number(bits) !== bitsOf(env) || Number(exp) < now()) return text("bad challenge", 400);
  if (!/^\d{1,20}$/.test(body.solution)) return text("bad solution", 400);
  if (zeroBits(createHash("sha256").update(body.challenge + body.solution).digest()) < Number(bits)) return text("bad solution", 400);
  const used = `scratch/_pow/${exp}/${mac}`;
  if (await store.get(used)) return text("challenge used", 409);
  await store.put(used, Buffer.from("1"), "text/plain");
  const account = randomBytes(16).toString("hex");
  const token = account + "." + randomBytes(32).toString("base64url");
  const user: User = {
    tokenHash: sha256Hex(token),
    created: now(),
    publishCount: 0,
    lastExpire: 0,
    repos: [],
  };
  await saveUser(store, account, user);
  return json({ account, token });
}

async function currentAccount(request: Request, store: Store): Promise<Response> {
  const { account } = await auth(store, request.headers.get("authorization"));
  return json({ account });
}

async function createUpload(request: Request, url: URL, store: Store): Promise<Response> {
  const { account, user } = await auth(store, request.headers.get("authorization"));
  const length = Number(request.headers.get("upload-length"));
  if (!Number.isSafeInteger(length) || length <= 0) return text("bad length", 400);
  const id = request.headers.get("x-ftuna-id");
  if (!id) return text("name required", 400);
  if (!REPO_ID.test(id)) return text("bad id", 400);
  const replace = user.repos.some((repo) => repo.id === id) || (await store.get(`scratch/${account}/${id}/meta.json`)) !== null;
  if (!replace) {
    const recent = user.repos.filter((repo) => repo.created > now() - DAY).length;
    if (recent >= MAX_REPOS) return text("too many repos", 429);
  }
  const t = now();
  const flying = await inflight(store, account);
  for (const old of flying) {
    if (old.at + IDLE < t) await deleteUpload(store, old);
  }
  const active = flying.filter((old) => old.id !== id && old.at + IDLE >= t);
  if (active.length >= MAX_UPLOADS) return text("too many uploads", 429);
  const reserved = active.reduce((n, old) => n + old.length, 0);
  const live = liveBytes(user) - replaceCredit(user, id);
  if (live + reserved + length > MAX_BYTES) return text("too much data", 413);
  for (const old of flying) {
    if (old.id === id && old.at + IDLE >= t) await deleteUpload(store, old);
  }
  if (user.pending) await clearPending(store, account);
  const up: Up = { account, id, length, offset: 0, at: t, parts: [], replace };
  await saveUp(store, up);
  return empty(201, {
    "tus-resumable": TUS,
    location: new URL(`/v1/repos/${id}`, url.origin).toString(),
    "upload-expires": new Date((up.at + IDLE) * 1000).toUTCString(),
  });
}

async function headUpload(request: Request, store: Store, id: string): Promise<Response> {
  const { account } = await auth(store, request.headers.get("authorization"));
  const up = await loadUp(store, account, id);
  if (!up) return text("not found", 404);
  return empty(200, tusHeaders(up));
}

async function patchUpload(request: Request, store: Store, id: string): Promise<Response> {
  const { account, user } = await auth(store, request.headers.get("authorization"));
  const up = await loadUp(store, account, id);
  if (!up) return text("not found", 404);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/offset+octet-stream") {
    return text("unsupported media type", 415);
  }
  const offset = Number(request.headers.get("upload-offset"));
  if (offset !== up.offset) return text("wrong offset", 409);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CHUNK) return text("chunk too large", 413);
  const body = await readBody(request, MAX_CHUNK);
  if (up.offset + body.byteLength > up.length) return text("too long", 400);
  const last = up.offset + body.byteLength === up.length;
  if (!last && body.byteLength < MIN_CHUNK) return text("chunk too small", 413);
  await store.put(chunkKey(up, up.offset), body, "application/octet-stream");
  up.parts.push({ off: up.offset, len: body.byteLength });
  up.offset += body.byteLength;
  up.at = now();
  if (!last) {
    await saveUp(store, up);
    return empty(204, tusHeaders(up));
  }
  const stage = `staging/${account}/${id}`;
  const live = `scratch/${account}/${id}`;
  try {
    const room = MAX_BYTES - liveBytes(user) + replaceCredit(user, id);
    await store.put(`${stage}.json`, Buffer.from(JSON.stringify({ at: now() })), "application/json");
    const bytes = await extractTar(store, openTar(store, up), stage, PART, room);
    const keep = new Set<string>();
    for (const key of await store.keys(`${stage}/`)) {
      const dest = live + key.slice(stage.length);
      await store.copy(key, dest);
      keep.add(dest);
    }
    const created = now();
    const expire = created + KEEP;
    const metaKey = `${live}/meta.json`;
    const meta = Buffer.from(JSON.stringify({ created, expire, bytes }) + "\n");
    await store.put(metaKey, meta, "application/json");
    keep.add(metaKey);
    for (const key of await store.keys(`${live}/`)) {
      if (!keep.has(key)) await store.del(key);
    }
    const repo: Repo = { id, created, expire, bytes };
    await rememberPublish(store, account, repo);
    await deleteUpload(store, up);
    await deletePrefix(store, `${stage}/`);
    await store.del(`${stage}.json`);
    return empty(204, { ...tusHeaders(up), "x-ftuna-repo": `/${account}/${id}/` });
  } catch (err) {
    await deleteUpload(store, up);
    await deletePrefix(store, `${stage}/`);
    await store.del(`${stage}.json`);
    if (!up.replace) await deletePrefix(store, `${live}/`);
    await clearPending(store, account);
    throw err;
  }
}

type Reader = { read(n: number): Promise<Uint8Array | null> };

export async function extractTar(store: Store, src: Reader, prefix: string, partSize: number, room: number): Promise<number> {
  let rpm = false;
  let repomd = false;
  let written = 0;
  let files = 0;
  for (;;) {
    const header = await src.read(512);
    if (!header) throw new HTTPError(422, "bad tar");
    if (zeroBlock(header)) {
      await zeroRest(src);
      break;
    }
    if (!tarChecksum(header)) throw new HTTPError(422, "bad tar");
    const name = tarName(header);
    const size = tarOctal(header.subarray(124, 136));
    const kind = header[156];
    if (kind === 53 || name.endsWith("/")) {
      await discard(src, size + pad(size));
      continue;
    }
    if (kind !== 0 && kind !== 48) throw new HTTPError(422, "bad path");
    if (!allowPath(name)) throw new HTTPError(422, "bad path");
    if (++files > 2000) throw new HTTPError(422, "bad tar");
    if (name.endsWith(".rpm")) rpm = true;
    if (name.endsWith("/repomd.xml")) repomd = true;
    written += await writeFile(store, src, size, `${prefix}/${name}`, partSize, room - written);
    await discard(src, pad(size));
  }
  if (!rpm || !repomd) throw new HTTPError(422, "not a repo");
  return written;
}

class Pieces {
  parts: Uint8Array[] = [];
  len = 0;
  push(chunk: Uint8Array) {
    if (!chunk.length) return;
    this.parts.push(chunk);
    this.len += chunk.length;
  }
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.parts[0];
      const k = Math.min(chunk.length, n - offset);
      out.set(chunk.subarray(0, k), offset);
      offset += k;
      if (k === chunk.length) this.parts.shift();
      else this.parts[0] = chunk.subarray(k);
    }
    this.len -= n;
    return out;
  }
}

async function writeFile(store: Store, src: Reader, size: number, key: string, partSize: number, room: number): Promise<number> {
  const pieces = new Pieces();
  let upload = "";
  let part = 0;
  const etags: { n: number; etag: string }[] = [];
  let seen = 0;
  let produced = 0;
  let left = size;
  const rpm = key.endsWith(".rpm");
  const magic = [0xed, 0xab, 0xee, 0xdb];
  const fail = async (err: unknown): Promise<never> => {
    if (upload) await store.abortMultipart(key, upload).catch(() => {});
    throw err;
  };
  try {
    while (left > 0) {
      const n = Math.min(WINDOW, left);
      const chunk = await src.read(n);
      if (!chunk || chunk.byteLength !== n) throw new HTTPError(422, "bad tar");
      left -= n;
      if (rpm) {
        for (let i = 0; i < chunk.length && seen < 4; i++, seen++) {
          if (chunk[i] !== magic[seen]) throw new HTTPError(422, "bad rpm");
        }
      }
      if (produced + chunk.length > room) throw new HTTPError(413, "too much data");
      produced += chunk.length;
      pieces.push(chunk);
      while (pieces.len >= partSize) {
        if (!upload) upload = await store.startMultipart(key);
        part++;
        etags.push({ n: part, etag: await store.putPart(key, upload, part, pieces.take(partSize)) });
      }
    }
  } catch (err) {
    await fail(err instanceof HTTPError ? err : new HTTPError(422, "bad tar"));
  }
  if (rpm && seen < 4) await fail(new HTTPError(422, "bad rpm"));
  const type = contentType(key);
  if (!upload) await store.put(key, pieces.take(pieces.len), type);
  else {
    if (pieces.len) {
      part++;
      etags.push({ n: part, etag: await store.putPart(key, upload, part, pieces.take(pieces.len)) });
    }
    await store.completeMultipart(key, upload, etags);
  }
  return produced;
}

function openTar(store: Store, up: Up): Reader {
  let pos = 0;
  let idx = 0;
  return {
    async read(n) {
      if (n > WINDOW) throw new HTTPError(422, "bad tar");
      if (pos >= up.length) return null;
      if (pos + n > up.length) throw new HTTPError(422, "bad tar");
      const out = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        while (idx < up.parts.length && up.parts[idx].off + up.parts[idx].len <= pos) idx++;
        const part = up.parts[idx];
        if (!part || part.off > pos) throw new HTTPError(422, "bad tar");
        const local = pos - part.off;
        const take = Math.min(n - got, part.len - local);
        const buf = await store.range(chunkKey(up, part.off), local, local + take);
        if (buf.byteLength < take) throw new HTTPError(422, "bad tar");
        out.set(buf.subarray(0, take), got);
        got += take;
        pos += take;
      }
      return out;
    },
  };
}

async function discard(src: Reader, n: number) {
  let left = n;
  while (left > 0) {
    const nread = Math.min(WINDOW, left);
    const chunk = await src.read(nread);
    if (!chunk || chunk.byteLength !== nread) throw new HTTPError(422, "bad tar");
    left -= nread;
  }
}

async function zeroRest(src: Reader) {
  for (;;) {
    const block = await src.read(512);
    if (!block) return;
    if (!zeroBlock(block)) throw new HTTPError(422, "bad tar");
  }
}

function tarName(header: Uint8Array): string {
  const name = cstr(header.subarray(0, 100));
  if (cstr(header.subarray(257, 263)) !== "ustar") throw new HTTPError(422, "bad tar");
  const prefix = cstr(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function tarChecksum(header: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === tarOctal(header.subarray(148, 156));
}

function tarOctal(bytes: Uint8Array): number {
  let s = "";
  for (const b of bytes) {
    if (b === 0 || b === 32) continue;
    s += String.fromCharCode(b);
  }
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new HTTPError(422, "bad tar");
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new HTTPError(422, "bad tar");
  return n;
}

function cstr(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

function zeroBlock(block: Uint8Array): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

function pad(size: number): number {
  return (512 - (size % 512)) % 512;
}

export async function runGC(store: Store, at: number): Promise<void> {
  const top = await store.list("scratch/");
  for (const dir of top.dirs) {
    const id = dir.slice("scratch/".length, -1);
    if (id === "_pow") {
      await gcPow(store, at);
      continue;
    }
    const raw = await store.get(`scratch/${id}/user.json`);
    if (raw) await gcUser(store, id, raw, at);
    else await gcLegacy(store, id, at);
  }
  await gcStaging(store, at);
  const incoming = await store.list("incoming/");
  for (const dir of incoming.dirs) {
    const level = await store.list(dir);
    for (const file of level.files) {
      if (!file.key.endsWith(".json")) continue;
      const up = parseUp(await store.get(file.key));
      if (!up || up.at + IDLE >= at) continue;
      await deleteUpload(store, up);
    }
  }
}

async function gcStaging(store: Store, at: number): Promise<void> {
  const top = await store.list("staging/");
  for (const dir of top.dirs) {
    const account = dir.slice("staging/".length, -1);
    const level = await store.list(dir);
    for (const file of level.files) {
      if (!file.key.endsWith(".json")) continue;
      const meta = parseJSON(await store.get(file.key)) as { at?: number } | null;
      const id = file.key.slice(dir.length, -".json".length);
      if (!id || !meta || typeof meta.at !== "number" || meta.at + DAY < at) {
        if (id) await deletePrefix(store, `staging/${account}/${id}/`);
        await store.del(file.key);
      }
    }
  }
}

async function gcPow(store: Store, at: number): Promise<void> {
  const level = await store.list("scratch/_pow/");
  for (const dir of level.dirs) {
    const exp = Number(dir.slice("scratch/_pow/".length, -1));
    if (exp < at) await deletePrefix(store, dir);
  }
}

async function gcLegacy(store: Store, id: string, at: number): Promise<void> {
  const meta = parseJSON(await store.get(`scratch/${id}/meta.json`)) as { expire?: number } | null;
  if (meta && typeof meta.expire === "number" && meta.expire < at) await deletePrefix(store, `scratch/${id}/`);
}

async function gcUser(store: Store, account: string, raw: Uint8Array, at: number): Promise<void> {
  const user = parseUser(raw);
  if (!user) return;
  if (dropUser(user, at)) {
    await deletePrefix(store, `scratch/${account}/`);
    await deletePrefix(store, `incoming/${account}/`);
    return;
  }
  const keep: Repo[] = [];
  for (const repo of user.repos) {
    if (repo.expire < at) await deletePrefix(store, `scratch/${account}/${repo.id}/`);
    else keep.push(repo);
  }
  user.repos = keep;
  delete user.pending;
  await saveUser(store, account, user);
}

function dropUser(user: User, at: number): boolean {
  if (user.publishCount === 0 && user.created + KEEP < at) return true;
  return user.lastExpire > 0 && user.lastExpire + KEEP < at;
}

function liveBytes(user: User): number {
  let n = 0;
  for (const repo of user.repos) if (repo.expire > now()) n += repo.bytes;
  return n;
}

function replaceCredit(user: User, id: string): number {
  const prev = user.repos.find((repo) => repo.id === id);
  if (!prev || prev.expire <= now()) return 0;
  return prev.bytes;
}

async function auth(store: Store, header: string | null): Promise<{ account: string; user: User }> {
  const match = /^Bearer\s+(\S+)$/.exec(header ?? "");
  if (!match) throw new HTTPError(401, "unauthorized");
  const token = match[1];
  const dot = token.indexOf(".");
  const account = dot > 0 ? token.slice(0, dot) : "";
  if (!/^[0-9a-f]{32}$/.test(account)) throw new HTTPError(401, "unauthorized");
  const user = parseUser(await store.get(`scratch/${account}/user.json`));
  if (!user || !same(user.tokenHash, sha256Hex(token))) throw new HTTPError(401, "unauthorized");
  return { account, user };
}

function requireTus(request: Request) {
  if (request.headers.get("tus-resumable") !== TUS) throw new HTTPError(412, "tus required");
}

function tusHeaders(up: Up): Record<string, string> {
  return {
    "tus-resumable": TUS,
    "upload-offset": String(up.offset),
    "upload-length": String(up.length),
    "upload-expires": new Date((up.at + IDLE) * 1000).toUTCString(),
    "cache-control": "no-store",
  };
}

function bitsOf(env: Env): number {
  const n = Number(env.POW_BITS || "34");
  if (!Number.isInteger(n) || n < 1 || n > 40) return 34;
  return n;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function chunkKey(up: Up, off: number): string {
  return `incoming/${up.account}/${up.id}/${off}`;
}

async function saveUp(store: Store, up: Up) {
  await store.put(`incoming/${up.account}/${up.id}.json`, Buffer.from(JSON.stringify(up)), "application/json");
}

async function loadUp(store: Store, account: string, id: string): Promise<Up | null> {
  const up = parseUp(await store.get(`incoming/${account}/${id}.json`));
  if (!up || up.account !== account || up.id !== id) return null;
  return up;
}

async function inflight(store: Store, account: string): Promise<Up[]> {
  const level = await store.list(`incoming/${account}/`);
  const out: Up[] = [];
  for (const file of level.files) {
    if (!file.key.endsWith(".json")) continue;
    const up = parseUp(await store.get(file.key));
    if (up?.account === account && up.id) out.push(up);
  }
  return out;
}

async function rememberPublish(store: Store, account: string, repo: Repo) {
  const user = parseUser(await store.get(`scratch/${account}/user.json`));
  if (!user) return;
  const existing = user.repos.findIndex((item) => item.id === repo.id);
  if (existing >= 0) user.repos[existing] = repo;
  else user.repos.push(repo);
  user.publishCount++;
  user.lastExpire = Math.max(user.lastExpire, repo.expire);
  delete user.pending;
  await saveUser(store, account, user);
}

async function clearPending(store: Store, account: string) {
  const user = parseUser(await store.get(`scratch/${account}/user.json`));
  if (!user?.pending) return;
  delete user.pending;
  await saveUser(store, account, user);
}

async function saveUser(store: Store, account: string, user: User) {
  await store.put(`scratch/${account}/user.json`, Buffer.from(JSON.stringify(user) + "\n"), "application/json");
}

function parseUser(raw: Uint8Array | null): User | null {
  const value = parseJSON(raw) as User | null;
  if (!value || typeof value.tokenHash !== "string" || !Array.isArray(value.repos)) return null;
  return value;
}

function parseUp(raw: Uint8Array | null): Up | null {
  const value = parseJSON(raw) as Up | null;
  if (!value || !Array.isArray(value.parts)) return null;
  return value;
}

function parseJSON(raw: Uint8Array | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return null;
  }
}

async function deleteUpload(store: Store, up: Up) {
  await deletePrefix(store, `incoming/${up.account}/${up.id}/`);
  await store.del(`incoming/${up.account}/${up.id}.json`);
}

async function deletePrefix(store: Store, prefix: string) {
  for (const key of await store.keys(prefix)) await store.del(key);
}

async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new HTTPError(413, "chunk too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJSON(request: Request): Promise<unknown> {
  const raw = await readBody(request, 4096);
  try {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new HTTPError(400, "bad request");
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function zeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    for (let mask = 0x80; mask > 0 && (byte & mask) === 0; mask >>= 1) n++;
    break;
  }
  return n;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function contentType(key: string): string {
  if (key.endsWith(".rpm")) return "application/x-rpm";
  if (key.endsWith(".xml")) return "text/xml";
  if (key.endsWith(".gz")) return "application/gzip";
  if (key.endsWith(".asc")) return "application/pgp-signature";
  return "application/octet-stream";
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function empty(status: number, headers: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

function text(body: string, status: number): Response {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
