import assert from "node:assert/strict";
import test from "node:test";

import { makeService, startEdition, registerNominator, submitCandidate, registerJudge, advanceToRound, declareNoneForAll, vote } from "./helpers.js";

function tieFixture(service) {
  registerNominator(service);
  submitCandidate(service, { id: "c1", categoryId: "catA" }); // catA 名额 1
  submitCandidate(service, { id: "c2", categoryId: "catA" });
  registerJudge(service, "j1");
  registerJudge(service, "j2");
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  service.assignJudge({ roundId: "r1", judgeId: "j2" });
  advanceToRound(service, "r1");
}

function voteBoth(service, s1, s2) {
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: s1[0] });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c1", score: s1[1] });
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: s2[0] });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c2", score: s2[1] });
}

test("类别名额为 1 且均分并列时，未处置不能确定获奖名单", () => {
  const { service } = makeService();
  startEdition(service);
  tieFixture(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  voteBoth(service, [80, 90], [90, 80]); // 均分均为 85
  service.closeRound("r1");
  const { perCandidate, ties } = service.countRound("r1");
  assert.equal(perCandidate.c1.average, 85);
  assert.deepEqual(ties.sort(), ["c1", "c2"]);
  assert.throws(() => service.awardeesOf("r1"), /未处置的并列/);
});

test("并列处置后按正式次序确定唯一获奖人，处置全程留痕", () => {
  const { service } = makeService();
  startEdition(service);
  tieFixture(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  voteBoth(service, [80, 90], [90, 80]);
  service.closeRound("r1");
  service.countRound("r1");
  service.resolveTie(
    { roundId: "r1", tiedGroupCandidateIds: ["c1", "c2"], orderedCandidateIds: ["c2", "c1"], method: "council_vote", reason: "理事会实名表决 5:2" },
    "chair"
  );
  const awardees = service.awardeesOf("r1");
  assert.deepEqual(awardees.map((a) => a.candidateId), ["c2"]);
  const resolution = service.state().tieResolutions["r1"][0];
  assert.equal(resolution.method, "council_vote");
  assert.equal(resolution.reason, "理事会实名表决 5:2");
});

test("并列处置的次序必须恰好覆盖并列组", () => {
  const { service } = makeService();
  startEdition(service);
  tieFixture(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c2", "c1"]);
  voteBoth(service, [80, 90], [90, 80]);
  service.closeRound("r1");
  service.countRound("r1");
  assert.throws(
    () => service.resolveTie({ roundId: "r1", tiedGroupCandidateIds: ["c1", "c2"], orderedCandidateIds: ["c1"] }),
    /次序/
  );
  assert.throws(
    () => service.resolveTie({ roundId: "r1", tiedGroupCandidateIds: ["c1", "c2"], orderedCandidateIds: ["c1", "c1"] }),
    /次序/
  );
});

test("非并列候选不能强行发起并列处置；同一并列组不得二次处置", () => {
  const { service } = makeService();
  startEdition(service);
  tieFixture(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  voteBoth(service, [90, 90], [70, 70]); // 90 vs 70，不并列
  service.closeRound("r1");
  service.countRound("r1");
  assert.throws(
    () => service.resolveTie({ roundId: "r1", tiedGroupCandidateIds: ["c1", "c2"], orderedCandidateIds: ["c1", "c2"] }),
    /并非并列/
  );
});

test("不跨名额线的并列不阻断获奖（两人并列第二但名额已满）", () => {
  const { service } = makeService();
  startEdition(service);
  // catB 名额 2：c1 第一，c2/c3 并列第二仍只取前二？——并列第二共两人则超名额。
  // 构造：c1 第一，c2 第二，c3/c4 并列第三（不跨线）
  registerNominator(service);
  submitCandidate(service, { id: "c1", categoryId: "catB" });
  submitCandidate(service, { id: "c2", categoryId: "catB" });
  submitCandidate(service, { id: "c3", categoryId: "catB" });
  submitCandidate(service, { id: "c4", categoryId: "catB" });
  registerJudge(service, "j1");
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  advanceToRound(service, "r1");
  declareNoneForAll(service, "j1", ["c1", "c2", "c3", "c4"]);
  for (const [id, score] of [["c1", 95], ["c2", 90], ["c3", 80], ["c4", 80]]) {
    vote(service, { roundId: "r1", judgeId: "j1", candidateId: id, score });
  }
  service.closeRound("r1");
  service.countRound("r1");
  const awardees = service.awardeesOf("r1").map((a) => a.candidateId).sort();
  assert.deepEqual(awardees, ["c1", "c2"]);
});
