import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

const DAY = 86400;
const KEEP = 14 * DAY;
const MAX_REPOS = 500;
const MAX_UPLOADS = 32;
const MAX_BYTES = 256 * 1024 * 1024 * 1024;
const IDLE = 3600;
const MIN_CHUNK = 5 * 1024 * 1024;
// A Free zone rejects a request body over 100 MB. 100 MiB is past that.
// The isolate has 128 MB, so the body is streamed in part-sized pieces.
const MAX_CHUNK = 90 * 1024 * 1024;
const PART = 8 * 1024 * 1024;
// One request copies a few pieces, then returns. A runtime update gives an
// in-flight request about 30 seconds to finish, and a 6GiB copy does not fit in that.
const COPY_PART = 32 * 1024 * 1024;
const COPY_STEPS = 4;
export const copyPartBytes = COPY_PART;
export const copySteps = COPY_STEPS;
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
type Etags = { n: number; etag: string }[];
type Produced = { name: string; size: number };
type CopyJob = { name: string; size: number; upload: string; sent: number; part: number; etags: Etags };
type OpenFile = {
  name: string;
  size: number;
  left: number;
  key: string;
  upload: string;
  part: number;
  etags: Etags;
  holdGen: number;
  seen: number;
  skipping: boolean;
};
type TarState = {
  phase: "header" | "body" | "pad" | "zero";
  header: string;
  tail: string;
  pad: number;
  file: OpenFile | null;
  rpm: boolean;
  repomd: boolean;
  files: number;
  written: number;
  produced: Produced[];
  ready: boolean;
  copy: CopyJob | null;
  copyIndex: number;
};
type Up = {
  account: string;
  id: string;
  length: number;
  offset: number;
  at: number;
  parts: { off: number; len: number }[];
  replace?: boolean;
  done?: boolean;
  legacy?: boolean;
  tar: TarState;
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

Later requests send \`Authorization: Bearer <token>\`. \`GET /v1/account\` returns \`account\` when that token still matches a stored account, and 401 when it does not. A challenge from GitHub-hosted Actions asks for fewer leading zero bits.

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

At least one rpm and one \`repomd.xml\`. Anything else is rejected. A chunk that is not the last must be at least ${iec(MIN_CHUNK)}. No chunk may be larger than ${iec(MAX_CHUNK)}. When \`Upload-Offset\` reaches \`Upload-Length\` and the response has no \`X-Ftuna-Repo\`, the bytes are stored and the repo is still being published. \`PATCH\` again with an empty body.

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
  if (request.method === "POST" && path === "/v1/challenge") return challenge(request, env);
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

async function challenge(request: Request, env: Env): Promise<Response> {
  const secret = env.POW_SECRET;
  if (!secret) return text("not configured", 500);
  const bits = await bitsFor(request, env);
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
  const [exp, bitsText, nonce, mac] = parts;
  if (hmacHex(secret, `${exp}.${bitsText}.${nonce}`) !== mac) return text("bad challenge", 400);
  const bits = Number(bitsText);
  if (!allowedBits(env, bits) || Number(exp) < now()) return text("bad challenge", 400);
  if (!/^\d{1,20}$/.test(body.solution)) return text("bad solution", 400);
  if (zeroBits(createHash("sha256").update(body.challenge + body.solution).digest()) < bits) return text("bad solution", 400);
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
  const up: Up = { account, id, length, offset: 0, at: t, parts: [], replace, tar: emptyTar() };
  await saveUp(store, up);
  await touchStage(store, up);
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
  return empty(200, headHeaders(up));
}

async function patchUpload(request: Request, store: Store, id: string): Promise<Response> {
  const { account, user } = await auth(store, request.headers.get("authorization"));
  const up = await loadUp(store, account, id);
  if (!up) return text("not found", 404);
  if (up.legacy) {
    await deleteUpload(store, up);
    return text("upload expired", 410);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/offset+octet-stream") {
    return text("unsupported media type", 415);
  }
  const declared = contentLength(request);
  if (Number.isFinite(declared) && declared > MAX_CHUNK) return text("chunk too large", 413);
  if (up.done) {
    await discardBody(request);
    return empty(204, headHeaders(up));
  }
  const offset = Number(request.headers.get("upload-offset"));
  if (offset !== up.offset) return text("wrong offset", 409);
  if (Number.isFinite(declared)) {
    if (up.offset + declared > up.length) return text("too long", 400);
    const declaredLast = up.offset + declared === up.length;
    if (!declaredLast && declared < MIN_CHUNK) return text("chunk too small", 413);
    if (up.tar.ready && declared !== up.length - up.offset) return text("wrong offset", 409);
  }
  const stage = `staging/${account}/${id}`;
  const live = `scratch/${account}/${id}`;
  await touchStage(store, up);
  let feed: TarFeed | null = null;
  try {
    if (!up.tar.ready) feed = await TarFeed.load(store, up, PART, roomFor(user, id));
    const n = await forEachChunk(request, MAX_CHUNK, async (part) => {
      if (feed) await feed.push(part);
    });
    if (Number.isFinite(declared) && n !== declared) {
      await feed?.onError(new Error("short body"));
      return text("incomplete chunk", 400);
    }
    if (!Number.isFinite(declared)) {
      if (up.offset + n > up.length) return text("too long", 400);
      const measuredLast = up.offset + n === up.length;
      if (!measuredLast && n < MIN_CHUNK) return text("chunk too small", 413);
      if (up.tar.ready && n !== up.length - up.offset) return text("wrong offset", 409);
    }
    const last = up.offset + n === up.length;
    if (feed) {
      if (!last) {
        const prev = up.tar.file?.holdGen ?? 0;
        await feed.persistHold(up);
        up.tar = feed.snapshot();
        up.offset += n;
        up.at = now();
        await saveUp(store, up);
        await dropStaleHold(store, up, prev, up.tar.file?.holdGen ?? 0);
        return empty(204, tusHeaders(up));
      }
      if (!feed.finished()) throw new HTTPError(422, "bad tar");
      if (!feed.rpm || !feed.repomd) throw new HTTPError(422, "not a repo");
      await feed.persistHold(up);
      up.tar = feed.snapshot();
      up.tar.ready = true;
      up.offset = up.length;
      up.at = now();
      await saveUp(store, up);
    } else if (up.offset < up.length) {
      up.offset = up.length;
      up.at = now();
      await saveUp(store, up);
    }
    const more = await copySome(store, up, COPY_STEPS);
    if (more) {
      up.at = now();
      await saveUp(store, up);
      return empty(204, tusHeaders(up));
    }
    await finalize(store, up);
    return empty(204, headHeaders(up));
  } catch (err) {
    if (err instanceof HTTPError && err.message !== "chunk too large") {
      await deleteUpload(store, up);
      if (!up.replace) await deletePrefix(store, live);
      await clearPending(store, account);
    }
    throw err;
  }
}

function roomFor(user: User, id: string): number {
  return MAX_BYTES - liveBytes(user) + replaceCredit(user, id);
}

async function copySome(store: Store, up: Up, budget: number): Promise<boolean> {
  const stage = `staging/${up.account}/${up.id}`;
  const live = `scratch/${up.account}/${up.id}`;
  for (let step = 0; step < budget; step++) {
    if (!up.tar.copy) {
      if (up.tar.copyIndex >= up.tar.produced.length) return false;
      const file = up.tar.produced[up.tar.copyIndex];
      const from = `${stage}/${file.name}`;
      const to = `${live}/${file.name}`;
      if (file.size <= COPY_PART) {
        await store.copy(from, to);
        up.tar.copyIndex++;
        await saveUp(store, up);
        continue;
      }
      up.tar.copy = { name: file.name, size: file.size, upload: await store.startMultipart(to), sent: 0, part: 0, etags: [] };
      await saveUp(store, up);
    }
    const job = up.tar.copy;
    const from = `${stage}/${job.name}`;
    const to = `${live}/${job.name}`;
    if (job.sent < job.size) {
      const end = Math.min(job.sent + COPY_PART, job.size);
      const n = job.part + 1;
      const etag = await store.copyPart(from, to, job.upload, n, job.sent, end);
      job.part = n;
      job.etags.push({ n, etag });
      job.sent = end;
      await saveUp(store, up);
    }
    if (job.sent >= job.size) {
      try {
        await store.completeMultipart(to, job.upload, job.etags);
      } catch (err) {
        if (!(await store.exists(to))) throw err;
      }
      up.tar.copy = null;
      up.tar.copyIndex++;
      await saveUp(store, up);
    }
  }
  return up.tar.copy !== null || up.tar.copyIndex < up.tar.produced.length;
}

async function finalize(store: Store, up: Up) {
  const stage = `staging/${up.account}/${up.id}`;
  const live = `scratch/${up.account}/${up.id}`;
  const keep = new Set<string>();
  for (const file of up.tar.produced) keep.add(`${live}/${file.name}`);
  const created = now();
  const expire = created + KEEP;
  const bytes = up.tar.written;
  const metaKey = `${live}/meta.json`;
  await store.put(metaKey, Buffer.from(JSON.stringify({ created, expire, bytes }) + "\n"), "application/json");
  keep.add(metaKey);
  for (const key of await store.keys(`${live}/`)) {
    if (!keep.has(key)) await store.del(key);
  }
  await rememberPublish(store, up.account, { id: up.id, created, expire, bytes });
  await deletePrefix(store, `${stage}/`);
  await store.del(`${stage}.json`);
  await deletePrefix(store, `incoming/${up.account}/${up.id}/`);
  up.done = true;
  up.offset = up.length;
  up.at = now();
  up.tar.file = null;
  up.tar.copy = null;
  await saveUp(store, up);
}

type Reader = { read(n: number): Promise<Uint8Array | null> };

export async function extractTar(store: Store, src: Reader, prefix: string, partSize: number, room: number): Promise<number> {
  const feed = new TarFeed(store, prefix, partSize, room);
  try {
    for (;;) {
      const block = await src.read(512);
      if (!block) break;
      if (block.length !== 512) throw new HTTPError(422, "bad tar");
      await feed.push(block);
    }
  } catch (err) {
    if (err instanceof HTTPError) throw err;
    throw new HTTPError(422, "bad tar");
  }
  if (!feed.finished()) throw new HTTPError(422, "bad tar");
  if (!feed.rpm || !feed.repomd) throw new HTTPError(422, "not a repo");
  return feed.written;
}

class TarFeed {
  header = new Uint8Array();
  tail = new Uint8Array();
  phase: TarState["phase"] = "header";
  pad = 0;
  file: {
    name: string;
    size: number;
    left: number;
    key: string;
    upload: string;
    part: number;
    etags: Etags;
    hold: Uint8Array;
    // Part-sized buffer. Small reads are copied into it once; the old path
    // allocated a new buffer and recopied everything already held.
    buf?: Uint8Array;
    holdGen: number;
    seen: number;
    skipping: boolean;
  } | null = null;
  rpm = false;
  repomd = false;
  files = 0;
  written = 0;
  produced: Produced[] = [];
  ready = false;
  copy: CopyJob | null = null;
  copyIndex = 0;
  started = "";
  loadedUpload = "";
  store: Store;
  prefix: string;
  partSize: number;
  room: number;

  constructor(store: Store, prefix: string, partSize: number, room: number) {
    this.store = store;
    this.prefix = prefix;
    this.partSize = partSize;
    this.room = room;
  }

  static async load(store: Store, up: Up, partSize: number, room: number): Promise<TarFeed> {
    const feed = new TarFeed(store, `staging/${up.account}/${up.id}`, partSize, room);
    const tar = up.tar;
    feed.phase = tar.phase;
    feed.header = fromB64(tar.header);
    feed.tail = fromB64(tar.tail);
    feed.pad = tar.pad;
    feed.rpm = tar.rpm;
    feed.repomd = tar.repomd;
    feed.files = tar.files;
    feed.written = tar.written;
    feed.produced = tar.produced.map((file) => ({ ...file }));
    feed.ready = tar.ready;
    feed.copy = tar.copy ? { ...tar.copy, etags: tar.copy.etags.map((part) => ({ ...part })) } : null;
    feed.copyIndex = tar.copyIndex;
    if (tar.file) {
      feed.loadedUpload = tar.file.upload;
      const hold = tar.file.holdGen ? await store.get(holdObject(up, tar.file.holdGen)) : new Uint8Array();
      if (tar.file.holdGen && !hold) throw new Error("missing hold");
      feed.file = { ...tar.file, etags: tar.file.etags.map((part) => ({ ...part })), hold: hold ?? new Uint8Array() };
    }
    return feed;
  }

  finished(): boolean {
    return this.phase === "zero" && this.tail.length === 0 && !this.file;
  }

  snapshot(): TarState {
    return {
      phase: this.phase,
      header: toB64(this.header),
      tail: toB64(this.tail),
      pad: this.pad,
      file: this.file
        ? {
            name: this.file.name,
            size: this.file.size,
            left: this.file.left,
            key: this.file.key,
            upload: this.file.upload,
            part: this.file.part,
            etags: this.file.etags,
            holdGen: this.file.hold.length ? this.file.holdGen : 0,
            seen: this.file.seen,
            skipping: this.file.skipping,
          }
        : null,
      rpm: this.rpm,
      repomd: this.repomd,
      files: this.files,
      written: this.written,
      produced: this.produced,
      ready: this.ready,
      copy: this.copy,
      copyIndex: this.copyIndex,
    };
  }

  async persistHold(up: Up) {
    if (!this.file || this.file.hold.length === 0) {
      if (this.file) this.file.holdGen = 0;
      return;
    }
    const next = this.file.holdGen === 1 ? 2 : 1;
    await this.store.put(holdObject(up, next), this.file.hold, "application/octet-stream");
    this.file.holdGen = next;
  }

  async push(chunk: Uint8Array) {
    try {
      await this.consume(chunk);
    } catch (err) {
      await this.onError(err);
      throw err;
    }
  }

  async onError(err: unknown) {
    const upload = this.file?.upload;
    if (!upload || !this.file) return;
    const fresh = this.started !== "" && this.started === upload && this.started !== this.loadedUpload;
    if (err instanceof HTTPError || fresh) await this.store.abortMultipart(this.file.key, upload).catch(() => {});
  }

  async consume(chunk: Uint8Array) {
    let data = chunk;
    if (this.tail.length) {
      const merged = new Uint8Array(this.tail.length + chunk.length);
      merged.set(this.tail, 0);
      merged.set(chunk, this.tail.length);
      this.tail = new Uint8Array();
      data = merged;
    }
    let pos = 0;
    while (pos < data.length) {
      if (this.phase === "header") {
        const need = 512 - this.header.length;
        const n = Math.min(need, data.length - pos);
        const next = new Uint8Array(this.header.length + n);
        next.set(this.header, 0);
        next.set(data.subarray(pos, pos + n), this.header.length);
        this.header = next;
        pos += n;
        if (this.header.length < 512) break;
        await this.openHeader();
      } else if (this.phase === "body") {
        const file = this.file;
        if (!file) throw new HTTPError(422, "bad tar");
        const n = Math.min(file.left, data.length - pos);
        await this.writeBody(file, data.subarray(pos, pos + n));
        pos += n;
        file.left -= n;
        if (file.left === 0) await this.finishBody();
      } else if (this.phase === "pad") {
        const n = Math.min(this.pad, data.length - pos);
        pos += n;
        this.pad -= n;
        if (this.pad === 0) this.phase = "header";
      } else {
        if (data.length - pos < 512) {
          this.tail = data.slice(pos);
          break;
        }
        if (!zeroBlock(data.subarray(pos, pos + 512))) throw new HTTPError(422, "bad tar");
        pos += 512;
      }
    }
  }

  async openHeader() {
    const header = this.header;
    this.header = new Uint8Array();
    if (zeroBlock(header)) {
      this.phase = "zero";
      return;
    }
    if (!tarChecksum(header)) throw new HTTPError(422, "bad tar");
    const name = tarName(header);
    const size = tarOctal(header.subarray(124, 136));
    const kind = header[156];
    if (kind === 53 || name.endsWith("/")) {
      this.phase = "pad";
      this.pad = size + pad(size);
      return;
    }
    if (kind !== 0 && kind !== 48) throw new HTTPError(422, "bad path");
    if (!allowPath(name)) throw new HTTPError(422, "bad path");
    if (++this.files > 2000) throw new HTTPError(422, "bad tar");
    if (name.endsWith(".rpm")) this.rpm = true;
    if (name.endsWith("/repomd.xml")) this.repomd = true;
    this.file = {
      name,
      size,
      left: size,
      key: `${this.prefix}/${name}`,
      upload: "",
      part: 0,
      etags: [],
      hold: new Uint8Array(),
      holdGen: 0,
      seen: 0,
      skipping: false,
    };
    this.phase = "body";
    if (size === 0) await this.finishBody();
  }

  async writeBody(file: NonNullable<TarFeed["file"]>, bytes: Uint8Array) {
    if (file.skipping || bytes.length === 0) return;
    if (file.name.endsWith(".rpm")) {
      const magic = [0xed, 0xab, 0xee, 0xdb];
      for (let i = 0; i < bytes.length && file.seen < 4; i++, file.seen++) {
        if (bytes[i] !== magic[file.seen]) throw new HTTPError(422, "bad rpm");
      }
    }
    if (this.written + bytes.length > this.room) throw new HTTPError(413, "too much data");
    this.written += bytes.length;
    if (!file.buf) {
      file.buf = new Uint8Array(this.partSize);
      if (file.hold.length) file.buf.set(file.hold, 0);
    }
    let filled = file.hold.length;
    let off = 0;
    while (off < bytes.length) {
      const room = this.partSize - filled;
      const take = Math.min(room, bytes.length - off);
      file.buf.set(bytes.subarray(off, off + take), filled);
      filled += take;
      off += take;
      if (filled === this.partSize) {
        if (await this.emitPart(file, file.buf.slice())) return;
        filled = 0;
      }
    }
    file.hold = filled === 0 ? new Uint8Array() : file.buf.subarray(0, filled);
  }

  async emitPart(file: NonNullable<TarFeed["file"]>, body: Uint8Array): Promise<boolean> {
    if (!file.upload) {
      file.upload = await this.store.startMultipart(file.key);
      if (file.upload !== this.loadedUpload) this.started = file.upload;
    }
    const n = file.part + 1;
    try {
      const etag = await this.store.putPart(file.key, file.upload, n, body);
      file.part = n;
      file.etags.push({ n, etag });
      return false;
    } catch (err) {
      if (await this.alive(file)) return true;
      throw err;
    }
  }

  async finishBody() {
    const file = this.file;
    if (!file) throw new HTTPError(422, "bad tar");
    if (file.name.endsWith(".rpm") && !file.skipping && file.seen < 4) throw new HTTPError(422, "bad rpm");
    if (!file.skipping) {
      if (!file.upload) await this.store.put(file.key, file.hold, contentType(file.key));
      else {
        if (file.hold.length) {
          const n = file.part + 1;
          try {
            const etag = await this.store.putPart(file.key, file.upload, n, file.hold);
            file.part = n;
            file.etags.push({ n, etag });
          } catch (err) {
            if (!(await this.alive(file))) throw err;
          }
        }
        if (!file.skipping) {
          try {
            await this.store.completeMultipart(file.key, file.upload, file.etags);
          } catch (err) {
            if (!(await this.store.exists(file.key))) throw err;
          }
        }
      }
    }
    this.produced.push({ name: file.name, size: file.size });
    this.file = null;
    const extra = pad(file.size);
    this.phase = extra === 0 ? "header" : "pad";
    this.pad = extra;
  }

  async alive(file: NonNullable<TarFeed["file"]>): Promise<boolean> {
    if (!(await this.store.exists(file.key))) return false;
    file.skipping = true;
    file.hold = new Uint8Array();
    return true;
  }
}

function emptyTar(): TarState {
  return {
    phase: "header",
    header: "",
    tail: "",
    pad: 0,
    file: null,
    rpm: false,
    repomd: false,
    files: 0,
    written: 0,
    produced: [],
    ready: false,
    copy: null,
    copyIndex: 0,
  };
}

function holdObject(up: Up, gen: number): string {
  return `incoming/${up.account}/${up.id}/hold/${gen}`;
}

async function dropStaleHold(store: Store, up: Up, prev: number, keep: number) {
  for (const gen of [1, 2]) {
    if (gen !== keep && gen !== 0) await store.del(holdObject(up, gen)).catch(() => {});
  }
  if (prev && prev !== keep) await store.del(holdObject(up, prev)).catch(() => {});
}

async function touchStage(store: Store, up: Up) {
  await store.put(`staging/${up.account}/${up.id}.json`, Buffer.from(JSON.stringify({ at: now() })), "application/json");
}

function toB64(bytes: Uint8Array): string {
  return bytes.length ? Buffer.from(bytes).toString("base64") : "";
}

function fromB64(value: string): Uint8Array {
  return value ? new Uint8Array(Buffer.from(value, "base64")) : new Uint8Array();
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

function headHeaders(up: Up): Record<string, string> {
  const headers = tusHeaders(up);
  if (up.done) headers["x-ftuna-repo"] = `/${up.account}/${up.id}/`;
  return headers;
}

function bitsOf(env: Env): number {
  const n = Number(env.POW_BITS || "34");
  if (!Number.isInteger(n) || n < 1 || n > 40) return 34;
  return n;
}

// Work scales as 2^bits. 80% less time is a fifth of the hashes, log2(5) fewer bits, rounded.
function easierBits(bits: number): number {
  const n = Math.round(bits + Math.log2(0.2));
  if (n < 1) return 1;
  return n < bits ? n : bits;
}

function allowedBits(env: Env, bits: number): boolean {
  if (!Number.isInteger(bits)) return false;
  const full = bitsOf(env);
  return bits === full || bits === easierBits(full);
}

const GITHUB_META = "https://api.github.com/meta";
const ACTIONS_TTL = 60 * 60 * 1000;
const V6_ALL = (1n << 128n) - 1n;

type V4Net = { net: number; mask: number };
type V6Net = { net: bigint; mask: bigint };
type ActionsNets = { v4: V4Net[]; v6: V6Net[] };

let actionsCache: { until: number; nets: ActionsNets } | null = null;
let actionsLoad: Promise<ActionsNets | null> | null = null;

export function clearActionsCache(): void {
  actionsCache = null;
  actionsLoad = null;
}

async function bitsFor(request: Request, env: Env): Promise<number> {
  const bits = bitsOf(env);
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return bits;
  const nets = await actionsNets();
  if (!nets || !inActions(ip, nets)) return bits;
  return easierBits(bits);
}

async function actionsNets(): Promise<ActionsNets | null> {
  if (actionsCache && actionsCache.until > Date.now()) return actionsCache.nets;
  if (!actionsLoad) {
    const load = loadActionsNets().finally(() => {
      if (actionsLoad === load) actionsLoad = null;
    });
    actionsLoad = load;
  }
  return actionsLoad;
}

async function loadActionsNets(): Promise<ActionsNets | null> {
  try {
    const got = await fetchMeta();
    if (!got) return null;
    const nets = parseActions(got.body);
    if (!nets) {
      if (got.fromEdge) await edgeCache()?.delete(GITHUB_META);
      return null;
    }
    if (!got.fromEdge) await rememberMeta(got.body);
    actionsCache = { until: Date.now() + ACTIONS_TTL, nets };
    return nets;
  } catch {
    return null;
  }
}

async function fetchMeta(): Promise<{ body: unknown; fromEdge: boolean } | null> {
  const edge = edgeCache();
  if (edge) {
    try {
      const hit = await edge.match(GITHUB_META);
      if (hit) return { body: await hit.json(), fromEdge: true };
    } catch {
      // Fetch the list. A failed lookup is not treated as GitHub Actions.
    }
  }
  const res = await fetch(GITHUB_META, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ftuna-worker" },
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  return { body: await res.json(), fromEdge: false };
}

async function rememberMeta(body: unknown) {
  const edge = edgeCache();
  if (!edge) return;
  try {
    await edge.put(
      GITHUB_META,
      new Response(JSON.stringify(body), { headers: { "cache-control": "public, max-age=3600" } }),
    );
  } catch {
    // This isolate still has the parsed list in memory.
  }
}

function edgeCache(): Cache | null {
  if (typeof caches === "undefined" || !caches?.default) return null;
  return caches.default;
}

function parseActions(body: unknown): ActionsNets | null {
  if (!body || typeof body !== "object") return null;
  const meta = body as { actions?: unknown; actions_macos?: unknown };
  if (!Array.isArray(meta.actions)) return null;
  const nets: ActionsNets = { v4: [], v6: [] };
  addList(nets, meta.actions);
  if (Array.isArray(meta.actions_macos)) addList(nets, meta.actions_macos);
  if (nets.v4.length === 0 && nets.v6.length === 0) return null;
  return nets;
}

function addList(nets: ActionsNets, list: unknown[]) {
  for (const item of list) if (typeof item === "string") addCIDR(nets, item);
}

function addCIDR(nets: ActionsNets, cidr: string) {
  const slash = cidr.lastIndexOf("/");
  if (slash <= 0) return;
  const base = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 1) return;
  if (base.includes(":")) {
    if (prefix > 128) return;
    const addr = parseIPv6(base);
    if (addr === null) return;
    const mask = (V6_ALL << BigInt(128 - prefix)) & V6_ALL;
    nets.v6.push({ net: addr & mask, mask });
    return;
  }
  if (prefix > 32) return;
  const addr = parseIPv4(base);
  if (addr === null) return;
  const mask = v4mask(prefix);
  nets.v4.push({ net: (addr & mask) >>> 0, mask });
}

function inActions(ip: string, nets: ActionsNets): boolean {
  if (ip.includes(":")) {
    const addr = parseIPv6(ip);
    if (addr === null) return false;
    return nets.v6.some((net) => (addr & net.mask) === net.net);
  }
  const addr = parseIPv4(ip);
  if (addr === null) return false;
  return nets.v4.some((net) => ((addr & net.mask) >>> 0) === net.net);
}

function v4mask(prefix: number): number {
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

function parseIPv6(input: string): bigint | null {
  let ip = input;
  if (ip.includes(".")) {
    const last = ip.lastIndexOf(":");
    if (last < 0) return null;
    const v4 = parseIPv4(ip.slice(last + 1));
    if (v4 === null) return null;
    ip = `${ip.slice(0, last + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    n = (n << 16n) + BigInt(parseInt(group, 16));
  }
  return n;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function saveUp(store: Store, up: Up) {
  const { legacy: _legacy, ...rest } = up;
  await store.put(`incoming/${up.account}/${up.id}.json`, Buffer.from(JSON.stringify(rest)), "application/json");
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
  if (!value.tar) {
    value.legacy = value.offset > 0;
    value.tar = emptyTar();
  }
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
  const file = up.tar?.file;
  if (file?.upload) await store.abortMultipart(file.key, file.upload).catch(() => {});
  if (up.tar?.copy?.upload) {
    await store.abortMultipart(`scratch/${up.account}/${up.id}/${up.tar.copy.name}`, up.tar.copy.upload).catch(() => {});
  }
  await deletePrefix(store, `incoming/${up.account}/${up.id}/`);
  await store.del(`incoming/${up.account}/${up.id}.json`);
  await deletePrefix(store, `staging/${up.account}/${up.id}/`);
  await store.del(`staging/${up.account}/${up.id}.json`);
}

async function deletePrefix(store: Store, prefix: string) {
  for (const key of await store.keys(prefix)) await store.del(key);
}

function contentLength(request: Request): number {
  const raw = request.headers.get("content-length");
  if (raw === null || raw === "") return Number.NaN;
  return Number(raw);
}

async function discardBody(request: Request) {
  await forEachChunk(request, MAX_CHUNK, async () => {});
}

async function forEachChunk(request: Request, max: number, onChunk: (part: Uint8Array) => Promise<void>): Promise<number> {
  const reader = request.body?.getReader();
  if (!reader) return 0;
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.byteLength) {
      const take = Math.min(PART, value.byteLength - off);
      n += take;
      if (n > max) {
        await reader.cancel();
        throw new HTTPError(413, "chunk too large");
      }
      await onChunk(value.subarray(off, off + take));
      off += take;
    }
  }
  return n;
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
  const out = new Uint8Array(n);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
