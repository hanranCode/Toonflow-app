import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const upscale = await u.assetVideoVariants.getVideoUpscaleStatus(req.query.path as string, u.multiTenant.requestIdentity(req));
  res.set("Cache-Control", "no-store").json(success({ upscale }));
});
