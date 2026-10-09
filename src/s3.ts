import { AwsClient } from "aws4fetch";
import { parseList, type Listed } from "./listxml.ts";
import type { Store } from "./store.ts";

export type Bucket = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function client(bucket: Bucket): AwsClient {
  return new AwsClient({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    service: "s3",
    region: bucket.region,
  });
}

export async function getObject(aws: AwsClient, bucket: Bucket, key: string, request: Request): Promise<Response> {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  return signed(aws, objectURL(bucket, key), request.method === "HEAD" ? "HEAD" : "GET", headers);
}

export async function hasPrefix(aws: AwsClient, bucket: Bucket, prefix: string): Promise<boolean> {
  const url = listURL(bucket, prefix, "", true);
  url.searchParams.set("max-keys", "1");
  const res = await aws.fetch(url.toString(), { redirect: "manual" });
  const xml = await res.text();
  if (!res.ok) throw new Error("list failed");
  const page = parseList(xml);
  return page.dirs.length > 0 || page.files.some((file) => file.key !== prefix);
}

export function listPrefix(aws: AwsClient, bucket: Bucket, prefix: string): Promise<Listed> {
  return collect(aws, bucket, prefix, true);
}

function listURL(bucket: Bucket, prefix: string, token: string, delimiter: boolean): URL {
  const url = bucketURL(bucket);
  url.searchParams.set("list-type", "2");
  if (delimiter) url.searchParams.set("delimiter", "/");
  url.searchParams.set("encoding-type", "url");
  url.searchParams.set("max-keys", "1000");
  if (prefix) url.searchParams.set("prefix", prefix);
  if (token) url.searchParams.set("continuation-token", token);
  return url;
}

export function s3Store(bucket: Bucket): Store {
  const aws = client(bucket);
  return {
    get: (key) => getBytes(aws, bucket, key),
    put: (key, body, contentType) => putBytes(aws, bucket, key, body, contentType),
    copy: (from, to) => copyBytes(aws, bucket, from, to),
    del: (key) => remove(aws, bucket, key),
    list: (prefix) => level(aws, bucket, prefix),
    keys: (prefix) => allKeys(aws, bucket, prefix),
    range: (key, start, end) => rangeBytes(aws, bucket, key, start, end),
    startMultipart: (key) => startUpload(aws, bucket, key),
    putPart: (key, id, n, body) => uploadPart(aws, bucket, key, id, n, body),
    completeMultipart: (key, id, parts) => finishUpload(aws, bucket, key, id, parts),
    abortMultipart: (key, id) => abortUpload(aws, bucket, key, id),
  };
}

// Query-string auth. Header auth breaks on Workers: the runtime rewrites
// Accept-Encoding after the request is signed, and Backblaze then rejects it.
async function signed(aws: AwsClient, url: string, method: string, headers: Headers, body?: Uint8Array): Promise<Response> {
  const signedReq = await aws.sign(url, { method, headers, body, aws: { signQuery: true } });
  const outbound = new Headers(signedReq.headers);
  outbound.set("accept-encoding", "identity");
  return fetch(signedReq.url, { method, headers: outbound, body });
}

