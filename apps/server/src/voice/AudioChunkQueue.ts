export class AudioChunkQueue implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = [];
  private waiting: { resolve: (result: IteratorResult<Buffer>) => void; reject: (error: Error) => void } | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(chunk: Buffer): void {
    if (this.ended) {
      return;
    }
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    this.chunks.splice(0);
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = undefined;
      reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: () => {
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        const chunk = this.chunks.shift();
        if (chunk) {
          return Promise.resolve({ value: chunk, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      }
    };
  }
}
