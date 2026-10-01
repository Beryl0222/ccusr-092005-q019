import assert from "node:assert/strict";
import test from "node:test";

import { makeService, startEdition, registerNominator, submitCandidate, registerJudge, advanceToRound, declareNoneForAll, vote } from "./helpers.js";
import { reproduceRound } from "../src/domain/replay.js";

function publishedWinner(service) {
  registerNominator(service);
  submitCandidate(service, { id: "c1", categoryId: "catA", rawName: "王崇安" });
  registerJudge(service, "j1");
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  advanceToRound(service, "r1");
  declareNoneForAll(service, "j1", ["c1"]);
  vote(service, { roundId: "r1", judgeId: "j1", candidateId: "c1", score: 92 });
  service.closeRound("r1");
  service.countRound("r1");
}

test("公示只展示本人获准公开的内容；未确认授权则跳过并说明", () => {
  const { service } = makeService();
  startEdition(service);
  publishedWinner(service);
  const { published, skipped } = service.publishRound("r1");
  assert.deepEqual(published, []);
  assert.equal(skipped[0].candidateId, "c1");
  // 授权后再次公示
  service.confirmConsent({ candidateId: "c1", scope: "full" }, "candidate");
  const again = service.publishRound("r1");
  assert.deepEqual(again.published, ["pub-r1-c1"]);
  const state = service.state();
  assert.equal(state.publications["pub-r1-c1"].snapshot.publishedFrom.identity.name, "王崇安");
});

test("公示勘误必须批准，且完整保留前后快照、理由与批准人", () => {
  const { service } = makeService();
  startEdition(service);
  publishedWinner(service);
  service.confirmConsent({ candidateId: "c1", scope: "full" }, "candidate");
  service.publishRound("r1");
  assert.throws(
    () => service.correctPublication({ publicationId: "pub-r1-c1", changes: { rank: 2 }, reason: "排版错位" }),
    /批准记录/
  );
  service.grantApproval({ approvalId: "ap-pub", action: "publication_correction", targetId: "pub-r1-c1", reason: "秘书处复核公示排版" }, "chair");
  service.correctPublication(
    { publicationId: "pub-r1-c1", changes: { publishedFrom: { identity: { name: "王崇安（更正）", affiliation: "第一医院" }, category: { categoryId: "catA", name: "甲类奖" }, deeds: "事迹摘要", evidenceSources: [] } }, reason: "姓名排版漏字", approvalId: "ap-pub" },
    "staff-li"
  );
  const diff = service.publicationDiff("pub-r1-c1");
  assert.equal(diff.status, "corrected");
  assert.equal(diff.corrections[0].approvedBy, "chair");
  assert.equal(diff.corrections[0].reason, "姓名排版漏字");
  assert.ok(JSON.stringify(diff.corrections[0].diff).includes("王崇安（更正）"));
  assert.equal(diff.current.version, 2);
  // 前版快照仍然可查
  assert.equal(diff.corrections[0].before.version, 1);
});

test("勘误不得无理由", () => {
  const { service } = makeService();
  startEdition(service);
  publishedWinner(service);
  service.confirmConsent({ candidateId: "c1", scope: "full" }, "candidate");
  service.publishRound("r1");
  service.grantApproval({ approvalId: "ap", action: "publication_correction", targetId: "pub-r1-c1", reason: "r" }, "chair");
  assert.throws(
    () => service.correctPublication({ publicationId: "pub-r1-c1", changes: { rank: 2 }, reason: " ", approvalId: "ap" }),
    /勘误必须说明理由/
  );
});

test("撤稿需要对应事项的批准记录", () => {
  const { service } = makeService();
  startEdition(service);
  publishedWinner(service);
  service.confirmConsent({ candidateId: "c1", scope: "full" }, "candidate");
  service.publishRound("r1");
  const ap = "ap-ret";
  service.grantApproval({ approvalId: ap, action: "publication_retraction", targetId: "pub-r1-c1", reason: "异议查实材料失实" }, "chair");
  service.retractPublication({ publicationId: "pub-r1-c1", reason: "异议查实材料失实", approvalId: ap });
  assert.equal(service.state().publications["pub-r1-c1"].status, "retracted");
});

test("秘书处可复现任一历史轮次：复现结果与当时事件一致", () => {
  const { service } = makeService();
  startEdition(service);
  publishedWinner(service);
  service.confirmConsent({ candidateId: "c1", scope: "full" }, "candidate");
  const seqBeforePublish = service.journal.length;
  service.publishRound("r1");
  const events = service.journal.events;

  // 复现公示之前：无 publications
  const before = reproduceRound(events, "r1", seqBeforePublish);
  assert.equal(before.result.perCandidate[0].candidateId, "c1");
  assert.deepEqual(before.publications, []);
  // 复现当前：有公示
  const now = reproduceRound(events, "r1");
  assert.equal(now.publications[0].id, "pub-r1-c1");
  assert.equal(now.edition.rulesVersion, "t1");
  assert.equal(now.awardees[0].candidateId, "c1");
});
