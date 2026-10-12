import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { handle } from "./index.ts";
import { allowPath, clearActionsCache, copyPartBytes, copySteps, extractTar, HTTPError, runGC, scratchDocs, zeroBits } from "./scratch.ts";
import { route } from "./site.ts";
import type { Store } from "./store.ts";

const exec = promisify(execFile);

test("scratch root is the docs page and a listing", async () => {
  assert.equal(route("scratchpad-repo.ftuna.eu", "/").kind, "docs");
  assert.equal(route("scratchpad-repo.ftuna.eu", "/acct/").kind, "store");
  const mem = memory();
  await mem.store.put("scratch/acct/repo/meta.json", new TextEncoder().encode("{}\n"), "application/json");
  await mem.store.put("scratch/note.txt", new TextEncoder().encode("hi"), "text/plain");
  const res = await handle(new Request("https://scratchpad-repo.ftuna.eu/"), env(), mem.store);
  assert.equal(res.status, 200);
  const plain = await res.text();
  assert.match(plain, /ustar/);
  assert.match(plain, /Index of \/\n/);
  assert.match(plain, /^acct\/$/m);
  assert.match(plain, /^note\.txt  2 B$/m);
  assert.ok(scratchDocs.includes("Bearer"));

  const html = await handle(
    new Request("https://scratchpad-repo.ftuna.eu/", { headers: { accept: "text/html" } }),
    env(),
    mem.store,
  );
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await html.text();
  assert.equal(body.includes("<pre>"), false);
  assert.match(body, /<article class="doc">/);
  assert.match(body, /<h1>Scratchpad<\/h1>/);
  assert.match(body, /<p>Temporary rpm repositories\./);
  assert.match(body, /Bearer &lt;token&gt;/);
  assert.match(body, /href="https:\/\/tus\.io\/protocols\/resumable-upload"/);
  assert.match(body, /<h2>Index of \/<\/h2>/);
  assert.match(body, /href="acct\/"/);
  assert.match(body, /href="note\.txt"/);
  assert.match(body, />2 B</);
});

test("paths are a repo and nothing else", () => {
  assert.equal(allowPath("aarch64/app.rpm"), true);
  assert.equal(allowPath("aarch64/github.com/owner/name/app.rpm"), true);
  assert.equal(allowPath("aarch64/repodata/repomd.xml"), true);
  assert.equal(allowPath("aarch64/repodata/ab-primary.xml.gz"), true);
  assert.equal(allowPath("info.json.xz"), true);
  assert.equal(allowPath("../x.rpm"), false);
  assert.equal(allowPath("aarch64/../../x.rpm"), false);
  assert.equal(allowPath("readme.txt"), false);
  assert.equal(allowPath("aarch64/repodata/notes.txt"), false);
});

test("tar files are copied in bounded pieces", async () => {
  const rpm = new Uint8Array(300 * 1024);
  rpm.set([0xed, 0xab, 0xee, 0xdb]);
  for (let i = 4; i < rpm.length; i++) rpm[i] = i & 255;
  const archive = ustar([
    { name: "aarch64/app.rpm", data: rpm },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<repomd/>") },
  ]);
  const mem = memory();
  const src = cursor(archive);
  await extractTar(mem.store, src, "scratch/acct/repo", 64 * 1024, 20 * 1024 * 1024 * 1024);
  assert.ok(mem.maxPart <= 64 * 1024);
  assert.ok(mem.maxPart > 0);
  assert.ok(mem.maxRange <= 256 * 1024);
  const got = await mem.store.get("scratch/acct/repo/aarch64/app.rpm");
  assert.deepEqual(got, rpm);
});

test("a bad rpm or a stray file is rejected", async () => {
  const bad = ustar([
    { name: "aarch64/app.rpm", data: new Uint8Array([1, 2, 3, 4]) },
    { name: "aarch64/repodata/repomd.xml", data: new Uint8Array([60]) },
  ]);
  await assert.rejects(extractTar(memory().store, cursor(bad), "scratch/a/b", 1024, 1 << 20), (err: unknown) => {
    assert.ok(err instanceof HTTPError);
    assert.equal(err.status, 422);
    return true;
  });
  const stray = ustar([
    { name: "aarch64/app.rpm", data: new Uint8Array([0xed, 0xab, 0xee, 0xdb]) },
    { name: "aarch64/repodata/repomd.xml", data: new Uint8Array([60]) },
    { name: "notes.txt", data: new Uint8Array([1]) },
  ]);
  await assert.rejects(extractTar(memory().store, cursor(stray), "scratch/a/b", 1024, 1 << 20), /bad path/);
});

