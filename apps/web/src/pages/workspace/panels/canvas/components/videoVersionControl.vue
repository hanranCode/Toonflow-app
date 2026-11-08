<template>
  <el-select v-if="entry.upscale?.state === 'ready'" class="resolutionSelect" :modelValue="version" :aria-label="t`${entry.name} 的分辨率`" size="small"
    :title="resolutionTitle" @change="emit('change', $event)">
    <el-option value="original" :label="originalLabel" />
    <el-option value="1080p" label="1080P" />
  </el-select>
  <el-button v-else-if="supportsVideoUpscale(entry)" class="upscaleAction" :type="entry.upscale?.state === 'failed' ? 'warning' : 'primary'" text size="small"
    :loading="submitting" :disabled="entry.upscale?.state === 'running'" :title="entry.upscale?.error" @click.stop="emit('upscale')">{{ actionLabel }}</el-button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t, translate } from "@toonflow/i18n/vue";
import { supportsVideoUpscale, type AssetEntry, type VideoVersion } from "@/lib/assetVideoVersions";

const props = defineProps<{ entry: AssetEntry; version: VideoVersion; submitting?: boolean }>();
const emit = defineEmits<{ change: [version: VideoVersion]; upscale: [] }>();
const originalLabel = computed(() => {
  const { originalWidth, originalHeight } = props.entry.upscale ?? {};
  return originalWidth && originalHeight ? t`原片 ${Math.min(originalWidth, originalHeight)}P` : translate("原片");
});
const resolutionTitle = computed(() => {
  const { originalWidth, originalHeight, width, height } = props.entry.upscale ?? {};
  return props.version === "1080p" ? `${width} × ${height}` : `${originalWidth} × ${originalHeight}`;
});
const actionLabel = computed(() => {
  switch (props.entry.upscale?.state) {
    case "running": return translate("超分中");
    case "failed": return translate("重试超分");
    case "interrupted": return translate("复查超分");
    default: return translate("超分至 1080P");
  }
});
</script>

<style scoped lang="scss">
.resolutionSelect { flex: 0 0 112px; width: 112px; }
.upscaleAction { flex-shrink: 0; padding-inline: 5px; }
</style>
