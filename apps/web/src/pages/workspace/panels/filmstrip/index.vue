<template>
  <section class="filmstrip" aria-label="胶片工作台">
    <header class="sequenceHeader">
      <div>
        <h1>胶片</h1>
        <p>逐段编排动作、挑选接点，再预览整部影片。</p>
      </div>
      <div class="headerActions">
        <label class="targetField">目标 <input v-model.number="target" type="number" min="4" max="240" aria-label="目标时长（秒）" :disabled="busy" /> 秒</label>
        <button class="primary" :disabled="busy || !canAssemble" @click="renderPreview">
          <icon-player-play :size="16" /> {{ state.preview ? "播放整片" : "合成预览" }}
        </button>
        <a v-if="state.preview && previewUrl" class="buttonLink" :href="previewUrl" download="film.mp4" aria-label="下载成片"><icon-download :size="17" /></a>
      </div>
    </header>

    <p v-if="error" class="notice" role="alert">{{ error }} <button :disabled="busy" @click="reload">重新载入</button></p>
    <p v-if="status" class="status" role="status">{{ status }}</p>

    <div class="editor">
      <div class="monitor">
        <div class="monitorBar">
          <span>{{ frames.length ? "参考帧预览" : mode === "whole" ? "整片预览" : selected?.name || "片段预览" }}</span>
          <span class="timecode">{{ frames.length ? timestamp(frames[chosenFrame]?.time ?? 0) : `${timestamp(playhead)} / ${timestamp(playbackDuration)}` }}</span>
        </div>
        <div class="screen">
          <img v-if="frames.length && frameUrls[chosenFrame]" :src="frameUrls[chosenFrame]" alt="当前选中的参考帧" />
          <video v-else-if="playerUrl" :key="playerUrl" ref="player" :src="playerUrl" controls playsinline preload="metadata"
            @loadedmetadata="preparePlayer" @timeupdate="updatePlayhead" @error="onVideoError" />
          <div v-else class="monitorEmpty">
            <icon-movie :size="34" stroke="1.3" />
            <strong>{{ selected ? "等待片段素材" : "把第一段视频放上胶片" }}</strong>
            <span>{{ selected ? "在右侧选参考帧、编辑动作或导入已有视频。" : "从工作区添加视频，也可以先拆前三段分镜。" }}</span>
          </div>
        </div>
      </div>

      <aside class="inspector" aria-label="片段详情">
        <template v-if="selected">
          <div class="detailHeading">
            <h2>{{ String(selectedIndex + 1).padStart(2, "0") }} · 片段详情</h2>
            <span>{{ selected.clip ? timestamp(clipLength(selected.clip)) : selected.taskId ? "任务待复查" : "待生成" }}</span>
          </div>
          <label>片段名称 <input v-model="name" maxlength="80" :disabled="busy" /></label>
          <div v-if="selected.reference" class="reference">
            <img v-if="referenceUrl" :src="referenceUrl" alt="所选接点画面" />
            <div><strong>参考帧</strong><span>{{ sourceName }} · {{ timestamp(selected.reference.time) }}</span></div>
          </div>
          <label>镜头动作 <textarea v-model="prompt" rows="5" maxlength="2000" :disabled="busy || !!selected.taskId" placeholder="写清人物如何接住上一个动作，以及镜头怎么动。" /></label>
          <label v-if="selected.clip && !nextHasMedia">结束位置（秒）
            <input v-model.number="clipEnd" type="number" :min="selected.clip.in ?? 0" :max="selected.clip.duration" step="any" :disabled="busy" />
          </label>
          <div class="detailActions">
            <button :disabled="busy || !!selected.taskId || !name.trim()" @click="saveDetails">保存分镜</button>
            <button v-if="!selected.clip" :disabled="busy || !!selected.taskId || !languageModel" @click="writeMotion">AI 续写动作</button>
            <button v-if="selected.clip" class="primary" :disabled="busy || nextHasMedia" @click="showTail">
              <icon-photo-scan :size="16" /> 末 10 帧
            </button>
          </div>
          <p v-if="nextHasMedia" class="hint">下一段已有素材或正在生成。</p>
          <template v-if="!selected.clip">
            <label>生成模型
              <select v-model="modelKey" :disabled="busy || !!selected.taskId">
                <option value="" disabled>{{ availableModels.length ? "请选择模型" : "当前没有适用的模型" }}</option>
                <option v-for="model in availableModels" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)">{{ model.label }}</option>
              </select>
            </label>
            <div class="detailActions">
              <label class="durationField">生成时长
                <select v-model.number="seconds" :disabled="busy || !!selected.taskId">
                  <option v-for="duration in durations" :key="duration" :value="duration">{{ duration }} 秒</option>
                </select>
              </label>
              <button class="primary" :disabled="busy || (!selected.taskId && (!modelKey || !prompt.trim() || (selectedIndex > 0 && !selected.reference)))" @click="generateShot">
                {{ selected.taskId ? "复查原任务" : "生成本段" }}
              </button>
            </div>
            <p v-if="selectedIndex > 0 && !selected.reference" class="hint">先从上一段的「末 10 帧」挑一个接点。</p>
          </template>
        </template>
        <h2 v-else>从现有素材开始</h2>

        <div v-if="assetPaths.length" class="assetPicker">
          <label>项目视频
            <select v-model="assetPath" aria-label="项目视频" :disabled="busy">
              <option v-for="path in assetPaths" :key="path" :value="path">{{ path.split("/").at(-1) }}</option>
            </select>
          </label>
          <button :disabled="busy || !assetPath || !!selected?.taskId" @click="addAsset">{{ selected && !selected.clip ? "填入本段" : "加入胶片" }}</button>
        </div>
        <details class="planning" :open="!state.shots.length">
          <summary>按目标时长拆前三段</summary>
          <label>创作梗概 <textarea v-model="brief" rows="3" maxlength="1500" :disabled="busy" placeholder="描述人物、地点、要完成的动作，以及你希望怎样收尾。" /></label>
          <label>脚本模型
            <select v-model="languageKey" :disabled="busy">
              <option value="" disabled>请选择语言模型</option>
              <option v-for="model in languageModels" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)">{{ model.label }}</option>
            </select>
          </label>
          <button :disabled="busy || !brief.trim() || !languageModel || state.shots.length > 37" @click="planShots">生成三个分镜草稿</button>
        </details>
      </aside>
    </div>

    <section v-if="frames.length" class="joinFrames" aria-label="接点选择">
      <div class="trackHeader">
        <div><h2>选一个接点</h2><p>从「{{ selected?.name }}」结尾选一帧。生成下一段后，上一段会在该帧收住。</p></div>
        <button @click="frames = []" :disabled="busy">关闭选帧</button>
      </div>
      <div class="frameRow">
        <button v-for="(frame, index) in frames" :key="frame.path" class="frameButton" :aria-pressed="chosenFrame === index"
          :aria-label="`选择第 ${index + 1} 帧，${timestamp(frame.time)}`" :disabled="busy" @click="chosenFrame = index">
          <img v-if="frameUrls[index]" :src="frameUrls[index]" alt="" />
          <span>{{ timestamp(frame.time) }}</span>
        </button>
      </div>
      <div class="joinActions"><button class="primary" :disabled="busy" @click="continueFromFrame">用这帧续拍</button></div>
    </section>

    <section class="timeline" aria-label="胶片时间轴">
      <div class="trackHeader">
        <div><h2>镜头序列</h2><p>{{ readyCount }} / {{ state.shots.length }} 段已就绪 · {{ timestamp(totalDuration) }} / {{ timestamp(state.target) }}</p></div>
        <button :disabled="busy || state.shots.length >= 40" @click="addDraft"><icon-plus :size="16" /> 新增分镜</button>
      </div>
      <div class="track">
        <button v-for="(shot, index) in state.shots" :key="shot.id" class="shot" :style="{ '--clipWidth': `${Math.max(125, 29 * (shot.clip ? clipLength(shot.clip) : shot.seconds))}px` }"
          :class="{ playing: mode === 'whole' && playingIndex === index }" :aria-pressed="selectedId === shot.id" :disabled="busy" @click="chooseShot(shot.id)">
          <span class="shotPicture">
            <img v-if="shotPosters[index]" :src="shotPosters[index]" alt="" />
            <icon-movie v-else :size="20" stroke="1.4" />
            <span class="shotNumber">{{ String(index + 1).padStart(2, "0") }}</span>
          </span>
          <span class="shotName">{{ shot.name }}</span>
          <span class="shotMeta">{{ shot.clip ? timestamp(clipLength(shot.clip)) : shot.taskId ? "待复查" : `草稿 · ${shot.seconds}s` }}</span>
        </button>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onDeactivated, onMounted, onScopeDispose, ref, shallowRef, watch } from "vue";
