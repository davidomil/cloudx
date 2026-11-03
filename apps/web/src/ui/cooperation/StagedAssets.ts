interface StagedAsset { token: string; operationId?: string; saving: boolean; cleanup?: Promise<void> }
interface AssetCleanup {
  receipt: (operationId: string) => Promise<boolean>;
  discard: (token: string, operationId?: string) => Promise<void>;
  failed: (cause: unknown) => void;
}

export class StagedAssets {
  private readonly assets = new Map<string, StagedAsset>();
  private retired = false;

  constructor(private readonly cleanup: AssetCleanup) {}

  activate() { this.retired = false; }

  staged(itemId: string, token: string) {
    if (this.assets.has(itemId)) throw new Error("Discard the previous asset stage before staging another original.");
    const asset: StagedAsset = { token, saving: false };
    this.assets.set(itemId, asset);
    if (this.retired) void this.discard(itemId, asset);
    return !this.retired;
  }

  saving(itemId: string, operationId: string) {
    const asset = this.assets.get(itemId);
    if (!asset || this.retired) throw new Error("This asset view closed before its attachment started.");
    asset.saving = true;
    asset.operationId = operationId;
  }

  async settled(itemId: string, committed: boolean) {
    const asset = this.assets.get(itemId);
    if (!asset) return;
    if (committed) { this.assets.delete(itemId); return; }
    asset.saving = false;
    if (this.retired) await this.discard(itemId, asset);
  }

  forgotten(itemId: string) { this.assets.delete(itemId); }

  async retire() {
    this.retired = true;
    await Promise.all([...this.assets].filter(([, asset]) => !asset.saving).map(([id, asset]) => this.discard(id, asset)));
  }

  private discard(itemId: string, asset: StagedAsset): Promise<void> {
    asset.cleanup ??= (async () => {
      try {
        if (!asset.operationId || !await this.cleanup.receipt(asset.operationId)) await this.cleanup.discard(asset.token, asset.operationId);
        this.assets.delete(itemId);
      } catch (cause) { this.cleanup.failed(cause); }
    })();
    return asset.cleanup;
  }
}
