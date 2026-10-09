import { XMLParser } from "fast-xml-parser";

export type Listed = {
  dirs: string[];
  files: { key: string; size: number }[];
  truncated: boolean;
  token: string;
};

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === "Contents" || name === "CommonPrefixes",
  parseTagValue: false,
  trimValues: false,
});

type BucketList = {
  ListBucketResult?: {
    IsTruncated?: string;
    NextContinuationToken?: string;
    Contents?: { Key?: string; Size?: string }[];
    CommonPrefixes?: { Prefix?: string }[];
  };
};

export function parseList(xml: string): Listed {
  let doc: BucketList;
  try {
    doc = parser.parse(xml) as BucketList;
  } catch {
    return { dirs: [], files: [], truncated: false, token: "" };
  }
  const result = doc.ListBucketResult ?? {};
  const dirs = (result.CommonPrefixes ?? []).flatMap((item) => {
    const prefix = decodeKey(item.Prefix ?? "");
    return prefix === "" ? [] : [prefix];
  });
  const files = (result.Contents ?? []).flatMap((item) => {
    const key = decodeKey(item.Key ?? "");
    if (key === "") return [];
    const size = Number(item.Size ?? "0");
    return [{ key, size: Number.isFinite(size) ? size : 0 }];
  });
  return {
    dirs,
    files,
    truncated: result.IsTruncated === "true",
    token: decodeKey(result.NextContinuationToken ?? ""),
  };
}

function decodeKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
