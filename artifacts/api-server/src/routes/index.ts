import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eqsoRouter from "./eqso";
import authRouter from "./auth";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/eqso", eqsoRouter);
router.use("/auth", authRouter);
router.use("/admin", adminRouter);

export default router;
