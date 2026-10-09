export type Store = {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<{ files: { key: string; size: number }[]; dirs: string[] }>;
  keys(prefix: string): Promise<string[]>;
  range(key: string, start: number, end: number): Promise<Uint8Array>;
  startMultipart(key: string): Promise<string>;
  putPart(key: string, id: string, n: number, body: Uint8Array): Promise<string>;
  completeMultipart(key: string, id: string, parts: { n: number; etag: string }[]): Promise<void>;
  abortMultipart(key: string, id: string): Promise<void>;
};
