import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ path: z.string().min(1).max(4096) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const upscale = await u.assetVideoVariants.startVideoUpscale(req.body.path, u.multiTenant.requestIdentity(req));
  res.set("Cache-Control", "no-store").json(success({ upscale }));
});