import { IconDownload, IconMovie, IconPhotoScan, IconPlayerPlay, IconPlus } from "@tabler/icons-vue";
import { findNodeModel, getNodeModelIdentity, getNodeModelKey, useNodeAi, type NodeAiModel, type NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import { useNodeFfmpeg } from "@toonflow/nodes-scaffold/nodeFfmpeg";
import { assemble, readClip, readTail, type CutFrame } from "./media";
import { clipLength, newShot, useSequence, type Sequence, type Shot } from "./sequence";

const { directory } = defineProps<{ directory: string }>();
const { files, load, save, folder, videos } = useSequence(directory);
const createFfmpeg = useNodeFfmpeg();
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());
const ai = useNodeAi({ onModelsChanged: refreshModels });
const getFfmpeg = () => createFfmpeg(lifetime.signal);

const state = shallowRef<Sequence>({ version: 1, target: 30, brief: "", shots: [] });
const selectedId = ref("");
const selectedIndex = computed(() => state.value.shots.findIndex(shot => shot.id === selectedId.value));
const selected = computed(() => state.value.shots[selectedIndex.value]);
const busy = ref(false);
const error = ref("");
const status = ref("");
const target = ref(30);
const brief = ref("");
const name = ref("");
const prompt = ref("");
const seconds = ref(5);
const clipEnd = ref<number | string>(0);
const mode = ref<"shot" | "whole">("shot");
const frames = shallowRef<CutFrame[]>([]);
const chosenFrame = ref(0);
const models = shallowRef<NodeMediaModel[]>([]);
const languageModels = shallowRef<NodeAiModel[]>([]);
const modelKey = ref("");
const languageKey = ref("");
const languageModel = computed(() => findNodeModel(languageModels.value, languageKey.value));
const assetPaths = shallowRef<string[]>([]);
const assetPath = ref("");
const player = ref<HTMLVideoElement>();
const playhead = ref(0);
let startPlayback = false;
const playingIndex = computed(() => {
  let cursor = 0;
  return state.value.shots.findIndex(shot => {
    cursor += shot.clip ? clipLength(shot.clip) : 0;
    return playhead.value < cursor;
  });
});
const readyCount = computed(() => state.value.shots.filter(shot => shot.clip).length);
const totalDuration = computed(() => state.value.shots.reduce((total, shot) => total + (shot.clip ? clipLength(shot.clip) : 0), 0));
const canAssemble = computed(() => readyCount.value > 0 && readyCount.value === state.value.shots.length);
const activeClip = computed(() => mode.value === "whole" ? state.value.preview : selected.value?.clip);
const playbackDuration = computed(() => activeClip.value ? clipLength(activeClip.value) : 0);
const sourceName = computed(() => state.value.shots.find(shot => shot.id === selected.value?.reference?.source)?.name ?? "上一段");
const nextHasMedia = computed(() => {
  const next = state.value.shots[selectedIndex.value + 1];
  return !!(next?.clip || next?.taskId);
});
const availableModels = computed(() => {
  const allowed = selected.value?.reference ? ["singleImage", "endFrameOptional"] : ["text"];
  return models.value.filter(model => model.type === "video" && model.mode?.some(mode => typeof mode === "string" && allowed.includes(mode)));
});
const videoModel = computed(() => findNodeModel(availableModels.value, modelKey.value));
const durations = computed(() => [...new Set(videoModel.value?.durationResolutionMap?.flatMap(item => item.duration) ?? [5])].sort((a, b) => a - b));

