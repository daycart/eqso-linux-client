import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { existsSync } from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production, serve the React client's static build.
// The build script copies artifacts/eqso-client/dist/public → artifacts/api-server/dist/public.
// __dirname (set by the esbuild banner) resolves to the directory of this bundled file.
if (process.env.NODE_ENV === "production") {
  const publicDir = path.join(__dirname, "public");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    // SPA fallback: all unmatched routes return index.html
    app.get("*", (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
    logger.info({ publicDir }, "Serving React client from static files");
  } else {
    logger.warn({ publicDir }, "Static public dir not found — client not served");
  }
}

export default app;
