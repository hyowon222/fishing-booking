import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fishingRouter from "./fishing";
import bookingRouter from "./booking";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fishingRouter);
router.use(bookingRouter);

export default router;
