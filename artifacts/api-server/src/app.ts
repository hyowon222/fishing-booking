import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { homeAgentRouter } from "./routes/home-agent";
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
// 집 PC 중계가 올리는 결과(페이지 본문 포함)는 100kb 한도보다 클 수 있어 먼저, 더 큰 한도로 받는다
app.use("/api/home-agent", express.json({ limit: "20mb" }));
app.use("/api", homeAgentRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
