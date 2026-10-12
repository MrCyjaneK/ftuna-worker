import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSize, homePage, homeText, indexHTML, indexText } from "./html.ts";
import worker from "./index.ts";
import { parseList } from "./listxml.ts";
import { contentType, listPrefix, objectKey, prefersHTML, route } from "./site.ts";

test("home page and file root", () => {
  assert.deepEqual(route("ftuna.eu", "/"), { kind: "page" });
  assert.deepEqual(route("FTUNA.EU", "/files"), { kind: "redirect", location: "/files/" });
  assert.deepEqual(route("localhost", "/files/"), {
    kind: "store",
    prefix: "",
    path: "",
    directory: true,
  });
  assert.equal(route("ftuna.eu", "/other").kind, "unknown");
});

test("repo mounts strip to their prefix", () => {
  assert.deepEqual(route("repo-oss.ftuna.eu", "/5.1.0.11/aarch64/"), {
    kind: "store",
    prefix: "repo/ftuna-oss",
    path: "5.1.0.11/aarch64",
    directory: true,
  });
  assert.equal(objectKey("repo/ftuna-oss", "5.1.0.11/aarch64/pkg.rpm"), "repo/ftuna-oss/5.1.0.11/aarch64/pkg.rpm");
  assert.equal(listPrefix("scratch", ""), "scratch/");
  assert.equal(listPrefix("", ""), "");
  assert.deepEqual(route("repo-oss.ftuna.eu", "/status"), { kind: "status" });
  assert.deepEqual(route("repo-oss.ftuna.eu", "/status/"), { kind: "redirect", location: "/status" });
  assert.equal(route("repo-oss.ftuna.eu", "/5.1.0.11/status.json").kind, "store");
  assert.equal(route("ftuna.eu", "/status").kind, "unknown");
  assert.deepEqual(route("repo-openrepos.ftuna.eu", "/status"), {
    kind: "store",
    prefix: "mirror/openrepos",
    path: "status",
    directory: false,
  });
});

test("cdn mirror keeps the origin host in the path", () => {
  assert.deepEqual(route("cdn-mirror.ftuna.eu", "/raw.githubusercontent.com/piggz/harbour-advanced-camera/cdcef3fb/harbour-advanced-camera.svg"), {
    kind: "store",
    prefix: "cdn-mirror",
    path: "raw.githubusercontent.com/piggz/harbour-advanced-camera/cdcef3fb/harbour-advanced-camera.svg",
    directory: false,
  });
  assert.equal(
    objectKey("cdn-mirror", "raw.githubusercontent.com/piggz/harbour-advanced-camera/cdcef3fb/harbour-advanced-camera.svg"),
    "cdn-mirror/raw.githubusercontent.com/piggz/harbour-advanced-camera/cdcef3fb/harbour-advanced-camera.svg",
  );
});

test("rejects parent segments", () => {
  assert.equal(route("repo-openrepos.ftuna.eu", "/../repo/ftuna-oss/").kind, "bad");
  assert.equal(route("scratchpad-repo.ftuna.eu", "/%2e%2e/secret").kind, "bad");
  assert.equal(route("example.com", "/").kind, "unknown");
});

test("html only when accept prefers text/html", () => {
  const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  assert.equal(prefersHTML(browser), true);
  assert.equal(prefersHTML("text/html"), true);
  assert.equal(prefersHTML("text/html, */*"), true);
  assert.equal(prefersHTML("text/html;q=0.9, text/plain;q=0.8"), true);
  assert.equal(prefersHTML("*/*"), false);
  assert.equal(prefersHTML(null), false);
  assert.equal(prefersHTML(""), false);
  assert.equal(prefersHTML("text/plain"), false);
  assert.equal(prefersHTML("text/html;q=0.5, text/plain"), false);
  assert.equal(prefersHTML("text/html;q=0, */*"), false);
  assert.equal(prefersHTML("text/*"), false);
});

test("content type", () => {
  assert.equal(contentType("readme.MD"), "text/plain; charset=utf-8");
  assert.equal(contentType("note.txt"), "text/plain; charset=utf-8");
  assert.equal(contentType("pkg.rpm"), "application/octet-stream");
  assert.equal(contentType("repomd.xml"), "application/octet-stream");
});

test("home page links every host and follows the color scheme", () => {
  for (const host of [
    "https://repo-oss.ftuna.eu/",
    "https://repo-openrepos.ftuna.eu/",
    "https://scratchpad-repo.ftuna.eu/",
    "https://cdn-mirror.ftuna.eu/",
  ]) {
    assert.ok(homePage.includes(`href="${host}"`));
  }
  assert.ok(homePage.includes('href="/files/"'));
  assert.ok(homePage.includes('href="https://repo-oss.ftuna.eu/status"'));
  assert.equal(homePage.includes("<script"), false);
  assert.ok(homePage.includes("prefers-color-scheme: dark"));
  assert.ok(homePage.includes('name="color-scheme" content="light dark"'));
});

