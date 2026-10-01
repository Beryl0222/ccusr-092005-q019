import assert from "node:assert/strict";
import test from "node:test";

import { publicViewOfCandidate } from "../src/domain/projection.js";
import { makeService, startEdition, registerNominator, submitCandidate } from "./helpers.js";

function threeSplitNominations(service) {
  registerNominator(service, "nom-a", "第一医院");
  registerNominator(service, "nom-b", "社区联盟");
  registerNominator(service, "nom-c", "省医师协会");
  submitCandidate(service, { id: "p-tech", nominatorId: "nom-a", categoryId: "catA", rawName: "王崇安" });
  submitCandidate(service, { id: "p-service", nominatorId: "nom-b", categoryId: "catB", rawName: "王崇安" });
  submitCandidate(service, { id: "p-tech2", nominatorId: "nom-c", categoryId: "catA", rawName: "王崇安" });
}

test("同一医生按条线拆分的多条提名可人工归并为一个身份簇", () => {
  const { service } = makeService();
  startEdition(service);
  threeSplitNominations(service);
  service.mergeIdentities({ clusterId: "cl-wang", memberCandidateIds: ["p-tech", "p-service", "p-tech2"], note: "秘书处核对为同一人" });
  const state = service.state();
  assert.deepEqual(new Set(state.clusters["cl-wang"].memberIds), new Set(["p-tech", "p-service", "p-tech2"]));
  assert.equal(state.candidates["p-service"].clusterId, "cl-wang");
});

test("归并至少需要两个候选，且个人与团队不能混并", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1", candidateType: "person" });
  submitCandidate(service, { id: "t1", candidateType: "team", categoryId: "catB" });
  assert.throws(() => service.mergeIdentities({ clusterId: "x", memberCandidateIds: ["p1"] }), /至少需要两个/);
  assert.throws(() => service.mergeIdentities({ clusterId: "x", memberCandidateIds: ["p1", "t1"] }), /个人候选与团队候选/);
});

test("归并操作留痕：操作人、时间与说明", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1" });
  submitCandidate(service, { id: "p2" });
  service.mergeIdentities({ clusterId: "cl", memberCandidateIds: ["p1", "p2"], note: "重名核对" }, "staff-li");
  const entry = service.state().clusters["cl"].log[0];
  assert.equal(entry.by, "staff-li");
  assert.equal(entry.note, "重名核对");
  assert.ok(entry.at);
});

test("误归并可拆出，拆分同样留痕", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1", rawName: "王崇安" });
  submitCandidate(service, { id: "p2", rawName: "王崇安" });
  service.mergeIdentities({ clusterId: "cl", memberCandidateIds: ["p1", "p2"] });
  service.unlinkIdentity({ clusterId: "cl", candidateId: "p2", reason: "身份证号核对为另一人" });
  const state = service.state();
  assert.deepEqual(state.clusters["cl"].memberIds, ["p1"]);
  assert.equal(state.candidates["p2"].clusterId, null);
  assert.equal(state.clusters["cl"].log[1].action, "unlink");
});

test("本人按身份簇一次性确认公开范围，未确认不得公示", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1" });
  submitCandidate(service, { id: "p2" });
  service.mergeIdentities({ clusterId: "cl", memberCandidateIds: ["p1", "p2"] });
  // 已归并的候选不允许按单候选授权
  assert.throws(() => service.confirmConsent({ candidateId: "p1", scope: "full" }), /以身份簇为单位/);
  service.confirmConsent({ clusterId: "cl", scope: "deeds_only" });
  assert.equal(publicViewOfCandidate(service.state(), "p1").visible, true);
  assert.equal(publicViewOfCandidate(service.state(), "p2").visible, true);
});

test("deeds_only 公示隐去身份但保留事迹", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1", rawName: "王崇安" });
  service.confirmConsent({ candidateId: "p1", scope: "deeds_only" }, "candidate-p1");
  const pub = publicViewOfCandidate(service.state(), "p1");
  assert.equal(pub.visible, true);
  assert.match(pub.sections.identity.name, /隐去姓名/);
  assert.equal(pub.sections.deeds, "事迹摘要");
});

test("custom 公开范围逐字段生效", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1", rawName: "王崇安" });
  service.confirmConsent(
    { candidateId: "p1", scope: "custom", allowedSections: { identity: true, category: true, deeds: false, evidenceSources: false } },
    "candidate"
  );
  const pub = publicViewOfCandidate(service.state(), "p1");
  assert.equal(pub.sections.identity.name, "王崇安");
  assert.equal(pub.sections.deeds, undefined);
});
