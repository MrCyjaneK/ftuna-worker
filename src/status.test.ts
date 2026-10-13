import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.ts";
import { statusPage, statusText } from "./status.ts";

test("status page is a client-side shell", () => {
  assert.match(statusPage, /<!DOCTYPE html>/);
  assert.match(statusPage, /\/status\.json/);
  assert.match(statusPage, /hashchange/);
  assert.match(statusPage, /prefers-color-scheme: dark/);
  assert.match(statusPage, /appendLog\(body, details, recipe\.error\)/);
  assert.equal(statusPage.includes("blame"), false);
  assert.equal(statusPage.includes("abseil"), false);
  assert.equal(statusText.includes("<"), false);
  assert.ok(statusText.includes("https://repo-oss.ftuna.eu/status"));
  assert.ok(statusText.endsWith("\n"));
});

test("status page follows accept", async () => {
  const html = await worker.fetch(
    new Request("https://repo-oss.ftuna.eu/status", { headers: { accept: "text/html" } }),
    {} as Env,
  );
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("vary"), "accept");
  assert.match(await html.text(), /<script>/);

  const plain = await worker.fetch(new Request("https://repo-oss.ftuna.eu/status"), {} as Env);
  assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
  const body = await plain.text();
  assert.equal(body.includes("<"), false);
  assert.ok(body.includes("https://repo-oss.ftuna.eu/status"));

  const head = await worker.fetch(
    new Request("https://repo-oss.ftuna.eu/status", { method: "HEAD", headers: { accept: "text/html" } }),
    {} as Env,
  );
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await head.text(), "");

  const slash = await worker.fetch(new Request("https://repo-oss.ftuna.eu/status/"), {} as Env);
  assert.equal(slash.status, 302);
  assert.equal(slash.headers.get("location"), "https://repo-oss.ftuna.eu/status");
});
