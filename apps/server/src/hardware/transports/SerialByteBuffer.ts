export class SerialByteBuffer {
  private readonly bytes: Buffer;
  private start = 0;
  private length = 0;
  private overflowed = false;

  constructor(capacity: number) { this.bytes = Buffer.alloc(capacity); }

  get size(): number { return this.length; }

  append(data: Buffer): void {
    const count = Math.min(data.length, this.bytes.length - this.length);
    this.overflowed ||= count < data.length;
    const end = (this.start + this.length) % this.bytes.length;
    const first = Math.min(count, this.bytes.length - end);
    data.copy(this.bytes, end, 0, first);
    data.copy(this.bytes, 0, first, count);
    this.length += count;
  }

  read(maxBytes: number): { data: Buffer; truncated: boolean } {
    const count = Math.min(maxBytes, this.length);
    const data = Buffer.allocUnsafe(count);
    const first = Math.min(count, this.bytes.length - this.start);
    this.bytes.copy(data, 0, this.start, this.start + first);
    this.bytes.copy(data, first, 0, count - first);
    this.start = (this.start + count) % this.bytes.length;
    this.length -= count;
    const truncated = this.overflowed || this.length > 0;
    this.overflowed = false;
    return { data, truncated };
  }

  clear(): void { this.bytes.fill(0); this.start = 0; this.length = 0; this.overflowed = false; }
}
