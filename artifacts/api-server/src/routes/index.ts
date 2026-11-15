import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fishingRouter from "./fishing";
import bookingRouter from "./booking";
import catchRouter from "./catch";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fishingRouter);
router.use(bookingRouter);
router.use(catchRouter);

export default router;
