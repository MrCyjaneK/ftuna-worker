export type StoreRequest = {
  kind: "store";
  prefix: string;
  path: string;
  directory: boolean;
};

export type Route =
  | { kind: "page" }
  | { kind: "docs" }
  | { kind: "status" }
  | { kind: "redirect"; location: string }
  | StoreRequest
  | { kind: "unknown" }
  | { kind: "bad" };

const mounts: Record<string, string | "home"> = {
  "ftuna.eu": "home",
  localhost: "home",
  "127.0.0.1": "home",
  "repo-oss.ftuna.eu": "repo/ftuna-oss",
  "repo-openrepos.ftuna.eu": "mirror/openrepos",
  "scratchpad-repo.ftuna.eu": "scratch",
  "cdn-mirror.ftuna.eu": "cdn-mirror",
};

export function route(hostname: string, pathname: string): Route {
  const host = hostname.toLowerCase();
  const mount = mounts[host];
  if (mount === undefined) return { kind: "unknown" };
  if (mount === "home") {
    if (pathname === "/" || pathname === "") return { kind: "page" };
    if (pathname === "/files") return { kind: "redirect", location: "/files/" };
    if (pathname.startsWith("/files/")) {
      const parsed = parsePath(pathname.slice("/files".length));
      if (!parsed) return { kind: "bad" };
      return { kind: "store", prefix: "", path: parsed.path, directory: parsed.directory };
    }
    return { kind: "unknown" };
  }
  if (host === "scratchpad-repo.ftuna.eu" && (pathname === "/" || pathname === "")) return { kind: "docs" };
  if (host === "repo-oss.ftuna.eu" && pathname === "/status") return { kind: "status" };
  if (host === "repo-oss.ftuna.eu" && pathname === "/status/") return { kind: "redirect", location: "/status" };
  const parsed = parsePath(pathname);
  if (!parsed) return { kind: "bad" };
  return { kind: "store", prefix: mount, path: parsed.path, directory: parsed.directory };
}

export function parsePath(pathname: string): { path: string; directory: boolean } | null {
  const directory = pathname.endsWith("/") || pathname === "";
  const parts: string[] = [];
  for (const seg of pathname.split("/")) {
    if (seg === "") continue;
    let dec: string;
    try {
      dec = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (dec === "" || dec === "." || dec === ".." || dec.includes("/") || dec.includes("\\") || dec.includes("\0")) {
      return null;
    }
    parts.push(dec);
  }
  return { path: parts.join("/"), directory };
}

export function objectKey(prefix: string, path: string): string {
  if (prefix && path) return prefix + "/" + path;
  return prefix || path;
}

export function listPrefix(prefix: string, path: string): string {
  const key = objectKey(prefix, path);
  return key === "" ? "" : key + "/";
}

export function contentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

type MediaRange = { type: string; subtype: string; q: number };

// HTML only when text/html is acceptable and beats text/plain. Equal quality
// goes to text, so curl and wget (`Accept: */*`) and a missing Accept stay plain.
export function prefersHTML(accept: string | null): boolean {
  if (!accept || accept.trim() === "") return false;
  const ranges = parseAccept(accept);
  const html = matchQuality(ranges, "text", "html");
  const plain = matchQuality(ranges, "text", "plain");
  if (html.q === 0) return false;
  if (html.q !== plain.q) return html.q > plain.q;
  return html.spec > plain.spec;
}

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(",")) {
    const bits = part
      .split(";")
      .map((bit) => bit.trim())
      .filter((bit) => bit !== "");
    const name = bits[0]?.toLowerCase() ?? "";
    const slash = name.indexOf("/");
    if (slash <= 0 || slash !== name.lastIndexOf("/")) continue;
    const type = name.slice(0, slash);
    const subtype = name.slice(slash + 1);
    if (type === "*" && subtype !== "*") continue;
    if (subtype === "") continue;
    let q = 1;
    let bad = false;
    for (const param of bits.slice(1)) {
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      if (param.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const value = param.slice(eq + 1).trim();
      if (!/^0(\.\d{0,3})?$|^1(\.0{0,3})?$/.test(value)) {
        bad = true;
        break;
      }
      q = Number(value);
    }
    if (!bad) ranges.push({ type, subtype, q });
  }
  return ranges;
}

function matchQuality(ranges: MediaRange[], type: string, subtype: string): { q: number; spec: number } {
  let best = { q: 0, spec: 0 };
  for (const range of ranges) {
    let spec = 0;
    if (range.type === type && range.subtype === subtype) spec = 3;
    else if (range.type === type && range.subtype === "*") spec = 2;
    else if (range.type === "*" && range.subtype === "*") spec = 1;
    else continue;
    if (spec > best.spec || (spec === best.spec && range.q > best.q)) best = { q: range.q, spec };
  }
  return best;
}
