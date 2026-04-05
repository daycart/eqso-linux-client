import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eqsoRouter from "./eqso";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/eqso", eqsoRouter);

export default router;