test("github actions challenges take about a fifth as long", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  let meta: { status: number; body: string } | { error: true } = { status: 200, body: "{}" };
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.github.com/meta");
    calls++;
    if ("error" in meta) throw new Error("meta down");
    return new Response(meta.body, { status: meta.status, headers: { "content-type": "application/json" } });
  };
  const bitsFor = async (ip: string | undefined, seen = env()) => {
    const res = await api(seen, memory().store, "/v1/challenge", {
      method: "POST",
      headers: ip ? { "cf-connecting-ip": ip } : {},
    });
    const ch = JSON.parse(await res.text()) as { challenge: string; bits: number };
    return { status: res.status, ...ch };
  };
  try {
    assert.match(scratchDocs, /GitHub-hosted Actions/);
    clearActionsCache();
    const plain = await bitsFor(undefined);
    assert.equal(calls, 0);
    assert.equal(plain.bits, 8);

    meta = { status: 200, body: JSON.stringify({ actions: ["203.0.113.0/24", "not-a-cidr", "2001:db8:1::/48"] }) };
    clearActionsCache();
    assert.equal((await bitsFor("198.51.100.10")).bits, 8);
    clearActionsCache();
    assert.equal((await bitsFor("203.0.113.255")).bits, 6);
    clearActionsCache();
    assert.equal((await bitsFor("203.0.114.0")).bits, 8);
    clearActionsCache();
    assert.equal((await bitsFor("2001:0db8:0001:0000:0000:0000:0000:0001")).bits, 6);
    clearActionsCache();
    assert.equal((await bitsFor("2001:db8:2::1")).bits, 8);

    meta = {
      status: 200,
      body: JSON.stringify({ actions: ["203.0.113.0/24"], actions_macos: ["198.51.100.8/32"] }),
    };
    clearActionsCache();
    assert.equal((await bitsFor("198.51.100.8")).bits, 6);
    clearActionsCache();
    assert.equal((await bitsFor("203.0.113.10", { POW_SECRET: "test-secret", POW_BITS: "34" } as Env)).bits, 32);

    meta = { error: true };
    clearActionsCache();
    const down = await bitsFor("203.0.113.10");
    assert.equal(down.status, 200);
    assert.equal(down.bits, 8);
    const afterDown = calls;
    assert.equal((await bitsFor("203.0.113.10")).bits, 8);
    assert.equal(calls, afterDown + 1);

    meta = { status: 200, body: JSON.stringify({ hooks: ["203.0.113.0/24"] }) };
    clearActionsCache();
    assert.equal((await bitsFor("203.0.113.10")).bits, 8);
    meta = { status: 500, body: "" };
    clearActionsCache();
    assert.equal((await bitsFor("203.0.113.10")).bits, 8);
    meta = { status: 200, body: "nope" };
    clearActionsCache();
    assert.equal((await bitsFor("203.0.113.10")).bits, 8);

    meta = { status: 200, body: JSON.stringify({ actions: ["203.0.113.0/24"] }) };
    clearActionsCache();
    const before = calls;
    assert.equal((await bitsFor("203.0.113.10")).bits, 6);
    meta = { status: 200, body: JSON.stringify({ actions: ["198.51.100.0/24"] }) };
    assert.equal((await bitsFor("203.0.113.10")).bits, 6);
    assert.equal(calls, before + 1);

    const mem = memory();
    const easy = await api(env(), mem.store, "/v1/challenge", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    const ch = JSON.parse(await easy.text()) as { challenge: string; bits: number };
    assert.equal(ch.bits, 6);
    let solution = "";
    for (let i = 0; ; i++) {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ch.challenge + i)));
      if (zeroBits(hash) >= ch.bits) {
        solution = String(i);
        break;
      }
    }
    const registered = await api(env(), mem.store, "/v1/register", {
      method: "POST",
      body: JSON.stringify({ challenge: ch.challenge, solution }),
    });
    assert.equal(registered.status, 200, await registered.clone().text());
    const tampered = ch.challenge.split(".");
    tampered[1] = "5";
    const rejected = await api(env(), mem.store, "/v1/register", {
      method: "POST",
      body: JSON.stringify({ challenge: tampered.join("."), solution: "1" }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    globalThis.fetch = realFetch;
    clearActionsCache();
  }
});

