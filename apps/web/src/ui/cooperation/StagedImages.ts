interface StagedImage { token: string; operationId?: string; saving: boolean; cleanup?: Promise<void> }
interface ImageCleanup {
  receipt: (operationId: string) => Promise<boolean>;
  discard: (token: string, operationId?: string) => Promise<void>;
  failed: (cause: unknown) => void;
}

export class StagedImages {
  private readonly images = new Map<string, StagedImage>();
  private retired = false;

  constructor(private readonly cleanup: ImageCleanup) {}

  activate() { this.retired = false; }

  staged(imageId: string, token: string) {
    if (this.images.has(imageId)) throw new Error("Discard the previous image stage before staging another original.");
    const image: StagedImage = { token, saving: false };
    this.images.set(imageId, image);
    if (this.retired) void this.discard(imageId, image);
    return !this.retired;
  }

  saving(imageId: string, operationId: string) {
    const image = this.images.get(imageId);
    if (!image || this.retired) throw new Error("This image view closed before its attachment started.");
    image.saving = true;
    image.operationId = operationId;
  }

  async settled(imageId: string, committed: boolean) {
    const image = this.images.get(imageId);
    if (!image) return;
    if (committed) { this.images.delete(imageId); return; }
    image.saving = false;
    if (this.retired) await this.discard(imageId, image);
  }

  forgotten(imageId: string) { this.images.delete(imageId); }

  async retire() {
    this.retired = true;
    await Promise.all([...this.images].filter(([, image]) => !image.saving).map(([id, image]) => this.discard(id, image)));
  }

  private discard(imageId: string, image: StagedImage): Promise<void> {
    image.cleanup ??= (async () => {
      try {
        if (!image.operationId || !await this.cleanup.receipt(image.operationId)) await this.cleanup.discard(image.token, image.operationId);
        this.images.delete(imageId);
      } catch (cause) { this.cleanup.failed(cause); }
    })();
    return image.cleanup;
  }
}
