/** Retains a UTF-8 tail without copying prior output on every incoming chunk. */
export class TerminalReplayBuffer {
  private buffer = Buffer.alloc(0);
  private start = 0;
  private bytes = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Terminal replay must be a positive safe integer number of bytes.");
    }
  }

  append(data: string): void {
    if (!data) return;
    const chunk = Buffer.from(data).subarray(-this.capacity);
    this.reserve(Math.min(this.capacity, this.bytes + chunk.length));
    const discard = Math.max(0, this.bytes + chunk.length - this.buffer.length);
    this.start = (this.start + discard) % this.buffer.length;
    this.bytes -= discard;
    const end = (this.start + this.bytes) % this.buffer.length;
    const written = chunk.copy(this.buffer, end);
    chunk.copy(this.buffer, 0, written);
    this.bytes += chunk.length;
  }

  snapshot(): string {
    const output = Buffer.allocUnsafe(this.bytes);
    this.copyTo(output);
    let start = 0;
    while ((output[start]! & 0xc0) === 0x80) start++;
    return output.toString("utf8", start);
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.start = 0;
    this.bytes = 0;
  }

  private reserve(bytes: number): void {
    if (bytes <= this.buffer.length) return;
    const size = Math.min(this.capacity, Math.max(4096, this.buffer.length * 2, bytes));
    const buffer = Buffer.allocUnsafe(size);
    this.copyTo(buffer);
    this.buffer = buffer;
    this.start = 0;
  }

  private copyTo(target: Buffer): void {
    const first = Math.min(this.bytes, this.buffer.length - this.start);
    this.buffer.copy(target, 0, this.start, this.start + first);
    this.buffer.copy(target, first, 0, this.bytes - first);
  }
}