test("register, upload, and expiry", async () => {
  const mem = memory();
  const seen = env();
  const challenge = await api(seen, mem.store, "/v1/challenge", { method: "POST" });
  const ch = JSON.parse(await challenge.text()) as { challenge: string; bits: number };
  let solution = "";
  for (let i = 0; ; i++) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ch.challenge + i)));
    if (zeroBits(hash) >= ch.bits) {
      solution = String(i);
      break;
    }
  }
  const registered = await api(seen, mem.store, "/v1/register", {
    method: "POST",
    body: JSON.stringify({ challenge: ch.challenge, solution }),
  });
  assert.equal(registered.status, 200);
  const account = JSON.parse(await registered.text()) as { token: string; account: string };
  const who = await api(seen, mem.store, "/v1/account", { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(who.status, 200);
  assert.equal(JSON.parse(await who.text()).account, account.account);
  const stranger = await api(seen, mem.store, "/v1/account", { headers: { authorization: "Bearer nope" } });
  assert.equal(stranger.status, 401);
  const rpm = new Uint8Array([0xed, 0xab, 0xee, 0xdb, 9]);
  const archive = ustar([
    { name: "i486/app.rpm", data: rpm },
    { name: "i486/repodata/repomd.xml", data: new TextEncoder().encode("<repomd/>") },
  ]);
  const want = "0123456789abcdef0123456789abcdef";
  const bad = await api(seen, mem.store, "/v1/repos", {
    method: "POST",
    headers: { authorization: `Bearer ${account.token}`, "tus-resumable": "1.0.0", "upload-length": "1", "x-ftuna-id": "Nope" },
  });
  assert.equal(bad.status, 400);
  const unnamed = await api(seen, mem.store, "/v1/repos", {
    method: "POST",
    headers: { authorization: `Bearer ${account.token}`, "tus-resumable": "1.0.0", "upload-length": "1" },
  });
  assert.equal(unnamed.status, 400);
  const created = await api(seen, mem.store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(archive.length),
      "x-ftuna-id": want,
    },
  });
  assert.equal(created.status, 201);
  const id = new URL(created.headers.get("location")!).pathname.split("/").pop()!;
  assert.equal(id, want);
  const patched = await api(seen, mem.store, `/v1/repos/${id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: archive,
  });
  assert.equal(patched.status, 204, await patched.clone().text());
  const stored = await mem.store.get(`scratch/${account.account}/${id}/i486/app.rpm`);
  assert.deepEqual(stored, rpm);
  const user = JSON.parse(new TextDecoder().decode((await mem.store.get(`scratch/${account.account}/user.json`))!)) as {
    publishCount: number;
    lastExpire: number;
  };
  assert.equal(user.publishCount, 1);
  user.lastExpire = 1;
  await mem.store.put(
    `scratch/${account.account}/user.json`,
    new TextEncoder().encode(JSON.stringify(user)),
    "application/json",
  );
  await runGC(mem.store, user.lastExpire + 14 * 86400 + 10);
  assert.equal(await mem.store.get(`scratch/${account.account}/user.json`), null);
  const after = await api(seen, mem.store, "/v1/account", { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(after.status, 401);
});

test("a named repo is replaced and a bad upload leaves it", async () => {
  const mem = memory();
  const seen = env();
  const account = await register(seen, mem.store);
  const name = "github_mrcyjanek_sfos_mullvad_pr_213";
  const oldRpm = new Uint8Array([0xed, 0xab, 0xee, 0xdb, 1]);
  const first = ustar([
    { name: "aarch64/old.rpm", data: oldRpm },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<old/>") },
  ]);
  const created = await upload(seen, mem.store, account.token, name, first);
  assert.equal(created.status, 204, await created.clone().text());
  assert.equal(created.headers.get("x-ftuna-repo"), `/${account.account}/${name}/`);
  const bad = ustar([
    { name: "aarch64/new.rpm", data: new Uint8Array([0xed, 0xab, 0xee, 0xdb, 2]) },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<new/>") },
    { name: "notes.txt", data: new Uint8Array([1]) },
  ]);
  const rejected = await upload(seen, mem.store, account.token, name, bad);
  assert.equal(rejected.status, 422);
  assert.deepEqual(await mem.store.get(`scratch/${account.account}/${name}/aarch64/old.rpm`), oldRpm);
  assert.equal(await mem.store.get(`scratch/${account.account}/${name}/aarch64/new.rpm`), null);
  assert.deepEqual(await mem.store.keys("staging/"), []);

  const fresh = new Uint8Array([0xed, 0xab, 0xee, 0xdb, 3]);
  const second = ustar([
    { name: "aarch64/new.rpm", data: fresh },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<new/>") },
  ]);
  const replaced = await upload(seen, mem.store, account.token, name, second);
  assert.equal(replaced.status, 204, await replaced.clone().text());
  assert.equal(replaced.headers.get("x-ftuna-repo"), `/${account.account}/${name}/`);
  assert.equal(await mem.store.get(`scratch/${account.account}/${name}/aarch64/old.rpm`), null);
  assert.deepEqual(await mem.store.get(`scratch/${account.account}/${name}/aarch64/new.rpm`), fresh);
  assert.equal(new TextDecoder().decode(await mem.store.get(`scratch/${account.account}/${name}/aarch64/repodata/repomd.xml`)), "<new/>");
  const user = JSON.parse(new TextDecoder().decode((await mem.store.get(`scratch/${account.account}/user.json`))!)) as {
    publishCount: number;
    repos: { id: string }[];
  };
  assert.equal(user.publishCount, 2);
  assert.deepEqual(user.repos.map((repo) => repo.id), [name]);
  assert.deepEqual(await mem.store.keys("staging/"), []);
});

test("several uploads can run, and the same name drops the unfinished one", async () => {
  const mem = memory();
  const seen = env();
  const account = await register(seen, mem.store);
  const raw = await mem.store.get(`scratch/${account.account}/user.json`);
  const stored = JSON.parse(new TextDecoder().decode(raw!)) as { pending?: unknown };
  stored.pending = { id: "left-behind", bytes: 4 };
  await mem.store.put(`scratch/${account.account}/user.json`, new TextEncoder().encode(JSON.stringify(stored)), "application/json");
  const open = (len: number, id?: string) =>
    api(seen, mem.store, "/v1/repos", {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.token}`,
        "tus-resumable": "1.0.0",
        "upload-length": String(len),
        ...(id ? { "x-ftuna-id": id } : {}),
      },
    });
  const first = await open(8 * 1024 * 1024, "alpha");
  assert.equal(first.status, 201, await first.clone().text());
  const chunk = new Uint8Array(5 * 1024 * 1024);
  const patched = await api(seen, mem.store, "/v1/repos/alpha", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: chunk,
  });
  assert.equal(patched.status, 204, await patched.clone().text());
  const second = await open(100, "beta");
  assert.equal(second.status, 201, await second.clone().text());
  const again = await open(100, "alpha");
  assert.equal(again.status, 201, await again.clone().text());
  const head = await api(seen, mem.store, "/v1/repos/alpha", {
    method: "HEAD",
    headers: { authorization: `Bearer ${account.token}`, "tus-resumable": "1.0.0" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("upload-offset"), "0");
  assert.equal(head.headers.get("upload-length"), "100");
  assert.deepEqual(await mem.store.keys(`incoming/${account.account}/alpha/`), []);
  assert.ok(await mem.store.get(`incoming/${account.account}/beta.json`));
  const user = JSON.parse(new TextDecoder().decode((await mem.store.get(`scratch/${account.account}/user.json`))!)) as {
    pending?: unknown;
  };
  assert.equal(user.pending, undefined);
  assert.match(scratchDocs, /32 uploads at a time/);
  assert.match(scratchDocs, /no new data for an hour/);
});

