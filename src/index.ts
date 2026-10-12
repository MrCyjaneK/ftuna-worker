import { docsHTML, docsText, homePage, homeText, indexHTML, indexText } from "./html.ts";
import { statusPage, statusText } from "./status.ts";
import { getObject, hasPrefix, listPrefix as listKeys, client, s3Store, type Bucket } from "./s3.ts";
import { handleAPI, runGC, scratchDocs } from "./scratch.ts";
import type { Store } from "./store.ts";
import { contentType, listPrefix, objectKey, prefersHTML, route, type StoreRequest } from "./site.ts";

export async function handle(request: Request, env: Env, store?: Store): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/")) {
    const api = await handleAPI(request, env, store ?? s3Store(bucketOf(env)));
    if (api) return api;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("method not allowed", 405);
  }
  const routed = route(url.hostname, url.pathname);
  if (routed.kind === "docs") return scratchHome(request, env, store);
  if (routed.kind === "page") return page(request, homePage, homeText);
  if (routed.kind === "status") return page(request, statusPage, statusText);
  if (routed.kind === "redirect") {
    return Response.redirect(new URL(routed.location, url).toString(), 302);
  }
  if (routed.kind === "bad") return text("bad path", 400);
  if (routed.kind === "unknown") return text("not found", 404);

  const bucket = bucketOf(env);
  const aws = client(bucket);
  try {
    if (!routed.directory) {
      const upstream = await getObject(aws, bucket, objectKey(routed.prefix, routed.path), request);
      if (upstream.ok || upstream.status === 206) return fileResponse(upstream, routed.path, request.method);
      await upstream.body?.cancel();
      if (upstream.status !== 404) return text("storage error", 502);
      if (await hasPrefix(aws, bucket, listPrefix(routed.prefix, routed.path))) {
        return Response.redirect(new URL(url.pathname + "/", url).toString(), 302);
      }
      return text("not found", 404);
    }
    const listed = await listKeys(aws, bucket, listPrefix(routed.prefix, routed.path));
    return page(request, indexHTML(routed, listed.dirs, listed.files), indexText(routed, listed.dirs, listed.files));
  } catch {
    return text("storage error", 502);
  }
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
  scheduled(_controller, env, ctx) {
    const at = Math.floor(Date.now() / 1000);
    ctx.waitUntil(runGC(s3Store(bucketOf(env)), at).catch((err: unknown) => console.error(err)));
  },
} satisfies ExportedHandler<Env>;

async function scratchHome(request: Request, env: Env, store: Store | undefined): Promise<Response> {
  const req: StoreRequest = { kind: "store", prefix: "scratch", path: "", directory: true };
  const prefix = listPrefix(req.prefix, req.path);
  try {
    const listed = store ? await store.list(prefix) : await listKeys(client(bucketOf(env)), bucketOf(env), prefix);
    return page(request, docsHTML(scratchDocs, req, listed.dirs, listed.files), docsText(scratchDocs, req, listed.dirs, listed.files));
  } catch {
    return text("storage error", 502);
  }
}

function bucketOf(env: Env): Bucket {
  return {
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
}

function fileResponse(upstream: Response, path: string, method: string): Response {
  const headers = new Headers();
  headers.set("content-type", contentType(path));
  headers.set("accept-ranges", "bytes");
  for (const name of ["content-length", "content-range", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}

function page(request: Request, html: string, plain: string): Response {
  const useHTML = prefersHTML(request.headers.get("accept"));
  return new Response(request.method === "HEAD" ? null : useHTML ? html : plain, {
    headers: {
      "content-type": `${useHTML ? "text/html" : "text/plain"}; charset=utf-8`,
      vary: "accept",
    },
  });
}

function text(body: string, status: number): Response {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
