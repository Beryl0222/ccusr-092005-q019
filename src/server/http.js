import { DomainError } from "../domain/errors.js";
import { reproduceRound } from "../domain/replay.js";
import { publicViewOfCandidate } from "../domain/projection.js";

/**
 * 极简 JSON HTTP 适配层：领域规则全部在 SelectionService 中，
 * 这里只做路由、取 actor（x-actor，真实部署应替换为鉴权中间件）与错误码映射。
 *
 * 命令：POST /commands  {"command": "...", "payload": {...}}
 * 查询：GET /state | /journal/verify | /judge-view/... 等
 */
const STATUS_RULES = [
  [/^COI_(RECUSED|RESTRICTED|UNDECLARED)/, 403],
  [/^JOURNAL_/, 409],
  [/^RULES_FROZEN$/, 409],
  [/^EDITION_|ROUND_ORDER|ROUND_NOT_OPEN|ROUND_NOT_CLOSED|ROUND_ALREADY_COUNTED|STAGE_/, 409],
  [/^NOMINATION_CLOSED|SUPPLEMENT_CLOSED|OBJECTION_CLOSED|BAD_DEADLINE/, 409],
  [/_NOT_FOUND$|^CLUSTER_NOT_FOUND/, 404],
  [/_EXISTS$/, 409],
  [/^TIE_|^BALLOT_TAMPERED|^APPROVAL_|^RULES_MISSING|^RULES_NO_/, 409],
  [/^BAD_/, 400],
];

function statusFor(code) {
  for (const [pattern, status] of STATUS_RULES) {
    if (pattern.test(code)) return status;
  }
  return 400;
}

export function createHttpApp(service) {
  const actorOf = (req) => req.headers["x-actor"] || "anonymous";

  const call = (name, payload, actor) => {
    if (typeof service[name] !== "function") throw new DomainError("UNKNOWN_COMMAND", `未知命令：${name}`);
    return service[name](payload ?? {}, actor);
  };

  return async function app(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "POST" && url.pathname === "/commands") {
        const body = await readJson(req);
        const { command, payload } = body;
        const result = call(command, payload, body.actor ?? actorOf(req));
        send(200, { ok: true, result: result ?? null, head: service.journal.headHash() });
        return;
      }

      if (req.method === "GET") {
        if (url.pathname === "/state") {
          const atSeq = Number(url.searchParams.get("atSeq") ?? "Infinity");
          send(200, Number.isFinite(atSeq) ? service.stateAt(atSeq) : service.state());
          return;
        }
        if (url.pathname === "/journal/verify") {
          send(200, service.journal.verify());
          return;
        }
        const m1 = url.pathname.match(/^\/judge-view\/([^/]+)\/([^/]+)$/);
        if (m1) {
          send(200, service.judgeViewForCandidate(decodeURIComponent(m1[1]), decodeURIComponent(m1[2])));
          return;
        }
        const m2 = url.pathname.match(/^\/rounds\/([^/]+)\/awardees$/);
        if (m2) {
          send(200, { roundId: m2[1], awardees: service.awardeesOf(decodeURIComponent(m2[1])) });
          return;
        }
        const m3 = url.pathname.match(/^\/rounds\/([^/]+)\/ballots-intact$/);
        if (m3) {
          send(200, service.verifyBallotsIntact(decodeURIComponent(m3[1])));
          return;
        }
        const m4 = url.pathname.match(/^\/rounds\/([^/]+)\/reproduce$/);
        if (m4) {
          const atSeq = Number(url.searchParams.get("atSeq") ?? "Infinity");
          send(
            200,
            reproduceRound(service.journal.events, decodeURIComponent(m4[1]), Number.isFinite(atSeq) ? atSeq : Infinity)
          );
          return;
        }
        const m5 = url.pathname.match(/^\/publications\/([^/]+)\/diff$/);
        if (m5) {
          send(200, service.publicationDiff(decodeURIComponent(m5[1])));
          return;
        }
        const m6 = url.pathname.match(/^\/candidates\/([^/]+)\/public-view$/);
        if (m6) {
          send(200, publicViewOfCandidate(service.state(), decodeURIComponent(m6[1])));
          return;
        }
      }

      send(404, { ok: false, error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
    } catch (error) {
      if (error instanceof DomainError) {
        send(statusFor(error.code), { ok: false, error: { code: error.code, message: error.message, details: error.details } });
      } else {
        send(500, { ok: false, error: { code: "INTERNAL", message: error.message } });
      }
    }
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new DomainError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}
