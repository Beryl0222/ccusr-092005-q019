import assert from "node:assert/strict";
import test from "node:test";

import { SelectionService } from "../src/domain/service.js";
import { fixedClock } from "../src/domain/clock.js";
import { makeService, startEdition, registerNominator, submitCandidate, RULES } from "./helpers.js";

test("遴选开始即冻结规则、名额与轮次", () => {
  const { service } = makeService();
  startEdition(service);
  assert.ok(service.state().edition.frozenAt);
  assert.throws(() => service.defineRules({ version: "t2", rules: RULES }), /冻结/);
});

test("冻结前可修订规则并保留历史版本", () => {
  const { service } = makeService();
  service.defineRules({ version: "v1", rules: RULES });
  service.defineRules({ version: "v2", rules: { ...RULES, categories: [{ id: "catA", name: "甲类", quota: 2 }, { id: "catB", name: "乙类", quota: 2 }] } });
  service.openEdition({ editionId: "ed", name: "测试届" });
  assert.equal(service.state().edition.ruleVersions.length, 1);
  assert.equal(service.state().edition.ruleVersions[0].version, "v1");
  assert.equal(service.state().edition.rules.categories[0].quota, 2);
});

test("开始遴选前必须具备类别与轮次", () => {
  const { service } = makeService();
  service.defineRules({
    version: "x",
    rules: { categories: [{ id: "c", name: "c", quota: 1 }], rounds: [] },
  });
  assert.throws(() => service.openEdition({ editionId: "ed" }), /轮次/);
});

test("类别名额必须为非负整数", () => {
  const { service } = makeService();
  assert.throws(
    () => service.defineRules({ version: "x", rules: { ...RULES, categories: [{ id: "c", name: "c", quota: -1 }] } }),
    /名额/
  );
});

test("提名受截止时间约束", () => {
  const clock = fixedClock("2030-04-01T00:00:00Z");
  const service = new SelectionService({ clock, actor: "secretariat" });
  startEdition(service);
  registerNominator(service);
  assert.throws(() => submitCandidate(service, { id: "c-late" }), /提名截止/);
});

test("补充材料受更晚的补充截止时间约束，初始材料在提名截止后仍拒绝", () => {
  const clock = fixedClock("2030-02-15T00:00:00Z"); // 提名截止 3/1 前
  const service = new SelectionService({ clock, actor: "secretariat" });
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "c1" });
  clock.advance(20 * 24 * 3600 * 1000); // 到 3/7：提名已截止，补充 4/15 未到
  service.submitEvidence(
    { evidenceId: "e-supp", candidateId: "c1", kind: "补充", source: "s", title: "t", contentHash: "h", kindTag: "supplement" },
    "secretariat"
  );
  assert.throws(
    () =>
      service.submitEvidence(
        { evidenceId: "e-init", candidateId: "c1", kind: "初始", source: "s", title: "t", contentHash: "h2" },
        "secretariat"
      ),
    /提名/
  );
});

test("补充截止后补充材料也被拒绝", () => {
  const clock = fixedClock("2030-02-01T00:00:00Z");
  const service = new SelectionService({ clock, actor: "secretariat" });
  startEdition(service);
  registerNominator(service);
  submitCandidate(service, { id: "c1" });
  clock.advance(80 * 24 * 3600 * 1000); // 约 4/22，超过 4/15
  assert.throws(
    () =>
      service.submitEvidence(
        { evidenceId: "e-supp", candidateId: "c1", kind: "补充", source: "s", title: "t", contentHash: "h", kindTag: "supplement" },
        "secretariat"
      ),
    /补充材料截止/
  );
});

test("冻结后评委名单仍可安排，但轮次必须来自冻结规则", () => {
  const { service } = makeService();
  startEdition(service);
  service.registerJudge({ judgeId: "j1", name: "甲", organization: "学会" });
  service.assignJudge({ roundId: "r1", judgeId: "j1" });
  assert.throws(() => service.assignJudge({ roundId: "r-unknown", judgeId: "j1" }), /不存在该轮次/);
});
