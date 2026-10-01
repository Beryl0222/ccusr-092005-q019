import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { SelectionService } from "../src/domain/service.js";
import { fixedClock } from "../src/domain/clock.js";
import { createHttpApp } from "../src/server/http.js";

const RULES = {
  categories: [{ id: "catA", name: "甲类", quota: 1 }],
  rounds: [{ id: "r1", name: "专业轮", stage: "professional_review" }],
};

async function withServer(run) {
  const service = new SelectionService({ clock: fixedClock("2030-02-01T00:00:00Z") });
  const server = createServer(createHttpApp(service));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, command, payload, actor = "secretariat") {
  const res = await fetch(`${base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": actor },
    body: JSON.stringify({ command, payload }),
  });
  return { status: res.status, body: await res.json() };
}

test("HTTP：命令成功返回头哈希；冻结后修改规则返回 409", async () => {
  await withServer(async (base) => {
    const ok = await post(base, "defineRules", { version: "v1", rules: RULES });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.head);
    await post(base, "openEdition", { editionId: "ed", name: "测试届" });
    const blocked = await post(base, "defineRules", { version: "v2", rules: RULES });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "RULES_FROZEN");
  });
});

test("HTTP：未声明利益冲突的投票返回 403", async () => {
  await withServer(async (base) => {
    await post(base, "defineRules", { version: "v1", rules: RULES });
    await post(base, "openEdition", { editionId: "ed" });
    await post(base, "registerNominator", { nominatorId: "n1", name: "医院", type: "hospital" });
    await post(base, "submitCandidate", { candidateId: "c1", nominatorId: "n1", rawName: "张", affiliation: "医院", candidateType: "person", categoryId: "catA", deedsSummary: "" }, "n1");
    await post(base, "registerJudge", { judgeId: "j1", name: "甲", organization: "学会" });
    await post(base, "assignJudge", { roundId: "r1", judgeId: "j1" });
    await post(base, "openStage", { stage: "fact_check" });
    await post(base, "completeStage", { stage: "fact_check" });
    await post(base, "openStage", { stage: "professional_review" });
    await post(base, "openRound", { roundId: "r1" });
    const denied = await post(base, "castBallot", { roundId: "r1", judgeId: "j1", candidateId: "c1", verdict: "score", score: 90 }, "j1");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "COI_UNDECLARED");
  });
});

test("HTTP：查询状态、哈希链校验与未知路由", async () => {
  await withServer(async (base) => {
    await post(base, "defineRules", { version: "v1", rules: RULES });
    const stateRes = await fetch(`${base}/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.edition.rules.version, "v1");

    const verifyRes = await fetch(`${base}/journal/verify`);
    const verify = await verifyRes.json();
    assert.equal(verify.ok, true);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  });
});

test("HTTP：历史时刻查询 ?atSeq= 可复现", async () => {
  await withServer(async (base) => {
    const r1 = await post(base, "defineRules", { version: "v1", rules: RULES });
    const seq1 = r1.body.head;
    await post(base, "registerNominator", { nominatorId: "n1", name: "医院", type: "hospital" });
    const res = await fetch(`${base}/state?atSeq=1`);
    const state = await res.json();
    assert.deepEqual(state.nominators, {});
    assert.equal(state.edition.rules.version, "v1");
    assert.ok(seq1);
  });
});
