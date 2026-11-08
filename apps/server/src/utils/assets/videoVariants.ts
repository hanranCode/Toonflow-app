import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { constants, copyFile, createReadStream, lstat, mkdir, readFile, readdir, writeAtomic, type Stats } from "@toonflow/file";
import { z } from "zod";
import type { AuthIdentity } from "@toonflow/multi-tenant-auth";
import { resolveAssetPath } from "@/utils/assets";
import { readPriceReference } from "@/utils/media/priceReference";
import { start, status } from "@/utils/media/tasks";
import { getMediaProvider } from "@/utils/media/provider";
import { isEnabled as multiTenantEnabled } from "@/utils/multiTenant/mode";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";

const directoryName = "assetVideoVariants";
const providerId = "aiNodesPlatform";
const modelId = "video-1080p-base";
const mimeType = "video/mp4";
const maxBytes = 100 * 1024 * 1024;
const recordNamePattern = /^(\d+)-[a-f0-9]{64}\.json$/;
const dimension = z.number().int().positive();
const recordSchema = z.strictObject({
  version: z.literal(1),
  taskId: z.uuid(),
  registered: z.boolean(),
  state: z.enum(["running", "interrupted", "failed", "ready"]),
  originalWidth: dimension,
  originalHeight: dimension,
  width: dimension.optional(),
  height: dimension.optional(),
  error: z.string().optional(),
}).refine(record => record.state !== "ready" || isFullHd(record.width, record.height));

type VariantRecord = z.infer<typeof recordSchema>;
type Source = { cwd: string; key: string; recordPath: string; path: string };
type TaskSnapshot = Awaited<ReturnType<typeof status>>[number];
const fingerprints = new Map<string, { stamp: string; key: Promise<string> }>();

function failure(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isFullHd(width?: number, height?: number) {
  return width === 1920 && height === 1080 || width === 1080 && height === 1920;
}

function stamp(info: Stats) {
  return [info.dev, info.ino, info.size, info.birthtimeMs, info.mtimeMs, info.ctimeMs].join(":");
}

function contentKey(path: string, info: Stats) {
  const currentStamp = stamp(info);
  const cached = fingerprints.get(path);
  if (cached?.stamp === currentStamp) return cached.key;
  // ACT: 地址按文件内容确定。素材改名实际会复制再移除原路径，inode 不能作为持久身份。
  const key = (async () => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (stamp(await lstat(path)) !== currentStamp) throw failure("素材已变化，请重新打开后操作", 409);
    return `${info.size}-${hash.digest("hex")}`;
  })();
  if (fingerprints.size >= 256) fingerprints.delete(fingerprints.keys().next().value!);
  fingerprints.set(path, { stamp: currentStamp, key });
  void key.catch(() => { if (fingerprints.get(path)?.key === key) fingerprints.delete(path); });
  return key;
}

function canUpscale(path: string, info: Stats) {
  return info.isFile() && extname(path).toLowerCase() === ".mp4" && info.size > 0 && info.size <= maxBytes;
}

function requireSingleUser() {
  if (multiTenantEnabled()) throw failure("素材超分仅在独立模式下可用", 403);
}

function publicVariant(record: VariantRecord | undefined) {
  if (!record) return undefined;
  const { state, originalWidth, originalHeight, width, height, error } = record;
  return { state, originalWidth, originalHeight, width, height, error };
}

