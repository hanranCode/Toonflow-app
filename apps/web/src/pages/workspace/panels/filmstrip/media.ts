import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@toonflow/nodes-scaffold/nodeFfmpeg";

export type CutFrame = { path: string; time: number; end: number };
export type Clip = { path: string; duration: number; in?: number; out?: number };

export function probe(ffmpeg: BrowserFfmpegFactory, path: string) {
  return new Promise<FfprobeData>((resolve, reject) => {
    ffmpeg(path).ffprobe((error, result) => error ? reject(error) : resolve(result));
  });
}

function picture(info: FfprobeData) {
  const video = info.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const duration = Number(video?.duration || info.format.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频规格");
  return { video, duration };
}

export async function readClip(ffmpeg: BrowserFfmpegFactory, path: string): Promise<Clip> {
  const { duration } = picture(await probe(ffmpeg, path));
  return { path, duration };
}

function run(command: BrowserFfmpegCommand) {
  return new Promise<void>((resolve, reject) => {
    command.on("end", () => resolve()).on("error", reject).run();
  });
}

export async function readTail(ffmpeg: BrowserFfmpegFactory, clip: Clip, folder: string): Promise<CutFrame[]> {
  const { video, duration } = picture(await probe(ffmpeg, clip.path));
  const end = clip.out ?? duration;
  const start = clip.in ?? 0;
  // Decode the bounded clip and keep only the final ten timestamps. This also handles VFR and files without nb_frames.
  const keep: number[] = [];
  let eligible = 0;
  let timeBase = 0;
  const range = `trim=start=${start}:end=${end}`;
  const input = () => ffmpeg(clip.path, { timeout: 120 }).noAudio().outputOptions("-map", `0:${video.index}`);
  await run(input().videoFilters([range, "showinfo"]).format("null").output(`${folder}/discard`)
    .on("stderr", line => {
      const base = line.match(/config in time_base:\s*(\d+)\/(\d+)/);
      if (base) timeBase = Number(base[1]) / Number(base[2]);
      const match = line.match(/\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:\s*([\d.e+-]+)/);
      if (!match) return;
      const time = timeBase ? Number(match[1]) * timeBase : Number(match[2]);
      eligible++;
      keep.push(time);
      if (keep.length > 10) keep.shift();
    }));
  if (!keep.length) throw new Error("选定区间内没有可用的视频帧");
  await run(input().videoFilters([range, `select=gte(n\\,${eligible - keep.length})`])
    .outputOptions("-fps_mode", "passthrough", "-start_number", "1", "-frames:v", String(keep.length))
    .output(`${folder}/frame%02d.png`));
  return keep.map((time, index) => ({
    path: `${folder}/frame${String(index + 1).padStart(2, "0")}.png`,
    time,
    end: keep[index + 1] ?? end,
  }));
}

export async function assemble(ffmpeg: BrowserFfmpegFactory, clips: Clip[], output: string) {
  const metadata = await Promise.all(clips.map(clip => probe(ffmpeg, clip.path)));
  const first = picture(metadata[0]!).video;
  const width = Math.ceil(first.width! / 2) * 2;
  const height = Math.ceil(first.height! / 2) * 2;
  const graph: string[] = [];
  const pads: string[] = [];
  const command = ffmpeg({ timeout: 300 });
  clips.forEach((clip, index) => {
    command.input(clip.path);
    const info = metadata[index]!;
    const { video } = picture(info);
    const start = clip.in ?? 0;
    const end = clip.out ?? clip.duration;
    const length = end - start;
    const videoLabel = `v${index}`;
    const audioLabel = `a${index}`;
    const audio = info.streams.find(stream => stream.codec_type === "audio");
    const sound = audio
      ? `[${index}:${audio.index}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${length}`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${length}`;
    graph.push(
      `[${index}:${video.index}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[${videoLabel}]`,
      `${sound}[${audioLabel}]`,
    );
    pads.push(`[${videoLabel}][${audioLabel}]`);
  });
  graph.push(`${pads.join("")}concat=n=${clips.length}:v=1:a=1[video][audio]`);
  await run(command.complexFilter(graph, ["video", "audio"]).videoCodec("libx264").audioCodec("aac")
    .outputOptions("-preset", "fast", "-crf", "18", "-movflags", "+faststart").output(output));
  return readClip(ffmpeg, output);
}
