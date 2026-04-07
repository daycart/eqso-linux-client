import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eqsoRouter from "./eqso";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/eqso", eqsoRouter);
router.use("/auth", authRouter);

export default router;
