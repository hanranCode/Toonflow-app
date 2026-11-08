import axios from "axios";
import useWorkspaceFiles, { type TextSnapshot } from "@/lib/workspaceFiles";
import type { Clip, CutFrame } from "./media";

export type Shot = {
  id: string;
  name: string;
  prompt: string;
  seconds: number;
  clip?: Clip;
  reference?: CutFrame & { source: string };
  taskId?: string;
};
export type Sequence = { version: 1; target: number; brief: string; shots: Shot[]; preview?: Clip };

const manifest = "assets/filmstrip.json";
export const mediaFolder = "assets/filmstrip";
const missing = (error: unknown) => axios.isAxiosError(error) && error.response?.status === 404;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => value === 0 || positive(value);
const safePath = (value: unknown): value is string => typeof value === "string" && value.startsWith("assets/") && !/[:\\\x00-\x1f]/.test(value)
  && !value.split("/").some(part => !part || part === "." || part === "..");

function isClip(value: unknown): value is Clip {
  if (!isObject(value) || !safePath(value.path) || !positive(value.duration)) return false;
  const start = value.in ?? 0;
  const end = value.out ?? value.duration;
  return nonnegative(start) && positive(end) && start < end && end <= value.duration + 0.000001;
}

function isShot(value: unknown): value is Shot {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.prompt !== "string" || !positive(value.seconds)) return false;
  const { reference, clip, taskId } = value;
  return (clip === undefined || isClip(clip)) && (taskId === undefined || typeof taskId === "string")
    && (reference === undefined || (isObject(reference) && safePath(reference.path) && typeof reference.source === "string"
      && nonnegative(reference.time) && positive(reference.end) && reference.end > reference.time));
}

function readSequence(text: string): Sequence {
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || data.version !== 1 || !positive(data.target) || typeof data.brief !== "string"
    || !Array.isArray(data.shots) || data.shots.length > 40 || !data.shots.every(isShot)
    || new Set(data.shots.map(shot => shot.id)).size !== data.shots.length || (data.preview !== undefined && !isClip(data.preview))) {
    throw new Error("胶片项目文件格式无效");
  }
  return { version: 1, target: data.target, brief: data.brief, shots: data.shots, preview: data.preview };
}

export function useSequence(directory: string) {
  const files = useWorkspaceFiles(directory);
  let revision: TextSnapshot | undefined;

  async function load() {
    try {
      const snapshot = await files.readTextSnapshot(manifest, { maxBytes: 500000 });
      const data = readSequence(snapshot.text);
      revision = snapshot;
      return data;
    } catch (error) {
      if (!missing(error)) throw error;
      revision = undefined;
      return { version: 1, target: 30, brief: "", shots: [] } satisfies Sequence;
    }
  }

  async function ensureFolder(path: string) {
    try {
      await files.mkdir(path);
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 409) throw error;
      await files.list(path);
    }
  }

  async function folder() {
    await ensureFolder("assets");
    await ensureFolder(mediaFolder);
    const path = `${mediaFolder}/${crypto.randomUUID()}`;
    await files.mkdir(path);
    return path;
  }

  async function save(data: Sequence) {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    try {
      if (revision) {
        const result = await files.writeTextSnapshot(manifest, text, revision);
        revision = { revision: result, encoding: revision.encoding, text };
      } else {
        await ensureFolder("assets");
        await files.write(manifest, text, true);
        const snapshot = await files.readTextSnapshot(manifest, { maxBytes: 500000 });
        if (snapshot.text !== text) throw new Error("另一窗口已修改胶片，请重新载入");
        revision = snapshot;
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) throw new Error("另一窗口已修改胶片，请重新载入");
      throw error;
    }
  }

  async function videos() {
    const found: string[] = [];
    const pending = ["assets"];
    for (let i = 0; i < pending.length && i < 200; i++) {
      const entries = await files.list(pending[i]!).then(result => result.entries, error => {
        if (missing(error)) return [];
        throw error;
      });
      for (const item of entries) {
        if (item.path === mediaFolder) continue;
        if (item.type === "directory") pending.push(item.path);
        else if (/\.(mp4|webm|mov|m4v)$/i.test(item.name)) found.push(item.path);
      }
    }
    return found;
  }

  return { files, load, save, folder, videos };
}

export function clipLength(clip: Clip) {
  return (clip.out ?? clip.duration) - (clip.in ?? 0);
}

export function newShot(name: string, prompt = "", seconds = 5): Shot {
  return { id: crypto.randomUUID(), name, prompt, seconds };
}
