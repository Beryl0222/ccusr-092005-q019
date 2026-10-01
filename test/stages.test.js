import assert from "node:assert/strict";
import test from "node:test";

import { candidatesInRound } from "../src/domain/projection.js";
import { makeService, startEdition } from "./helpers.js";

test("阶段必须按 事实核验→专业评议→社会责任审议 顺序推进", () => {
  const { service } = makeService();
  startEdition(service);
  assert.throws(() => service.openStage("professional_review"), /前置阶段/);
  service.openStage("fact_check");
  assert.throws(() => service.openStage("social_responsibility_review"), /前置阶段/);
  service.completeStage("fact_check");
  service.openStage("professional_review");
  service.completeStage("professional_review");
  service.openStage("social_responsibility_review");
  assert.equal(service.state().stageState.social_responsibility_review.status, "open");
});

test("阶段结论仅在阶段开放时记录", () => {
  const { service } = makeService();
  startEdition(service);
  assert.throws(() => service.recordStageVerdict({ stage: "fact_check", candidateId: "x", verdict: "pass" }), /阶段未开放/);
});

test("轮次必须依规则顺序开启：终审轮要求专业评议轮先计票", () => {
  const { service } = makeService();
  startEdition(service);
  service.openStage("fact_check");
  service.completeStage("fact_check");
  service.openStage("professional_review");
  assert.throws(() => service.openRound("r2"), /前序轮次/);
});

test("事实核验未通过的候选可凭批准取消资格，自指定轮次起退出", () => {
  const { service } = makeService();
  startEdition(service);
  service.registerNominator({ nominatorId: "n1", name: "医院", type: "hospital" });
  service.submitCandidate(
    { candidateId: "c1", nominatorId: "n1", rawName: "张", affiliation: "医院", candidateType: "person", categoryId: "catA", deedsSummary: "" },
    "n1"
  );
  service.grantApproval({ approvalId: "ap1", action: "disqualification", targetId: "c1", reason: "关键证明无法核验" }, "chair");
  assert.throws(
    () => service.disqualifyCandidate({ candidateId: "c1", reason: "x", approvalId: "ap1", effectiveFromRoundId: "r9" }),
    /生效轮次不存在/
  );
  service.disqualifyCandidate({ candidateId: "c1", reason: "关键证明无法核验", approvalId: "ap1", effectiveFromRoundId: "r1" });
  service.openStage("fact_check");
  service.completeStage("fact_check");
  service.openStage("professional_review");
  service.openRound("r1");
  assert.equal(candidatesInRound(service.state(), "r1").some((c) => c.id === "c1"), false);
});