test("an idle upload is deleted and a fresh one stays", async () => {
  const mem = memory();
  const account = "ab".repeat(16);
  const at = 1_800_000_000;
  const user = {
    tokenHash: "x",
    created: at,
    publishCount: 0,
    lastExpire: 0,
    repos: [] as { id: string; created: number; expire: number; bytes: number }[],
    pending: { id: "stale", bytes: 4 },
  };
  await mem.store.put(`scratch/${account}/user.json`, new TextEncoder().encode(JSON.stringify(user) + "\n"), "application/json");
  const idle = { account, id: "stale", length: 4, offset: 1, at: 1, parts: [{ off: 0, len: 1 }] };
  const live = { account, id: "live", length: 4, offset: 0, at, parts: [] as { off: number; len: number }[] };
  await mem.store.put(`incoming/${account}/stale.json`, new TextEncoder().encode(JSON.stringify(idle)), "application/json");
  await mem.store.put(`incoming/${account}/stale/0`, new Uint8Array([7]), "application/octet-stream");
  await mem.store.put(`incoming/${account}/live.json`, new TextEncoder().encode(JSON.stringify(live)), "application/json");
  await runGC(mem.store, at);
  assert.equal(await mem.store.get(`incoming/${account}/stale.json`), null);
  assert.equal(await mem.store.get(`incoming/${account}/stale/0`), null);
  assert.ok(await mem.store.get(`incoming/${account}/live.json`));
  const saved = JSON.parse(new TextDecoder().decode((await mem.store.get(`scratch/${account}/user.json`))!)) as { pending?: unknown };
  assert.equal(saved.pending, undefined);
});

test("abandoned staging is deleted", async () => {
  const mem = memory();
  await mem.store.put("staging/acct/name.json", new TextEncoder().encode(JSON.stringify({ at: 1 })), "application/json");
  await mem.store.put("staging/acct/name/aarch64/app.rpm", new Uint8Array([1]), "application/octet-stream");
  await mem.store.put("staging/acct/fresh.json", new TextEncoder().encode(JSON.stringify({ at: 1_000_000_000 })), "application/json");
  await mem.store.put("staging/acct/fresh/aarch64/app.rpm", new Uint8Array([2]), "application/octet-stream");
  await runGC(mem.store, 1 + 86400 + 10);
  assert.equal(await mem.store.get("staging/acct/name.json"), null);
  assert.equal(await mem.store.get("staging/acct/name/aarch64/app.rpm"), null);
  assert.ok(await mem.store.get("staging/acct/fresh.json"));
  assert.ok(await mem.store.get("staging/acct/fresh/aarch64/app.rpm"));
});

test("the go client can publish", async () => {
  const mem = memory();
  const seen = env();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handle(request, seen, mem.store);
    const out = Buffer.from(await response.arrayBuffer());
    const rh: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      rh[key] = value;
    });
    res.writeHead(response.status, rh);
    res.end(out);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await exec("go", ["test", "./internal/scratch/", "-run", "TestPublishLive|TestPublishReplace", "-count=1"], {
      cwd: fileURLToPath(new URL("../../ftuna", import.meta.url)),
      env: { ...process.env, FTUNA_SCRATCH_URL: `http://127.0.0.1:${port}` },
    });
  } finally {
    server.close();
  }
  const rpm = [...(await mem.store.keys("scratch/"))].find((key) => key.endsWith(".rpm"));
  assert.ok(rpm);
  const body = await mem.store.get(rpm!);
  assert.equal(body![0], 0xed);
  assert.equal(body![1], 0xab);
});

