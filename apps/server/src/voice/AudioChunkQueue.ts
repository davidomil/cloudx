export class AudioChunkQueue implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = [];
  private waiting: ((result: IteratorResult<Buffer>) => void) | undefined;
  private ended = false;

  push(chunk: Buffer): void {
    if (this.ended) {
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: () => {
        const chunk = this.chunks.shift();
        if (chunk) {
          return Promise.resolve({ value: chunk, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<Buffer>>((resolve) => {
          this.waiting = resolve;
        });
      }
    };
  }
}