watch(availableModels, items => {
  if (findNodeModel(items, modelKey.value)) return;
  const first = items.find(item => item.modelId === "minimax-h3-first-frame" || item.modelId === "minimax-h3-text") ?? items[0];
  modelKey.value = first ? getNodeModelKey(first) : "";
}, { immediate: true });
watch(durations, items => {
  if (!items.includes(seconds.value)) seconds.value = items.at(-1) ?? 5;
}, { immediate: true });
watch(selected, shot => {
  name.value = shot?.name ?? "";
  prompt.value = shot?.prompt ?? "";
  seconds.value = shot?.seconds ?? 5;
  frames.value = [];
  clipEnd.value = shot?.clip ? (shot.clip.out ?? shot.clip.duration) : 0;
  if (!durations.value.includes(seconds.value)) seconds.value = durations.value.at(-1) ?? 5;
}, { immediate: true });

function useUrls(paths: () => (string | undefined)[], onError = false) {
  const urls = ref<(string | undefined)[]>([]);
  watch(() => JSON.stringify(paths()), (_, __, cleanup) => {
    const items = paths();
    let current = true;
    const leases = items.map(path => path ? files.acquireUrl(path) : undefined);
    cleanup(() => { current = false; leases.forEach(lease => lease?.release()); });
    urls.value = [];
    items.forEach((path, index) => {
      if (!path) return;
      void leases[index]!.url.then(url => { if (current) urls.value[index] = url; })
        .catch(() => { if (current && onError) error.value = "找不到胶片素材，请检查项目文件"; });
    });
  }, { immediate: true });
  return urls;
}

