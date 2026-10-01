import assert from "node:assert/strict";
import test from "node:test";

import { makeService, startEdition, registerNominator, submitCandidate } from "./helpers.js";

test("共同成果关联多个候选并分别记录贡献说明", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service, "nom-1");
  registerNominator(service, "nom-2");
  submitCandidate(service, { id: "p1", nominatorId: "nom-1", candidateType: "person" });
  submitCandidate(service, { id: "t1", nominatorId: "nom-2", candidateType: "team", categoryId: "catB" });
  service.declareSharedWork({
    workId: "w1",
    title: "卒中绿色通道",
    candidateIds: ["p1", "t1"],
    contributions: { p1: "路径设计", t1: "多学科落地" },
  });
  const w = service.state().sharedWorks["w1"];
  assert.equal(w.contributions.p1, "路径设计");
  assert.equal(w.contributions.t1, "多学科落地");
});

test("共同成果只能计入一个候选，再分配给另一方被拒绝（避免重复计入）", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1" });
  submitCandidate(service, { id: "p2", categoryId: "catB" });
  service.declareSharedWork({ workId: "w1", title: "成果", candidateIds: ["p1", "p2"], contributions: {} });
  service.allocateSharedWork({ workId: "w1", countedForCandidateId: "p1", note: "秘书处核验：主要完成人" });
  assert.equal(service.state().sharedWorks["w1"].countedFor, "p1");
  assert.throws(() => service.allocateSharedWork({ workId: "w1", countedForCandidateId: "p2" }), /不得重复计入/);
  // 同一方重复确认是幂等的
  service.allocateSharedWork({ workId: "w1", countedForCandidateId: "p1" });
});

test("共同成果计入对象必须是参与方", () => {
  const { service } = makeService();
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "p1" });
  submitCandidate(service, { id: "p2", categoryId: "catB" });
  submitCandidate(service, { id: "p3", categoryId: "catB" });
  service.declareSharedWork({ workId: "w1", title: "成果", candidateIds: ["p1", "p2"], contributions: {} });
  assert.throws(() => service.allocateSharedWork({ workId: "w1", countedForCandidateId: "p3" }), /必须是成果参与方/);
});
