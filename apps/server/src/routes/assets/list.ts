import { readdir } from "@toonflow/file";
import { join, relative, sep } from "node:path";
import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

type AssetEntry = { name: string; path: string; type: "file" | "directory"; children?: AssetEntry[]; upscale?: Awaited<ReturnType<typeof u.assetVideoVariants.listVariant>> };

const router = Router();

async function listEntries(root: string, directory: string, variantSizes: Set<number>): Promise<AssetEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter(entry => entry.isFile() || entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
    .map(async entry => {
      const path = join(directory, entry.name);
      return {
        name: entry.name,
        path: relative(root, path).split(sep).join("/"),
        type: entry.isDirectory() ? "directory" : "file",
        ...(entry.isDirectory() ? { children: await listEntries(root, path, variantSizes) }
          : { upscale: await u.assetVideoVariants.listVariant(root, path, variantSizes) }),
      };
    }));
}

export default router.get("/", async (_req, res) => {
  const directory = await u.assets.getAssetsDirectory();
  const variantSizes = await u.assetVideoVariants.listVariantSizes(directory);
  res.set("Cache-Control", "no-store").json(success({ entries: await listEntries(directory, directory, variantSizes) }));
});