const playingUrls = useUrls(() => [activeClip.value?.path], true);
const playerUrl = computed(() => playingUrls.value[0]);
const previewUrls = useUrls(() => [state.value.preview?.path]);
const previewUrl = computed(() => previewUrls.value[0]);
const referenceUrls = useUrls(() => [selected.value?.reference?.path]);
const referenceUrl = computed(() => referenceUrls.value[0]);
const frameUrls = useUrls(() => frames.value.map(frame => frame.path));
const shotPosters = useUrls(() => state.value.shots.map((shot, index) => state.value.shots[index + 1]?.reference?.path ?? shot.reference?.path));

function timestamp(value: number) {
  const centiseconds = Math.round(Math.max(0, value) * 100);
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}

function onVideoError(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (video === player.value && video.src === playerUrl.value && activeClip.value) error.value = "无法播放这段视频，请检查工作区素材";
}

function preparePlayer() {
  if (!player.value) return;
  player.value.currentTime = activeClip.value?.in ?? 0;
  if (startPlayback) void player.value.play().catch(() => {});
  startPlayback = false;
}

function updatePlayhead() {
  const video = player.value;
  const clip = activeClip.value;
  if (!video || !clip) return;
  const start = clip.in ?? 0;
  playhead.value = Math.min(clipLength(clip), Math.max(0, video.currentTime - start));
  if (clip.out !== undefined && video.currentTime >= clip.out) video.pause();
}