test("plain home page names every host", () => {
  for (const host of [
    "https://repo-oss.ftuna.eu/",
    "https://repo-openrepos.ftuna.eu/",
    "https://scratchpad-repo.ftuna.eu/",
    "https://cdn-mirror.ftuna.eu/",
    "https://ftuna.eu/files/",
    "https://repo-oss.ftuna.eu/status",
  ]) {
    assert.ok(homeText.includes(host));
  }
  assert.equal(homeText.includes("<"), false);
  assert.ok(homeText.endsWith("\n"));
});

test("home page follows accept", async () => {
  const html = await worker.fetch(new Request("https://ftuna.eu/", { headers: { accept: "text/html" } }), {} as Env);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("vary"), "accept");
  assert.match(await html.text(), /<!DOCTYPE html>/);

  for (const accept of [null, "*/*", "text/plain"] as const) {
    const headers = accept == null ? undefined : { accept };
    const plain = await worker.fetch(new Request("https://ftuna.eu/", { headers }), {} as Env);
    assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
    const body = await plain.text();
    assert.equal(body.includes("<"), false);
    assert.ok(body.includes("https://repo-oss.ftuna.eu/"));
  }

  const head = await worker.fetch(new Request("https://ftuna.eu/", { method: "HEAD" }), {} as Env);
  assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await head.text(), "");

  const headHTML = await worker.fetch(
    new Request("https://ftuna.eu/", { method: "HEAD", headers: { accept: "text/html" } }),
    {} as Env,
  );
  assert.equal(headHTML.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await headHTML.text(), "");
});

test("index follows the color scheme and escapes names", () => {
  const html = indexHTML(
    { kind: "store", prefix: "repo/ftuna-oss", path: "5.1", directory: true },
    ["repo/ftuna-oss/5.1/<dir>/"],
    [{ key: "repo/ftuna-oss/5.1/a<b>.rpm", size: 1536 }],
  );
  assert.ok(html.includes("Index of /5.1/"));
  assert.ok(html.includes('href="../"'));
  assert.ok(html.includes('href="%3Cdir%3E/"'));
  assert.ok(html.includes('href="a%3Cb%3E.rpm"'));
  assert.ok(html.includes("&lt;dir&gt;/"));
  assert.ok(html.includes("a&lt;b&gt;.rpm"));
  assert.ok(html.includes("1.5 KB"));
  assert.equal(html.includes('href="/status"'), false);
  const root = indexHTML({ kind: "store", prefix: "repo/ftuna-oss", path: "", directory: true }, [], []);
  assert.ok(root.includes('href="/status">Packaging</a>'));
  const other = indexHTML({ kind: "store", prefix: "mirror/openrepos", path: "", directory: true }, [], []);
  assert.equal(other.includes('href="/status"'), false);
  assert.ok(html.indexOf("&lt;dir&gt;/") < html.indexOf("a&lt;b&gt;.rpm"));
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes("prefers-color-scheme: dark"));
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(1048576), "1 MB");

  const text = indexText(
    { kind: "store", prefix: "repo/ftuna-oss", path: "5.1", directory: true },
    ["repo/ftuna-oss/5.1/<dir>/"],
    [{ key: "repo/ftuna-oss/5.1/a<b>.rpm", size: 1536 }],
  );
  assert.ok(text.startsWith("Index of /5.1/\n"));
  assert.ok(text.includes("../\n"));
  assert.ok(text.includes("<dir>/\n"));
  assert.ok(text.includes("a<b>.rpm  1.5 KB\n"));
  assert.ok(text.indexOf("<dir>/") < text.indexOf("a<b>.rpm"));
  assert.equal(text.includes("&lt;"), false);
});

test("list xml", () => {
  const xml = `<?xml version="1.0"?>
<ListBucketResult>
  <Prefix>repo/ftuna-oss/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>repo/ftuna-oss/readme.md</Key><Size>12</Size></Contents>
  <Contents><Key>repo/ftuna-oss/a%3Cb%3E.rpm</Key><Size>4</Size></Contents>
  <Contents><Key>repo/ftuna-oss/a&amp;b.rpm</Key><Size>5</Size></Contents>
  <CommonPrefixes><Prefix>repo/ftuna-oss/5.1.0.11/</Prefix></CommonPrefixes>
</ListBucketResult>`;
  const got = parseList(xml);
  assert.deepEqual(got.dirs, ["repo/ftuna-oss/5.1.0.11/"]);
  assert.deepEqual(got.files, [
    { key: "repo/ftuna-oss/readme.md", size: 12 },
    { key: "repo/ftuna-oss/a<b>.rpm", size: 4 },
    { key: "repo/ftuna-oss/a&b.rpm", size: 5 },
  ]);
  assert.equal(got.truncated, false);
});
