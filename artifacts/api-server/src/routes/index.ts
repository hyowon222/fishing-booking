import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fishingRouter from "./fishing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fishingRouter);

export default router;