function chooseShot(id: string) {
  mode.value = "shot";
  startPlayback = false;
  selectedId.value = id;
  playhead.value = 0;
  frames.value = [];
  if (player.value) {
    player.value.pause();
    player.value.currentTime = selected.value?.clip?.in ?? 0;
  }
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

async function action(label: string, callback: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  status.value = label;
  try { await callback(); }
  catch (reason) { if (!lifetime.signal.aborted) error.value = message(reason); }
  finally { busy.value = false; status.value = ""; }
}

async function refreshModels() {
  const [media, language] = await Promise.allSettled([ai.getMediaModels(), ai.getModels()]);
  if (media.status === "fulfilled") models.value = media.value;
  if (language.status === "fulfilled") {
    languageModels.value = language.value;
    if (!findNodeModel(language.value, languageKey.value)) languageKey.value = language.value[0] ? getNodeModelKey(language.value[0]) : "";
  }
}

async function reload() {
  await action("正在读取项目胶片…", async () => {
    state.value = await load();
    target.value = state.value.target;
    brief.value = state.value.brief;
    chooseShot(state.value.shots.some(shot => shot.id === selectedId.value) ? selectedId.value : state.value.shots[0]?.id ?? "");
    assetPaths.value = await videos();
    assetPath.value = assetPaths.value[0] ?? "";
  });
}
onMounted(() => { void reload(); void refreshModels(); });
onDeactivated(() => player.value?.pause());

async function commit(shots = state.value.shots, preview: Sequence["preview"] | null = state.value.preview) {
  lifetime.signal.throwIfAborted();
  const goal = Number(target.value);
  if (!Number.isFinite(goal) || goal < 4 || goal > 240) throw new Error("目标时长应为 4 至 240 秒");
  const data = { ...state.value, target: goal, brief: brief.value, shots, preview: preview ?? undefined };
  await save(data);
  state.value = data;
}

function replace(shot: Shot, invalidate = false) {
  const shots = state.value.shots.map(item => item.id === shot.id ? shot : item);
  return commit(shots, invalidate ? null : state.value.preview);
}

function details(shot: Shot) {
  return { ...shot, name: name.value.trim() || shot.name, prompt: prompt.value.trim(), seconds: seconds.value };
}

function saveDetails() {
  return action("正在保存分镜…", async () => {
    if (!selected.value) return;
    const shot = details(selected.value);
    const clip = shot.clip;
    const end = Number(clipEnd.value);
    const changed = !!(clip && !nextHasMedia.value && end !== (clip.out ?? clip.duration));
    if (changed && clip) {
      if (!Number.isFinite(end) || end <= (clip.in ?? 0) || end > clip.duration) throw new Error("结束位置需在视频的有效范围内");
      shot.clip = { ...clip, out: end };
    }
    await replace(shot, changed);
  });
}

function addDraft() {
  return action("正在新增分镜…", async () => {
    const shot = newShot(`分镜 ${state.value.shots.length + 1}`);
    await commit([...state.value.shots, shot], null);
    chooseShot(shot.id);
  });
}

function addAsset() {
  return action("正在读取视频规格…", async () => {
    if (state.value.shots.length >= 40 && (!selected.value || selected.value.clip)) throw new Error("胶片最多支持 40 段");
    const clip = await readClip(await getFfmpeg(), assetPath.value);
    const existing = selected.value;
    const shot = existing && !existing.clip ? details(existing) : newShot(assetPath.value.split("/").at(-1)!.replace(/\.[^.]+$/, ""), "", Math.round(clip.duration) || 1);
    shot.clip = clip;
    if (existing?.id === shot.id) await replace(shot, true);
    else await commit([...state.value.shots, shot], null);
    chooseShot(shot.id);
  });
}

function showTail() {
  return action("正在提取片段末尾的真实视频帧…", async () => {
    const clip = selected.value?.clip;
    if (!clip) return;
    mode.value = "shot";
    player.value?.pause();
    frames.value = await readTail(await getFfmpeg(), clip, await folder());
    chosenFrame.value = frames.value.length - 1;
  });
}

function continueFromFrame() {
  return action("正在保存接点…", async () => {
    const source = selected.value;
    const frame = frames.value[chosenFrame.value];
    if (!source?.clip || !frame || nextHasMedia.value) return;
    const shots = [...state.value.shots];
    if (!shots[selectedIndex.value + 1] && shots.length >= 40) throw new Error("胶片最多支持 40 段");
    const next = shots[selectedIndex.value + 1] ?? newShot(`分镜 ${shots.length + 1}`);
    shots[selectedIndex.value] = details(source);
    shots[selectedIndex.value + 1] = { ...next, reference: { ...frame, source: source.id } };
    await commit(shots, null);
    chooseShot(next.id);
  });
}

async function writeWithAi(text: string) {
  const model = languageModel.value;
  if (!model) throw new Error("请先选择脚本模型");
  const result = await ai.generate({ ...getNodeModelIdentity(model), directory, prompt: text,
    systemPrompt: "你是分镜导演。维持角色、服饰、场景与运镜连续性。输出具体可拍的动作和镜头指令。" });
  return result.text.trim();
}

function planShots() {
  return action("正在编写前三段分镜草稿…", async () => {
    const content = await writeWithAi(`目标 ${target.value} 秒。已完成 ${totalDuration.value.toFixed(2)} 秒。梗概：${brief.value}。已有分镜：${state.value.shots.map(shot => `${shot.name} ${shot.prompt}`).join(" / ")}。规划接下来的三个 4 或 5 秒分镜，每段写出动作如何起承和如何收尾。只返回 JSON 数组，恰好三个对象，每项含 name、prompt、seconds。`);
    const result: unknown = JSON.parse(content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
    if (!Array.isArray(result) || result.length !== 3 || !result.every(shot => typeof shot?.name === "string" && shot.name.trim()
      && typeof shot.prompt === "string" && shot.prompt.trim() && [4, 5].includes(shot.seconds))) throw new Error("脚本模型没有返回三个可用分镜");
    const drafts = result.map(shot => newShot(shot.name.slice(0, 80), shot.prompt.slice(0, 2000), shot.seconds));
    await commit([...state.value.shots, ...drafts], null);
    chooseShot(drafts[0]!.id);
  });
}

function writeMotion() {
  return action("正在续写本段动作…", async () => {
    const prior = state.value.shots[selectedIndex.value - 1];
    prompt.value = (await writeWithAi(`梗概：${brief.value}。上一段：${prior?.prompt || prior?.name || "无"}。当前草稿：${prompt.value || name.value}。写下一段 ${seconds.value} 秒的拍摄提示，动作从参考帧所示姿势延续，只返回提示词正文。`)).slice(0, 2000);
  });
}

function generateShot() {
  return action(selected.value?.taskId ? "正在复查原任务…" : "正在生成本段，关闭胶片后可复查原任务…", async () => {
    let shot = selected.value;
    const model = videoModel.value;
    if (!shot) return;
    const taskId = shot.taskId || crypto.randomUUID();
    const resuming = !!shot.taskId;
    let terminalFailure = false;
    try {
      let result;
      const options = { taskId, onStatus: (value: { state?: string }) => { terminalFailure = value.state === "failed" || value.state === "cancelled"; } };
      if (resuming) {
        result = await ai.resumeMedia(directory, taskId, lifetime.signal, options);
      } else {
        if (!model) throw new Error("请先选择生成模型");
        const frame = shot.reference;
        const useSingleImage = model.mode?.includes("singleImage");
        const reference = frame ? { path: frame.path, mimeType: "image/png" } : undefined;
        const outputDirectory = await folder();
        shot = { ...details(shot), taskId };
        await replace(shot);
        const resolution = model.durationResolutionMap?.find(item => item.duration.includes(shot!.seconds))?.resolution[0];
        result = await ai.generateVideo({ ...getNodeModelIdentity(model), directory, outputDirectory, prompt: shot.prompt,
          duration: shot.seconds, resolution, generateAudio: model.audio === true,
          mode: reference ? (useSingleImage ? "singleImage" : "endFrameOptional") : "text",
          images: reference && useSingleImage ? [reference] : undefined, firstFrame: reference && !useSingleImage ? reference : undefined,
        }, lifetime.signal, options);
      }
      const video = result.find(item => item.mediaType === "video");
      if (!video) throw new Error("任务未返回视频素材");
      const clip = await readClip(await getFfmpeg(), video.path);
      const shots = state.value.shots.map(item => {
        if (item.id === shot!.id) return { ...item, clip, taskId: undefined };
        if (shot!.reference && item.id === shot!.reference.source && item.clip) {
          return { ...item, clip: { ...item.clip, out: shot!.reference.end } };
        }
        return item;
      });
      await commit(shots, null);
    } catch (reason) {
      const rejected = !!(reason as { mediaTaskRejected?: boolean } | undefined)?.mediaTaskRejected;
      if ((terminalFailure || rejected) && state.value.shots.some(item => item.taskId === taskId)) await replace({ ...shot, taskId: undefined });
      throw reason;
    }
  });
}

function renderPreview() {
  return action("正在合成整片预览…", async () => {
    if (!canAssemble.value) return;
    if (!state.value.preview) {
      const clips = state.value.shots.map(shot => shot.clip!);
      const preview = await assemble(await getFfmpeg(), clips, `${await folder()}/film.mp4`);
      await commit(state.value.shots, preview);
    }
    if (mode.value === "whole" && player.value) {
      player.value.currentTime = 0;
      void player.value.play().catch(() => {});
    } else {
      playhead.value = 0;
      startPlayback = true;
      mode.value = "whole";
    }
  });
}
</script>

<style scoped lang="scss">
.filmstrip {
  position: absolute;
  inset: 62px 0 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px max(18px, 3vw) 28px;
  overflow: auto;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);

  h1, h2, p { margin: 0; }
  h1 { font-size: 26px; line-height: 1.15; font-weight: 650; }
  h2 { font-size: 15px; font-weight: 650; }
  p, .hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.5; }
  .sequenceHeader, .trackHeader, .monitorBar, .detailHeading, .headerActions, .detailActions, .joinActions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .sequenceHeader p, .trackHeader p { margin-top: 4px; }
  button, .buttonLink {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    padding: 5px 11px;
    border: 1px solid var(--el-border-color);
    border-radius: var(--el-border-radius-base);
    background: var(--el-bg-color-overlay);
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
    &:hover:not(:disabled) { border-color: var(--el-color-primary); }
    &:disabled { opacity: .52; cursor: default; }
  }
  :is(button, a, input, textarea, select, summary):focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  .primary { color: white; background: var(--el-color-primary); border-color: var(--el-color-primary); }
  label { display: grid; gap: 5px; font-size: 12px; font-weight: 550; }
  input, textarea, select {
    min-width: 0;
    width: 100%;
    padding: 7px 8px;
    border: 1px solid var(--el-border-color);
    border-radius: var(--el-border-radius-base);
    background: var(--el-bg-color);
    color: inherit;
    font: inherit;
    font-weight: 400;
  }
  textarea { resize: vertical; line-height: 1.55; }
  .targetField, .durationField { display: flex; align-items: center; }
  .targetField input { width: 64px; }
  .editor {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
    align-items: start;
    gap: 16px;
  }
  .monitor, .inspector, .timeline, .joinFrames {
    min-width: 0;
    border: 1px solid var(--el-border-color-light);
    border-radius: 12px;
    background: var(--el-bg-color-overlay);
  }
  .monitor { overflow: hidden; }
  .monitorBar {
    padding: 9px 13px;
    font-size: 13px;
    .timecode { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
  }
  .screen {
    display: grid;
    place-items: center;
    height: clamp(220px, 45vh, 620px);
    background: #131418;
    color: #c4c7d1;
    video, img { width: 100%; height: 100%; object-fit: contain; }
  }
  .monitorEmpty {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 15px;
    text-align: center;
    strong { color: #f3f4fa; font-size: 15px; }
    span { font-size: 13px; }
  }
  .inspector {
    display: grid;
    gap: 12px;
    padding: 14px;
    .detailHeading span, .reference span { color: var(--el-text-color-secondary); font-size: 12px; }
    .reference {
      display: flex;
      gap: 10px;
      align-items: center;
      font-size: 12px;
      img { width: 94px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 5px; }
      div { display: grid; gap: 4px; }
    }
    .assetPicker { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 7px; }
    .planning {
      padding-top: 10px;
      border-top: 1px solid var(--el-border-color-light);
      summary { cursor: pointer; font-size: 13px; font-weight: 550; }
      > :not(summary) { margin-top: 9px; }
    }
  }
  .timeline, .joinFrames { padding: 12px; }
  .frameRow, .track { display: flex; gap: 6px; margin-top: 9px; padding: 2px 2px 7px; overflow-x: auto; }
  .joinActions { justify-content: end; }
  .frameButton, .shot {
    padding: 0;
    display: grid;
    align-items: stretch;
    gap: 0;
    justify-content: stretch;
    overflow: hidden;
    text-align: left;
    &[aria-pressed="true"], &.playing {
      border-color: var(--el-color-primary);
      box-shadow: inset 0 0 0 1px var(--el-color-primary);
    }
  }
  .frameButton {
    flex: 1 0 78px;
    img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #1c1d23; }
    span { padding: 4px; text-align: center; font-size: 11px; font-variant-numeric: tabular-nums; }
  }
  .shot {
    flex: 0 0 var(--clipWidth);
    .shotPicture {
      display: grid;
      position: relative;
      place-items: center;
      height: 56px;
      overflow: hidden;
      color: #c4c7d1;
      background: #1c1d23;
      img { width: 100%; height: 56px; object-fit: cover; }
    }
    .shotNumber {
      position: absolute;
      top: 5px;
      left: 5px;
      padding: 2px 4px;
      border-radius: 3px;
      color: #f6f6fa;
      background: #111217d9;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .shotName, .shotMeta { display: block; padding: 3px 7px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .shotName { padding-top: 6px; }
    .shotMeta { color: var(--el-text-color-secondary); font-size: 11px; padding-bottom: 6px; }
  }
  .notice { color: var(--el-color-danger); }
  .status { color: var(--el-color-primary); }
}
@media (max-width: 760px) {
  .filmstrip {
    .editor { grid-template-columns: minmax(0, 1fr); }
    .screen { height: min(45vh, 62vw); min-height: 180px; }
  }
}
</style>
