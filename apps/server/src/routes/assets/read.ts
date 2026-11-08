import { lstat } from "@toonflow/file";
import { sendFile } from "@/utils/fileHttp";
import { basename } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.get("/", validateFields({ path: z.string().min(1).max(4096), download: z.literal("true").optional(), version: z.literal("1080p").optional() }, "query"), async (req, res, next) => {
  const asset = req.query.version === "1080p"
    ? await u.assetVideoVariants.readVideoVariant(req.query.path as string)
    : await u.assets.resolveAssetPath(req.query.path as string);
  const { path } = asset;
  if (!(await lstat(path)).isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  if (req.query.download === "true") res.attachment("name" in asset ? asset.name : basename(path));
  res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});
