import { createServer } from "node:http";
import { SelectionService } from "../domain/service.js";
import { fixedClock } from "../domain/clock.js";
import { createHttpApp } from "./http.js";

/**
 * 启动入口：PORT=3000 node src/server/index.js
 * 默认内存事件日志；重启即清空，持久化部署应通过 store.js 落盘后注入。
 */
const clock = process.env.FIXED_TIME ? fixedClock(process.env.FIXED_TIME) : undefined;
const service = new SelectionService(clock ? { clock } : {});
const app = createHttpApp(service);
const port = Number(process.env.PORT ?? 3000);

createServer(app).listen(port, () => {
  console.log(`医者荣誉遴选后端已启动：http://localhost:${port}`);
});
