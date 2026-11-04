export interface FilesystemCapacity {
  availableBytes: number;
  availableInodes: number;
  blockSize: number;
  quotaStatus: string;
}
export function filesystemCapacity(destination: string): FilesystemCapacity;