async function getBytes(aws: AwsClient, bucket: Bucket, key: string): Promise<Uint8Array | null> {
  const res = await signed(aws, objectURL(bucket, key), "GET", new Headers());
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw new Error("get " + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

async function rangeBytes(aws: AwsClient, bucket: Bucket, key: string, start: number, end: number): Promise<Uint8Array> {
  const headers = new Headers();
  headers.set("range", `bytes=${start}-${end - 1}`);
  const res = await signed(aws, objectURL(bucket, key), "GET", headers);
  if (!res.ok && res.status !== 206) throw new Error("range " + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

async function putBytes(aws: AwsClient, bucket: Bucket, key: string, body: Uint8Array, contentType: string): Promise<void> {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("content-length", String(body.byteLength));
  const res = await signed(aws, objectURL(bucket, key), "PUT", headers, body);
  if (!res.ok) throw new Error("put " + res.status + " " + (await res.text()));
  await res.body?.cancel();
}

async function copyBytes(aws: AwsClient, bucket: Bucket, from: string, to: string): Promise<void> {
  const headers = new Headers();
  headers.set("x-amz-copy-source", `/${bucket.bucket}/${encodeKey(from)}`);
  const res = await signed(aws, objectURL(bucket, to), "PUT", headers);
  if (!res.ok) throw new Error("copy " + res.status + " " + (await res.text()));
  await res.body?.cancel();
}

async function remove(aws: AwsClient, bucket: Bucket, key: string): Promise<void> {
  const res = await signed(aws, objectURL(bucket, key), "DELETE", new Headers());
  if (!res.ok && res.status !== 204) throw new Error("delete " + res.status);
  await res.body?.cancel();
}

async function level(aws: AwsClient, bucket: Bucket, prefix: string): Promise<{ files: { key: string; size: number }[]; dirs: string[] }> {
  const page = await collect(aws, bucket, prefix, true);
  return { files: page.files, dirs: page.dirs };
}

async function allKeys(aws: AwsClient, bucket: Bucket, prefix: string): Promise<string[]> {
  const page = await collect(aws, bucket, prefix, false);
  return page.files.map((file) => file.key);
}

async function collect(aws: AwsClient, bucket: Bucket, prefix: string, delimiter: boolean): Promise<Listed> {
  const dirs: string[] = [];
  const files: { key: string; size: number }[] = [];
  let token = "";
  for (;;) {
    const res = await aws.fetch(listURL(bucket, prefix, token, delimiter).toString(), { redirect: "manual" });
    const xml = await res.text();
    if (!res.ok) throw new Error("list failed");
    const page = parseList(xml);
    dirs.push(...page.dirs);
    for (const file of page.files) {
      if (file.key !== prefix) files.push(file);
    }
    if (!page.truncated || !page.token) break;
    token = page.token;
  }
  return { dirs, files, truncated: false, token: "" };
}

function withQuery(bucket: Bucket, key: string, query: Record<string, string>): string {
  const url = new URL(objectURL(bucket, key));
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.toString();
}

async function startUpload(aws: AwsClient, bucket: Bucket, key: string): Promise<string> {
  const res = await signed(aws, withQuery(bucket, key, { uploads: "" }), "POST", new Headers());
  const xml = await res.text();
  if (!res.ok) throw new Error("start upload " + res.status);
  const id = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!id) throw new Error("upload id missing");
  return id[1];
}

async function uploadPart(aws: AwsClient, bucket: Bucket, key: string, id: string, n: number, body: Uint8Array): Promise<string> {
  const headers = new Headers();
  headers.set("content-length", String(body.byteLength));
  const res = await signed(aws, withQuery(bucket, key, { partNumber: String(n), uploadId: id }), "PUT", headers, body);
  if (!res.ok) throw new Error("part " + res.status);
  await res.body?.cancel();
  const etag = res.headers.get("etag");
  if (!etag) throw new Error("part etag missing");
  return etag;
}

async function finishUpload(aws: AwsClient, bucket: Bucket, key: string, id: string, parts: { n: number; etag: string }[]): Promise<void> {
  const xml =
    "<CompleteMultipartUpload>" +
    parts.map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.etag}</ETag></Part>`).join("") +
    "</CompleteMultipartUpload>";
  const body = new TextEncoder().encode(xml);
  const headers = new Headers();
  headers.set("content-type", "application/xml");
  headers.set("content-length", String(body.byteLength));
  const res = await signed(aws, withQuery(bucket, key, { uploadId: id }), "POST", headers, body);
  if (!res.ok) throw new Error("complete " + res.status + " " + (await res.text()));
  await res.body?.cancel();
}

async function abortUpload(aws: AwsClient, bucket: Bucket, key: string, id: string): Promise<void> {
  const res = await signed(aws, withQuery(bucket, key, { uploadId: id }), "DELETE", new Headers());
  if (!res.ok && res.status !== 204) throw new Error("abort " + res.status);
  await res.body?.cancel();
}

function bucketURL(bucket: Bucket): URL {
  const endpoint = bucket.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return new URL(`https://${endpoint}/${bucket.bucket}`);
}

function objectURL(bucket: Bucket, key: string): string {
  const url = bucketURL(bucket);
  url.pathname = url.pathname.replace(/\/$/, "") + "/" + encodeKey(key);
  return url.toString();
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