test("a storage error leaves the offset in place", async () => {
  const mem = memory();
  let fail = true;
  const store: Store = {
    ...mem.store,
    async put(key, body, type) {
      if (fail && key.endsWith(".rpm")) throw new Error("put 503 storage");
      return mem.store.put(key, body, type);
    },
  };
  const seen = env();
  const account = await register(seen, store);
  const name = "place";
  const rpm = new Uint8Array([0xed, 0xab, 0xee, 0xdb, 1, 2, 3, 4]);
  const archive = ustar([
    { name: "aarch64/app.rpm", data: rpm },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<repomd/>") },
  ]);
  const created = await api(seen, store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(archive.length),
      "x-ftuna-id": name,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const headers = {
    authorization: `Bearer ${account.token}`,
    "tus-resumable": "1.0.0",
    "upload-offset": "0",
    "content-type": "application/offset+octet-stream",
  };
  const first = await api(seen, store, `/v1/repos/${name}`, { method: "PATCH", headers, body: archive });
  assert.equal(first.status, 502);
  assert.match(await first.text(), /storage error/);
  const head = await api(seen, store, `/v1/repos/${name}`, {
    method: "HEAD",
    headers: { authorization: headers.authorization, "tus-resumable": "1.0.0" },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("upload-offset"), "0");
  fail = false;
  const second = await api(seen, store, `/v1/repos/${name}`, { method: "PATCH", headers, body: archive });
  assert.equal(second.status, 204, await second.clone().text());
  assert.equal(second.headers.get("x-ftuna-repo"), `/${account.account}/${name}/`);
  assert.deepEqual(await mem.store.get(`scratch/${account.account}/${name}/aarch64/app.rpm`), rpm);
});

test("a chunk can end inside the next header", async () => {
  const mem = memory();
  const seen = env();
  const account = await register(seen, mem.store);
  const data = new Uint8Array(5 * 1024 * 1024 - 512);
  data.set([0xed, 0xab, 0xee, 0xdb]);
  for (let i = 4; i < 64; i++) data[i] = i;
  const archive = ustar([
    { name: "aarch64/app.rpm", data },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<repomd/>") },
  ]);
  const cut = 5 * 1024 * 1024 + 100;
  assert.ok(cut < archive.length);
  const name = "split";
  const created = await api(seen, mem.store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(archive.length),
      "x-ftuna-id": name,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const send = (offset: number, body: Uint8Array) =>
    api(seen, mem.store, `/v1/repos/${name}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${account.token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": String(offset),
        "content-type": "application/offset+octet-stream",
      },
      body,
    });
  const first = await send(0, archive.subarray(0, cut));
  assert.equal(first.status, 204, await first.clone().text());
  assert.equal(first.headers.get("upload-offset"), String(cut));
  assert.equal(first.headers.get("x-ftuna-repo"), null);
  const second = await send(cut, archive.subarray(cut));
  assert.equal(second.status, 204, await second.clone().text());
  assert.equal(second.headers.get("x-ftuna-repo"), `/${account.account}/${name}/`);
  const stored = await mem.store.get(`scratch/${account.account}/${name}/aarch64/app.rpm`);
  assert.equal(stored?.length, data.length);
  assert.equal(stored?.[0], 0xed);
  assert.equal(stored?.[63], 63);
  assert.equal(
    new TextDecoder().decode(await mem.store.get(`scratch/${account.account}/${name}/aarch64/repodata/repomd.xml`)),
    "<repomd/>",
  );
});

test("a part storage error keeps the earlier chunk", async () => {
  const mem = memory();
  let fails = 1;
  const store: Store = {
    ...mem.store,
    async putPart(key, id, n, body) {
      if (fails > 0) {
        fails--;
        throw new Error("part 503 storage");
      }
      return mem.store.putPart(key, id, n, body);
    },
  };
  const seen = env();
  const account = await register(seen, store);
  const data = new Uint8Array(9 * 1024 * 1024);
  data.set([0xed, 0xab, 0xee, 0xdb]);
  data[100] = 42;
  const archive = ustar([
    { name: "aarch64/app.rpm", data },
    { name: "aarch64/repodata/repomd.xml", data: new TextEncoder().encode("<repomd/>") },
  ]);
  const name = "parts";
  const created = await api(seen, store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(archive.length),
      "x-ftuna-id": name,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const chunk = 5 * 1024 * 1024;
  let offset = 0;
  let failed = false;
  let repo = "";
  for (let guard = 0; guard < 8 && !repo; guard++) {
    const n = Math.min(chunk, archive.length - offset);
    const res = await api(seen, store, `/v1/repos/${name}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${account.token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": String(offset),
        "content-type": "application/offset+octet-stream",
      },
      body: archive.subarray(offset, offset + n),
    });
    if (res.status === 502) {
      assert.match(await res.text(), /storage error/);
      failed = true;
      const head = await api(seen, store, `/v1/repos/${name}`, {
        method: "HEAD",
        headers: { authorization: `Bearer ${account.token}`, "tus-resumable": "1.0.0" },
      });
      assert.equal(head.headers.get("upload-offset"), String(offset));
      continue;
    }
    assert.equal(res.status, 204, await res.clone().text());
    const next = Number(res.headers.get("upload-offset"));
    assert.ok(next >= offset);
    offset = next;
    repo = res.headers.get("x-ftuna-repo") ?? "";
  }
  assert.equal(failed, true);
  assert.equal(repo, `/${account.account}/${name}/`);
  const stored = await mem.store.get(`scratch/${account.account}/${name}/aarch64/app.rpm`);
  assert.equal(stored?.length, data.length);
  assert.equal(stored?.[100], 42);
});

test("a large object is copied across requests", async () => {
  const mem = memory();
  const seen = env();
  const account = await register(seen, mem.store);
  const huge = copyPartBytes * (copySteps + 1);
  const name = "wide";
  const up = {
    account: account.account,
    id: name,
    length: 100,
    offset: 80,
    at: Math.floor(Date.now() / 1000),
    parts: [] as { off: number; len: number }[],
    tar: {
      phase: "zero",
      header: "",
      tail: "",
      pad: 0,
      file: null,
      rpm: true,
      repomd: true,
      files: 2,
      written: huge + 8,
      produced: [
        { name: "aarch64/big.rpm", size: huge },
        { name: "aarch64/repodata/repomd.xml", size: 8 },
      ],
      ready: true,
      copy: null,
      copyIndex: 0,
    },
  };
  await mem.store.put(`incoming/${account.account}/${name}.json`, Buffer.from(JSON.stringify(up)), "application/json");
  await mem.store.put(
    `staging/${account.account}/${name}/aarch64/repodata/repomd.xml`,
    new TextEncoder().encode("<repomd/>"),
    "application/xml",
  );
  const ranges: [number, number][] = [];
  const store: Store = {
    ...mem.store,
    async copyPart(_from, to, id, n, start, end) {
      ranges.push([start, end]);
      return mem.store.putPart(to, id, n, new Uint8Array([n]));
    },
  };
  let offset = 80;
  let repo = "";
  let rounds = 0;
  let continued = 0;
  for (; rounds < 6 && !repo; rounds++) {
    const res = await api(seen, store, `/v1/repos/${name}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${account.token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": String(offset),
        "content-type": "application/offset+octet-stream",
      },
      body: offset === 100 ? new Uint8Array() : new Uint8Array(20),
    });
    assert.equal(res.status, 204, await res.clone().text());
    const next = Number(res.headers.get("upload-offset"));
    repo = res.headers.get("x-ftuna-repo") ?? "";
    assert.equal(next, 100);
    if (offset === 100) continued++;
    offset = next;
  }
  assert.ok(continued > 0);
  assert.ok(rounds > 1);
  assert.equal(repo, `/${account.account}/${name}/`);
  assert.equal(offset, 100);
  assert.equal(ranges.length, copySteps + 1);
  let covered = 0;
  for (const [start, end] of ranges) {
    assert.equal(start, covered);
    assert.ok(end - start <= copyPartBytes);
    covered = end;
  }
  assert.equal(covered, huge);
  assert.equal(
    new TextDecoder().decode(await mem.store.get(`scratch/${account.account}/${name}/aarch64/repodata/repomd.xml`)),
    "<repomd/>",
  );
});

test("six gibibytes is published in bounded steps", { timeout: 300_000 }, async () => {
  const rpmSize = 6 * 1024 * 1024 * 1024;
  const header = headerBlock("aarch64/big.rpm", rpmSize);
  const padLen = (512 - (rpmSize % 512)) % 512;
  const repomdBody = new TextEncoder().encode("<repomd/>");
  const repomdHeader = headerBlock("aarch64/repodata/repomd.xml", repomdBody.length);
  const repomdPad = (512 - (repomdBody.length % 512)) % 512;
  const repomdAt = header.length + rpmSize + padLen;
  const total = repomdAt + repomdHeader.length + repomdBody.length + repomdPad + 1024;
  const sparse = sparseStore();
  const seen = env();
  const account = await register(seen, sparse.store);
  const name = "huge";
  const created = await api(seen, sparse.store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(total),
      "x-ftuna-id": name,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const chunk = 8 * 1024 * 1024;
  const body = new Uint8Array(chunk);
  let at = 0;
  let repo = "";
  for (let guard = 0; guard < 2000 && !repo; guard++) {
    const n = Math.min(chunk, total - at);
    body.fill(0, 0, n);
    stamp(body, at, 0, header, n);
    const magicAt = header.length;
    for (let i = 0; i < 4; i++) {
      const pos = magicAt + i;
      if (pos >= at && pos < at + n) body[pos - at] = [0xed, 0xab, 0xee, 0xdb][i];
    }
    stamp(body, at, repomdAt, repomdHeader, n);
    stamp(body, at, repomdAt + repomdHeader.length, repomdBody, n);
    const res = await api(seen, sparse.store, `/v1/repos/${name}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${account.token}`,
        "tus-resumable": "1.0.0",
        "upload-offset": String(at),
        "content-type": "application/offset+octet-stream",
      },
      body: body.subarray(0, n),
    });
    assert.equal(res.status, 204, await res.clone().text());
    const next = Number(res.headers.get("upload-offset"));
    assert.ok(next >= at);
    at = next;
    repo = res.headers.get("x-ftuna-repo") ?? "";
  }
  assert.equal(repo, `/${account.account}/${name}/`);
  assert.equal(at, total);
  assert.equal(sparse.sizes.get(`scratch/${account.account}/${name}/aarch64/big.rpm`), rpmSize);
  assert.deepEqual(sparse.magic.get(`scratch/${account.account}/${name}/aarch64/big.rpm`), new Uint8Array([0xed, 0xab, 0xee, 0xdb]));
  assert.equal(
    new TextDecoder().decode(await sparse.store.get(`scratch/${account.account}/${name}/aarch64/repodata/repomd.xml`)),
    "<repomd/>",
  );
  assert.ok(sparse.maxPut <= 8 * 1024 * 1024);
  assert.ok(sparse.maxPart <= 8 * 1024 * 1024);
  assert.ok(sparse.maxCopy <= copyPartBytes);
});

function stamp(buf: Uint8Array, start: number, at: number, src: Uint8Array, n: number) {
  const from = Math.max(start, at);
  const to = Math.min(start + n, at + src.length);
  if (from >= to) return;
  buf.set(src.subarray(from - at, to - at), from - start);
}

function sparseStore(): {
  store: Store;
  sizes: Map<string, number>;
  magic: Map<string, Uint8Array>;
  maxPut: number;
  maxPart: number;
  maxCopy: number;
} {
  const objs = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  const magic = new Map<string, Uint8Array>();
  const ups = new Map<string, { n: number; len: number }[]>();
  const box = { maxPut: 0, maxPart: 0, maxCopy: 0 };
  let seq = 0;
  const keysOf = () => new Set([...objs.keys(), ...sizes.keys()]);
  const store: Store = {
    async get(key) {
      return objs.get(key) ?? null;
    },
    async put(key, body) {
      box.maxPut = Math.max(box.maxPut, body.byteLength);
      if (body.byteLength > 8 * 1024 * 1024) throw new Error("buffered " + body.byteLength);
      objs.set(key, body.slice());
      sizes.set(key, body.byteLength);
      if (key.endsWith(".rpm") && body.length >= 4) magic.set(key, body.slice(0, 4));
    },
    async copy(from, to) {
      const body = objs.get(from);
      if (!body) throw new Error("missing " + from);
      objs.set(to, body.slice());
      sizes.set(to, sizes.get(from) ?? body.byteLength);
      const mark = magic.get(from);
      if (mark) magic.set(to, mark);
    },
    async del(key) {
      objs.delete(key);
      sizes.delete(key);
      magic.delete(key);
    },
    async list(prefix) {
      const level = children([...keysOf()], prefix);
      return { dirs: level.dirs, files: level.keys.map((key) => ({ key, size: sizes.get(key) ?? objs.get(key)?.byteLength ?? 0 })) };
    },
    async keys(prefix) {
      return [...keysOf()].filter((key) => key.startsWith(prefix));
    },
    async range() {
      throw new Error("range");
    },
    async exists(key) {
      return objs.has(key) || sizes.has(key);
    },
    async startMultipart() {
      const id = String(++seq);
      ups.set(id, []);
      return id;
    },
    async putPart(key, id, n, body) {
      box.maxPart = Math.max(box.maxPart, body.byteLength);
      if (body.byteLength > 8 * 1024 * 1024) throw new Error("part " + body.byteLength);
      const parts = ups.get(id);
      if (!parts) throw new Error("missing upload");
      const prev = parts.find((part) => part.n === n);
      if (prev) prev.len = body.byteLength;
      else parts.push({ n, len: body.byteLength });
      if (n === 1 && body.length >= 4) magic.set(key, body.slice(0, 4));
      return `"${n}"`;
    },
    async copyPart(from, to, id, n, start, end) {
      const size = sizes.get(from);
      if (size === undefined || start < 0 || end > size) throw new Error("copy range");
      box.maxCopy = Math.max(box.maxCopy, end - start);
      const parts = ups.get(id);
      if (!parts) throw new Error("missing upload");
      parts.push({ n, len: end - start });
      const mark = magic.get(from);
      if (n === 1 && mark) magic.set(to, mark);
      return `"${n}"`;
    },
    async completeMultipart(key, id) {
      const parts = ups.get(id);
      if (!parts?.length) throw new Error("missing parts");
      const total = parts.reduce((sum, part) => sum + part.len, 0);
      sizes.set(key, total);
      const mark = magic.get(key);
      objs.set(key, mark ? mark.slice() : new Uint8Array());
      ups.delete(id);
    },
    async abortMultipart(_key, id) {
      ups.delete(id);
    },
  };
  return { store, sizes, magic, get maxPut() { return box.maxPut; }, get maxPart() { return box.maxPart; }, get maxCopy() { return box.maxCopy; } };
}

function env(): Env {
  return { POW_SECRET: "test-secret", POW_BITS: "8" } as Env;
}

function api(seen: Env, store: Store, path: string, init: RequestInit) {
  return handle(new Request("https://scratchpad-repo.ftuna.eu" + path, init), seen, store);
}

async function register(seen: Env, store: Store) {
  const challenge = await api(seen, store, "/v1/challenge", { method: "POST" });
  const ch = JSON.parse(await challenge.text()) as { challenge: string; bits: number };
  let solution = "";
  for (let i = 0; ; i++) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ch.challenge + i)));
    if (zeroBits(hash) >= ch.bits) {
      solution = String(i);
      break;
    }
  }
  const registered = await api(seen, store, "/v1/register", {
    method: "POST",
    body: JSON.stringify({ challenge: ch.challenge, solution }),
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  return JSON.parse(await registered.text()) as { token: string; account: string };
}

async function upload(seen: Env, store: Store, token: string, id: string, archive: Uint8Array) {
  const created = await api(seen, store, "/v1/repos", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-length": String(archive.byteLength),
      "x-ftuna-id": id,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const loc = new URL(created.headers.get("location")!).pathname;
  return api(seen, store, loc, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: archive,
  });
}

function memory(): { store: Store; maxPart: number; maxRange: number } {
  const objs = new Map<string, Uint8Array>();
  const ups = new Map<string, Map<number, Uint8Array>>();
  const box = { maxPart: 0, maxRange: 0, store: null as unknown as Store };
  let seq = 0;
  box.store = {
    async get(key) {
      return objs.get(key) ?? null;
    },
    async put(key, body) {
      objs.set(key, body.slice());
    },
    async copy(from, to) {
      const body = objs.get(from);
      if (!body) throw new Error("missing " + from);
      objs.set(to, body.slice());
    },
    async del(key) {
      objs.delete(key);
    },
    async list(prefix) {
      const level = children([...objs.keys()], prefix);
      return {
        dirs: level.dirs,
        files: level.keys.map((key) => ({ key, size: objs.get(key)?.byteLength ?? 0 })),
      };
    },
    async keys(prefix) {
      return [...objs.keys()].filter((key) => key.startsWith(prefix));
    },
    async range(key, start, end) {
      box.maxRange = Math.max(box.maxRange, end - start);
      const body = objs.get(key);
      if (!body) throw new Error("missing " + key);
      return body.slice(start, end);
    },
    async exists(key) {
      return objs.has(key);
    },
    async startMultipart() {
      const id = String(++seq);
      ups.set(id, new Map());
      return id;
    },
    async putPart(_key, id, n, body) {
      box.maxPart = Math.max(box.maxPart, body.byteLength);
      ups.get(id)!.set(n, body.slice());
      return `"${n}"`;
    },
    async copyPart(from, _to, id, n, start, end) {
      const body = objs.get(from);
      if (!body) throw new Error("missing " + from);
      const slice = body.slice(start, end);
      box.maxPart = Math.max(box.maxPart, slice.byteLength);
      ups.get(id)!.set(n, slice);
      return `"${n}"`;
    },
    async completeMultipart(key, id) {
      const parts = [...ups.get(id)!.entries()].sort((a, b) => a[0] - b[0]);
      const total = parts.reduce((n, [, part]) => n + part.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const [, part] of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      objs.set(key, out);
      ups.delete(id);
    },
    async abortMultipart(_key, id) {
      ups.delete(id);
    },
  };
  return box;
}

function children(keys: string[], prefix: string): { keys: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(key);
    else dirs.add(prefix + rest.slice(0, slash + 1));
  }
  return { keys: files, dirs: [...dirs] };
}

function cursor(buf: Uint8Array) {
  let pos = 0;
  return {
    async read(n: number) {
      if (pos >= buf.length) return null;
      if (pos + n > buf.length) throw new Error("short");
      const out = buf.slice(pos, pos + n);
      pos += n;
      return out;
    },
  };
}

function ustar(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [headerBlock(files[0].name, files[0].data.length), files[0].data, padding(files[0].data.length)];
  for (const file of files.slice(1)) {
    parts.push(headerBlock(file.name, file.data.length), file.data, padding(file.data.length));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function headerBlock(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(name), 0);
  writeOctal(header, 100, 0o644, 8);
  writeOctal(header, 108, 0, 8);
  writeOctal(header, 116, 0, 8);
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, 0, 12);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar"), 257);
  header.set(new TextEncoder().encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeOctal(header, 148, sum, 8);
  return header;
}

function writeOctal(header: Uint8Array, offset: number, value: number, len: number) {
  const text = value.toString(8).padStart(len - 1, "0");
  for (let i = 0; i < len - 1; i++) header[offset + i] = text.charCodeAt(i);
  header[offset + len - 1] = 0;
}

function padding(size: number): Uint8Array {
  return new Uint8Array((512 - (size % 512)) % 512);
}
