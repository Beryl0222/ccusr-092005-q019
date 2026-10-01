import assert from "node:assert/strict";
import test from "node:test";

import { makeService, startEdition, registerNominator, submitCandidate, registerJudge, advanceToRound, declareNoneForAll, vote } from "./helpers.js";

function twoCandidatesTwoJudges(service) {
  registerNominator(service, "nom-1", "合作医院");
  registerNominator(service, "nom-2", "另一医院");
  submitCandidate(service, { id: "c1", nominatorId: "nom-1", categoryId: "catA" });
  submitCandidate(service, { id: "c2", nominatorId: "nom-2", categoryId: "catA" });
  registerJudge(service, "j1", "评委甲");
  registerJudge(service, "j2", "评委乙");
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  service.assignJudge({ roundId: "r1", judgeId: "j2" });
  advanceToRound(service, "r1");
}

test("未提交利益冲突声明的评委既不能查看也不能评分", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  const view = service.judgeViewForCandidate("j1", "c1");
  assert.equal(view.visible, false);
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 90 }), /利益冲突声明/);
});

test("评委与推荐单位有合作：声明回避后对该单位全部候选不可见、不可评分", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  // j1 与 nom-1 有合作 → 对 nom-1 推荐的 c1 声明回避
  service.declareCOI({ declarationId: "d1", judgeId: "j1", targetType: "nominator", targetId: "nom-1", scope: "recuse", relation: "课题合作" }, "j1");
  declareNoneForAll(service, "j1", ["c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);

  const view = service.judgeViewForCandidate("j1", "c1");
  assert.equal(view.visible, false);
  assert.equal(view.access, "recuse");
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 90 }), /已回避/);
  // c2 与 nom-1 无关，可正常查看评分
  assert.equal(service.judgeViewForCandidate("j1", "c2").visible, true);
});

test("受限声明：可查看脱敏材料但不可评分", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  service.declareCOI({ declarationId: "d1", judgeId: "j1", targetType: "candidate", targetId: "c1", scope: "restricted" }, "j1");
  declareNoneForAll(service, "j1", ["c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  const view = service.judgeViewForCandidate("j1", "c1");
  assert.equal(view.visible, true);
  assert.equal(view.redacted, true);
  assert.equal(view.candidate.rawName, "【脱敏】");
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 70 }), /受限查看权/);
});

test("回避与弃权都不计入分母，更不会折算成低分", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  // j1 回避 c1；j1 对 c2 无冲突；j2 对两者无冲突
  service.declareCOI({ declarationId: "d1", judgeId: "j1", targetType: "candidate", targetId: "c1", scope: "recuse" }, "j1");
  declareNoneForAll(service, "j1", ["c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  // c1：j1 回避（排除），j2 打 60 → 均分应为 60（分母为 1，而不是 0 分拉低）
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c1", score: 60 });
  // c2：j1 打 90；j2 弃权 → 均分 90（分母为 1，弃权不折算 0）
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: 90 });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c2", verdict: "abstain" });

  service.closeRound("r1");
  const { perCandidate } = service.countRound("r1");
  assert.equal(perCandidate.c1.average, 60);
  assert.equal(perCandidate.c1.scoredCount, 1);
  assert.equal(perCandidate.c1.excludedCount, 1);
  assert.equal(perCandidate.c2.average, 90);
  assert.equal(perCandidate.c2.abstainCount, 1);
  assert.equal(perCandidate.c2.scoredCount, 1);
});

test("弃权票不得携带分数", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  assert.throws(
    () => service.castBallot({ roundId: "r1", judgeId: "j1", candidateId: "c1", verdict: "abstain", score: 0 }, "j1"),
    /弃权票不得携带分数/
  );
});

test("无回避但未投票（且未弃权）不能计票", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 80 });
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: 80 });
  // j2 完全未投
  service.closeRound("r1");
  assert.throws(() => service.countRound("r1"), /未投票/);
});

test("有评委漏报利益冲突声明时计票被拒绝并列出名单", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  // j2 未声明，也没投票
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 80 });
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: 80 });
  service.closeRound("r1");
  assert.throws(() => service.countRound("r1"), /利益冲突声明/);
});

test("投票关闭后不得再投票；计票后结果封存", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 80 });
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: 80 });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c1", score: 70 });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c2", score: 70 });
  service.closeRound("r1");
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 95 }), /未在投票中/);
  service.countRound("r1");
  assert.throws(() => service.countRound("r1"), /已计票并封存/);
});

test("计票结果包含选票摘要，事后重算一致即证明未暗改", () => {
  const { service } = makeService();
  startEdition(service);
  twoCandidatesTwoJudges(service);
  declareNoneForAll(service, "j1", ["c1", "c2"]);
  declareNoneForAll(service, "j2", ["c1", "c2"]);
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 80 });
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c2", score: 90 });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c1", score: 85 });
  vote(service, { roundId: "r1", judgeId: "j2", candidateId: "c2", score: 75 });
  service.closeRound("r1");
  const { ballotDigest } = service.countRound("r1");
  const check = service.verifyBallotsIntact("r1");
  assert.equal(check.intact, true);
  assert.equal(check.recomputed, ballotDigest);
});

test("利益冲突解除后声明恢复效力需留痕；回避声明覆盖候选簇", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service, "nom-1");
  submitCandidate(service, { id: "p1" });
  submitCandidate(service, { id: "p2" });
  service.mergeIdentities({ clusterId: "cl", memberCandidateIds: ["p1", "p2"] });
  registerJudge(service, "j1");
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  service.declareCOI({ declarationId: "d1", judgeId: "j1", targetType: "cluster", targetId: "cl", scope: "recuse" }, "j1");
  advanceToRound(service, "r1");
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "p1", score: 80 }), /已回避/);
  assert.throws(() => vote(service, { roundId: "r1", judgeId: "j1", candidateId: "p2", score: 80 }), /已回避/);
});