async function readRecord(cwd: string, recordPath: string) {
  const info = await lstat(recordPath).catch(error => { if (!isMissing(error)) throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.size > 8192) throw failure("素材超分记录无效", 409);
  const path = (await resolveWorkspacePath(cwd, join(directoryName, basename(recordPath)))).path;
  if (path !== recordPath) throw failure("素材超分记录路径无效", 403);
  return recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function resolveSource(path: string) {
  const asset = await resolveAssetPath(path);
  if (basename(asset.directory) !== "assets") throw failure("素材目录布局不支持超分", 403);
  return { cwd: dirname(asset.directory), path: asset.path };
}

async function identify(source: { cwd: string; path: string }, info: Stats): Promise<Source> {
  const key = await contentKey(source.path, info);
  return { ...source, key, recordPath: join(source.cwd, directoryName, `${key}.json`) };
}

async function locate(path: string) {
  const source = await resolveSource(path);
  const info = await lstat(source.path);
  if (!canUpscale(source.path, info)) return undefined;
  return identify(source, info);
}

export async function listVariantSizes(assetRoot: string) {
  if (multiTenantEnabled() || basename(assetRoot) !== "assets") return new Set<number>();
  const root = join(dirname(assetRoot), directoryName);
  const info = await lstat(root).catch(error => { if (!isMissing(error)) throw error; });
  if (!info?.isDirectory()) return new Set<number>();
  const names = await readdir(root);
  return new Set(names.flatMap(name => {
    const match = recordNamePattern.exec(name);
    return match ? [Number(match[1])] : [];
  }));
}

export async function listVariant(assetRoot: string, path: string, sizes: Set<number>) {
  if (!sizes.size || extname(path).toLowerCase() !== ".mp4") return undefined;
  try {
    const info = await lstat(path);
    if (!sizes.has(info.size) || !canUpscale(path, info)) return undefined;
    const source = await identify({ cwd: dirname(assetRoot), path }, info);
    return publicVariant(await readRecord(source.cwd, source.recordPath));
  } catch (error) {
    if (isMissing(error) || (error as { status?: number } | null)?.status === 409) return undefined;
    throw error;
  }
}

function taskDirectory(source: Source, taskId: string) {
  return `${directoryName}/${source.key}/${taskId}`;
}

function outputPath(source: Source, record: VariantRecord) {
  return `${taskDirectory(source, record.taskId)}/output/video${record.taskId.replaceAll("-", "")}0.mp4`;
}

async function saveRecord(source: Source, record: VariantRecord) {
  const relative = `${directoryName}/${source.key}.json`;
  const path = (await resolveWorkspacePath(source.cwd, relative)).path;
  if (path !== source.recordPath) throw failure("素材超分记录路径无效", 403);
  await writeAtomic(path, JSON.stringify(recordSchema.parse(record)), { mode: 0o600 });
  return record;
}

async function ensureDirectory(cwd: string, path: string) {
  const directory = (await resolveWorkspacePath(cwd, path, true)).path;
  if (directory !== join(cwd, path)) throw failure("素材超分目录无效", 403);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function stage(source: Source) {
  const provider = await getMediaProvider(providerId);
  if (!provider.models.some(model => model.type === "video" && model.id === modelId)) {
    throw failure("请先安装 AI Nodes Platform 的 1080P 视频超分模型", 424);
  }
  const reference = { path: relative(source.cwd, source.path).split(sep).join("/"), mimeType };
  const original = await readPriceReference(source.cwd, reference, "video");
  const originalWidth = original.width;
  const originalHeight = original.height;
  if (original.mimeType !== mimeType || !originalWidth || !originalHeight) {
    throw failure("无法读取 MP4 视频尺寸，请检查文件与 FFmpeg 配置", 422);
  }
  const portrait = originalHeight > originalWidth;
  if (originalWidth >= (portrait ? 1080 : 1920) || originalHeight >= (portrait ? 1920 : 1080)) {
    throw failure("此视频在 1080P 画布内无需放大", 422);
  }
  const taskId = randomUUID();
  const directory = taskDirectory(source, taskId);
  await ensureDirectory(source.cwd, directory);
  // ACT: 本地任务持有独立输入，素材重命名或移动不会让在途任务失去原文件。
  const input = (await resolveWorkspacePath(source.cwd, `${directory}/input.mp4`)).path;
  await copyFile(source.path, input, constants.COPYFILE_EXCL);
  if (await contentKey(input, await lstat(input)) !== source.key) throw failure("素材已变化，请重新打开后操作", 409);
  return saveRecord(source, { version: 1, taskId, registered: false, state: "running", originalWidth, originalHeight });
}

async function startOriginalTask(source: Source, record: VariantRecord, owner?: AuthIdentity) {
  requireSingleUser();
  const directory = taskDirectory(source, record.taskId);
  const snapshot = await start(source.cwd, record.taskId, "video", {
    providerId, modelId, prompt: "1080P", videos: [{ path: `${directory}/input.mp4`, mimeType }],
    resolution: "1080p", outputDirectory: `${directory}/output`,
  }, {}, owner);
  return reconcile(source, record, snapshot);
}

async function reconcile(source: Source, record: VariantRecord, snapshot: TaskSnapshot) {
  if (snapshot.state === "interrupted" && snapshot.result?.code === 404) {
    if (record.state === "interrupted") return record;
    return saveRecord(source, { ...record, state: "interrupted", error: "未找到原超分任务，请复查原任务" });
  }
  const next = { ...record, registered: true };
  if (snapshot.state === "succeeded") {
    const candidate = snapshot.result?.data?.[0];
    const expected = outputPath(source, record);
    if (snapshot.result?.data?.length !== 1 || candidate?.path !== expected || candidate.mimeType !== mimeType || candidate.mediaType !== "video") {
      return saveRecord(source, { ...next, state: "failed", error: "超分产物无效，原片可继续使用" });
    }
    try {
      const { width, height, mimeType: actualMimeType } = await readPriceReference(source.cwd, candidate, "video");
      if (actualMimeType !== mimeType) return saveRecord(source, { ...next, state: "failed", error: "超分产物不是 MP4，原片可继续使用" });
      if (isFullHd(width, height)) return saveRecord(source, { ...next, state: "ready", width, height, error: undefined });
      if (width && height) return saveRecord(source, { ...next, state: "failed", error: "超分产物尺寸不是 1080P，原片可继续使用" });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return saveRecord(source, { ...next, state: "interrupted", error: "无法验证超分产物，请检查 FFmpeg 后复查原任务" });
  }
  const state = snapshot.state === "cancelled" ? "interrupted" : snapshot.state;
  const error = state === "running" ? undefined : snapshot.result?.message;
  if (record.state === state && record.registered && record.error === error) return record;
  return saveRecord(source, { ...next, state, error });
}

export async function startVideoUpscale(path: string, owner?: AuthIdentity) {
  requireSingleUser();
  const asset = await resolveSource(path);
  const unlockSource = lockWorkspaceFiles([asset.path]);
  try {
    const info = await lstat(asset.path);
    if (!canUpscale(asset.path, info)) throw failure("视频超分仅支持不超过 100 MiB 的 MP4 文件", 415);
    const source = await identify(asset, info);
    const unlock = lockWorkspaceFiles([source.recordPath]);
    try {
      const record = await readRecord(source.cwd, source.recordPath);
      if (record?.state === "ready") return publicVariant(record);
      if (record) {
        requireSingleUser();
        const [snapshot] = await status(source.cwd, [record.taskId], true, owner);
        if (snapshot!.state === "interrupted" && snapshot!.result?.code === 404 && !record.registered) {
          // 媒体任务在上游提交前会落盘，未登记时只补齐同一个本地 ID。
          return publicVariant(await startOriginalTask(source, record, owner));
        }
        if (snapshot!.state !== "failed" || record.state !== "failed") {
          return publicVariant(await reconcile(source, record, snapshot!));
        }
      }
      const next = await stage(source);
      return publicVariant(await startOriginalTask(source, next, owner));
    } finally { unlock(); }
  } finally { unlockSource(); }
}

export async function getVideoUpscaleStatus(path: string, owner?: AuthIdentity) {
  requireSingleUser();
  const source = await locate(path);
  if (!source) return undefined;
  const unlock = lockWorkspaceFiles([source.recordPath]);
  try {
    const record = await readRecord(source.cwd, source.recordPath);
    if (!record || record.state === "ready" || record.state === "failed") return publicVariant(record);
    requireSingleUser();
    const [snapshot] = await status(source.cwd, [record.taskId], false, owner);
    return publicVariant(await reconcile(source, record, snapshot!));
  } finally { unlock(); }
}

export async function readVideoVariant(path: string) {
  requireSingleUser();
  const source = await locate(path);
  const record = source && await readRecord(source.cwd, source.recordPath);
  if (!source || record?.state !== "ready") throw failure("该素材还没有可播放的 1080P 版本", 404);
  const output = (await resolveWorkspacePath(source.cwd, outputPath(source, record), true)).path;
  if (output !== join(source.cwd, outputPath(source, record))) throw failure("超分产物路径无效", 403);
  const info = await lstat(output).catch(error => { if (!isMissing(error)) throw error; });
  if (!info?.isFile() || !info.size || info.size > maxBytes) throw failure("1080P 版本文件不可用", 404);
  return { path: output, name: `${basename(source.path, extname(source.path))}-1080P.mp4` };
}
