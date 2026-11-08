export type VideoVersion = "original" | "1080p";
export type VideoUpscale = {
  state: "running" | "interrupted" | "failed" | "ready";
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  error?: string;
};
export type AssetEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: AssetEntry[];
  draft?: boolean;
  upscale?: VideoUpscale;
};

export function supportsVideoUpscale(entry: AssetEntry) {
  return entry.type === "file" && !entry.draft && /\.mp4$/i.test(entry.name);
}

export function assetMediaUrl(path: string, version: VideoVersion = "original", download = false) {
  const query = new URLSearchParams({ path });
  if (version === "1080p") query.set("version", version);
  if (download) query.set("download", "true");
  return `/api/assets/read?${query}`;
}

export function assetVersionName(name: string, version: VideoVersion) {
  return version === "1080p" ? name.replace(/\.mp4$/i, " · 1080P.mp4") : name;
}
