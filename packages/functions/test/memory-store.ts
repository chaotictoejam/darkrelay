import type { ListedObject, Store, WriteOptions } from '../src/lib/store';

interface Obj {
  body: Uint8Array;
  opts: WriteOptions;
}

export class MemoryStore implements Store {
  readonly objects = new Map<string, Obj>();

  seed(key: string, body: string | Uint8Array, opts: WriteOptions = {}) {
    this.objects.set(key, { body: toBytes(body), opts });
  }
  text(key: string) {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.body) : undefined;
  }
  json(key: string) {
    const t = this.text(key);
    return t === undefined ? undefined : JSON.parse(t);
  }

  async getText(key: string) {
    return this.text(key);
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, metadata: o.opts.metadata ?? {} } : undefined;
  }
  async put(key: string, body: string | Uint8Array, opts: WriteOptions = {}) {
    this.seed(key, body, opts);
  }
  async copy(from: string, to: string, opts: WriteOptions = {}) {
    const o = this.objects.get(from);
    if (!o) throw new Error(`NoSuchKey ${from}`);
    this.objects.set(to, { body: o.body, opts });
  }
  async list(prefix: string): Promise<ListedObject[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, o]) => ({ key, size: o.body.length }));
  }
  async createIfAbsent(key: string, body: string, opts: WriteOptions = {}) {
    if (this.objects.has(key)) return false;
    this.seed(key, body, opts);
    return true;
  }
  async getRange(key: string, start: number, end: number) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey ${key}`);
    return o.body.slice(start, end + 1);
  }
  async delete(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
  }
}

function toBytes(body: string | Uint8Array) {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}
