import assert from "node:assert/strict";
import test from "node:test";

import { makeService, startEdition, registerNominator, submitCandidate } from "./helpers.js";

function oneCandidate(service) {
  registerNominator(service);
  submitCandidate(service, { id: "c1" });
}

test("证明材料提交后保存原件哈希", () => {
  const { service } = makeService();
  startEdition(service);
  oneCandidate(service);
  service.submitEvidence({ evidenceId: "e1", candidateId: "c1", kind: "鉴定", source: "鉴定中心", title: "成果鉴定书", contentHash: "h-original" });
  const e = service.state().evidences["e1"];
  assert.equal(e.originalHash, "h-original");
  assert.equal(e.currentHash, "h-original");
  assert.equal(e.version, 1);
});

test("证明材料必须带内容哈希", () => {
  const { service } = makeService();
  startEdition(service);
  oneCandidate(service);
  assert.throws(
    () => service.submitEvidence({ evidenceId: "e1", candidateId: "c1", kind: "鉴定", source: "s", title: "t" }),
    /内容哈希/
  );
});

test("更正保留原件哈希链、处理理由并升版本", () => {
  const { service } = makeService();
  startEdition(service);
  oneCandidate(service);
  service.submitEvidence({ evidenceId: "e1", candidateId: "c1", kind: "鉴定", source: "s", title: "t", contentHash: "h1" });
  service.correctEvidence({ evidenceId: "e1", newContentHash: "h2", reason: "出具单位勘误落款日期" }, "staff-li");
  const e = service.state().evidences["e1"];
  assert.equal(e.currentHash, "h2");
  assert.equal(e.originalHash, "h1"); // 原件哈希不动
  assert.equal(e.version, 2);
  assert.deepEqual(e.corrections[0], {
    version: 2,
    fromHash: "h1",
    newHash: "h2",
    reason: "出具单位勘误落款日期",
    approvalId: null,
    by: "staff-li",
    at: e.corrections[0].at,
  });
});

test("无理由更正、无变化更正均被拒绝", () => {
  const { service } = makeService();
  startEdition(service);
  oneCandidate(service);
  service.submitEvidence({ evidenceId: "e1", candidateId: "c1", kind: "鉴定", source: "s", title: "t", contentHash: "h1" });
  assert.throws(() => service.correctEvidence({ evidenceId: "e1", newContentHash: "h2", reason: "  " }), /处理理由/);
  assert.throws(() => service.correctEvidence({ evidenceId: "e1", newContentHash: "h1", reason: "x" }), /版本相同/);
});

test("异议期内更正必须出示书面批准，禁止暗改", () => {
  const { service } = makeService();
  startEdition(service);
  oneCandidate(service);
  service.submitEvidence({ evidenceId: "e1", candidateId: "c1", kind: "鉴定", source: "s", title: "t", contentHash: "h1" });
  service.openObjectionPeriod({ deadline: "2030-12-31T00:00:00Z" });
  assert.throws(() => service.correctEvidence({ evidenceId: "e1", newContentHash: "h2", reason: "勘误" }), /批准记录/);
  service.grantApproval({ approvalId: "ap-1", action: "evidence_correction", targetId: "e1", reason: "异议复核后批准勘误" }, "chair");
  service.correctEvidence({ evidenceId: "e1", newContentHash: "h2", reason: "勘误", approvalId: "ap-1" }, "staff");
  assert.equal(service.state().evidences["e1"].corrections[0].approvalId, "ap-1");
});

test("异议期可申请复核证据，受截止时间约束", () => {
  const { service, clock } = makeService();
  startEdition(service);
  oneCandidate(service);
  service.openObjectionPeriod({ deadline: "2030-03-10T00:00:00Z" });
  service.requestEvidenceReview({ candidateId: "c1", scope: "all" }, "objector-a");
  service.closeEvidenceReview({ candidateId: "c1", conclusion: "证据属实，原件哈希一致" }, "secretariat");
  clock.advance(40 * 24 * 3600 * 1000); // 越过 3/10 截止
  assert.throws(() => service.requestEvidenceReview({ candidateId: "c1" }, "objector-b"), /异议期已截止/);
});
