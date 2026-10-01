import test from "node:test";

import { assert, setup, startEdition, expectError, Errors, Stage, frozenRules } from "./helpers/setup.js";
import { ConsentSection } from "../src/index.js";

function nominateAll(api) {
  // 同一医生被医院按个人技术、社会服务拆成两条提名
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "cand-zhang-tech",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: { name: "张医生", title: "主任医师", organization: "第一医院" },
    },
    "第一医院"
  );
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "cand-zhang-service",
      candidateType: "PERSON",
      category: "社会服务奖",
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: { name: "张医生", title: "主任医师", organization: "第一医院" },
    },
    "第一医院"
  );
  // 另一位医生
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "cand-li-tech",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "org-clinic",
      nominatorName: "城南门诊",
      profile: { name: "李医生", title: "副主任医师", organization: "城南门诊" },
    },
    "城南门诊"
  );
  // 团队
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "cand-team",
      candidateType: "TEAM",
      category: "金牌团队奖",
      nominatorId: "org-society",
      nominatorName: "行业学会",
      profile: { name: "心外攻坚团队", organization: "第一医院" },
      teamContact: "王主任",
    },
    "行业学会"
  );
}

test("规则冻结前不能接受提名，冻结后不能再改", (t) => {
  const api = setup();
  api.selection.createEdition({ editionId: "E1", name: "届", year: 2026 });
  expectError(Errors.FROZEN, () =>
    api.selection.submitNomination(
      {
        editionId: "E1",
        candidateId: "x",
        candidateType: "PERSON",
        category: "个人技术奖",
        nominatorId: "o",
        nominatorName: "单位",
      },
      "单位"
    )
  );
  api.selection.freezeRules("E1", frozenRules());
  api.selection.advanceStage("E1", Stage.NOMINATION);
  expectError(Errors.FROZEN, () => api.selection.freezeRules("E1", frozenRules()));
});

test("不在冻结类别内的提名被拒绝", () => {
  const api = setup();
  startEdition(api);
  expectError(Errors.VALIDATION, () =>
    api.selection.submitNomination(
      {
        editionId: "E1",
        candidateId: "x",
        candidateType: "PERSON",
        category: "不存在的奖",
        nominatorId: "o",
        nominatorName: "单位",
      },
      "单位"
    )
  );
});

test("团队候选必须有联系人", () => {
  const api = setup();
  startEdition(api);
  expectError(Errors.VALIDATION, () =>
    api.selection.submitNomination(
      {
        editionId: "E1",
        candidateId: "t1",
        candidateType: "TEAM",
        category: "金牌团队奖",
        nominatorId: "o",
        nominatorName: "学会",
      },
      "学会"
    )
  );
});

test("人工身份归并：跨类别提名关联到同一自然人，两条候选资格仍独立", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  api.selection.resolveIdentity(
    {
      personId: "person-zhang",
      name: "张医生",
      credentialHash: "hash-of-id-110101",
      organization: "第一医院",
      links: [
        { candidateId: "cand-zhang-tech", basis: "证件号哈希一致", reason: "同名同人" },
        { candidateId: "cand-zhang-service", basis: "证件号哈希一致", reason: "同名同人" },
      ],
    },
    "秘书处"
  );
  const state = api.selection.state();
  assert.deepEqual(state.persons["person-zhang"].candidateIds.sort(), [
    "cand-zhang-service",
    "cand-zhang-tech",
  ]);
  // 两条资格分属不同类别、均未被吸收
  assert.equal(state.candidates["cand-zhang-tech"].mergedInto, null);
  assert.equal(state.candidates["cand-zhang-service"].mergedInto, null);
  assert.equal(state.candidates["cand-zhang-tech"].category, "个人技术奖");
  assert.equal(state.candidates["cand-zhang-service"].category, "社会服务奖");
});

test("同类别重复提名走吸收归并；跨类别禁止吸收", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  // 张医生被同一类别重复提名了一次
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "cand-zhang-tech-dup",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: { name: "张医生", organization: "第一医院" },
    },
    "第一医院"
  );
  expectError(Errors.VALIDATION, () =>
    api.selection.mergeDuplicateCandidates({
      survivingId: "cand-zhang-tech",
      mergedId: "cand-zhang-service", // 不同类别
      basis: "同人",
      reason: "误并",
    })
  );
  api.selection.mergeDuplicateCandidates(
    {
      survivingId: "cand-zhang-tech",
      mergedId: "cand-zhang-tech-dup",
      basis: "证件号一致+同类别",
      reason: "重复提名，保留先到资格",
    },
    "秘书处"
  );
  const state = api.selection.state();
  assert.equal(state.candidates["cand-zhang-tech-dup"].status, "MERGED");
  assert.equal(state.candidates["cand-zhang-tech-dup"].mergedInto, "cand-zhang-tech");
  assert.equal(state.candidates["cand-zhang-tech"].mergeLog[0].mergedId, "cand-zhang-tech-dup");
});

test("共同成果只申报一次，个人与团队分别说明贡献", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  api.selection.linkTeamMember(
    { teamCandidateId: "cand-team", personCandidateId: "cand-zhang-tech", role: "主刀" },
    "秘书处"
  );
  api.selection.declareAchievement(
    {
      achievementId: "ach-1",
      title: "复杂先心病手术方案",
      summary: "显著降低并发症",
      candidateIds: ["cand-zhang-tech", "cand-team"],
      dedupeKey: "case-2025-先心-007",
    },
    "第一医院"
  );
  api.selection.decideContribution(
    { achievementId: "ach-1", candidateId: "cand-zhang-tech", contribution: "主刀设计并实施术式" },
    "秘书处"
  );
  api.selection.decideContribution(
    { achievementId: "ach-1", candidateId: "cand-team", contribution: "麻醉、护理与术后团队协同" },
    "秘书处"
  );
  // 相同 dedupeKey 再次申报被拒绝，避免重复计入
  expectError(Errors.VALIDATION, () =>
    api.selection.declareAchievement(
      {
        achievementId: "ach-2",
        title: "同一成果换个标题",
        candidateIds: ["cand-team"],
        dedupeKey: "case-2025-先心-007",
      },
      "团队"
    )
  );
  const state = api.selection.state();
  assert.equal(Object.keys(state.achievements).length, 1);
  assert.ok(state.achievements["ach-1"].credits["cand-zhang-tech"].contribution.includes("主刀"));
});

test("证据提交有原件哈希；更正保留原件与理由；受截止时间约束", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  api.selection.submitEvidence(
    {
      evidenceId: "ev-1",
      candidateId: "cand-zhang-tech",
      evidenceType: "手术记录",
      source: "第一医院病案室",
      content: "原始病历扫描件内容",
    },
    "第一医院"
  );
  const original = api.selection.state().evidences["ev-1"].versions[0].hash;

  // 无理由更正被拒绝
  expectError(Errors.VALIDATION, () =>
    api.selection.amendEvidence({ evidenceId: "ev-1", content: "新内容", reason: "  " }, "第一医院")
  );

  // 超过补充材料截止时间
  api.clock.set("2026-04-06T00:00:00.000Z");
  expectError(Errors.DEADLINE, () =>
    api.selection.amendEvidence(
      { evidenceId: "ev-1", content: "新内容", reason: "补录页码", label: "修订版1" },
      "第一医院"
    )
  );

  api.clock.set("2026-04-03T00:00:00.000Z");
  api.selection.amendEvidence(
    { evidenceId: "ev-1", content: "修订后的内容", reason: "病案室补正页码与日期", label: "修订版1" },
    "第一医院"
  );
  const ev = api.selection.state().evidences["ev-1"];
  assert.equal(ev.versions.length, 2);
  assert.equal(ev.versions[0].hash, original, "原件哈希必须保留");
  assert.notEqual(ev.versions[1].hash, original);
  assert.equal(ev.versions[1].reason, "病案室补正页码与日期");
});

test("证据首次提交也受提交截止时间约束", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  api.clock.set("2026-04-02T00:00:00.000Z");
  expectError(Errors.DEADLINE, () =>
    api.selection.submitEvidence(
      {
        evidenceId: "ev-late",
        candidateId: "cand-li-tech",
        evidenceType: "证明",
        source: "单位",
        content: "迟到的材料",
      },
      "单位"
    )
  );
});

test("候选本人确认公开范围，未授权板块不进入公示", () => {
  const api = setup();
  startEdition(api);
  nominateAll(api);
  api.selection.setCandidateConsent(
    {
      candidateId: "cand-zhang-tech",
      sections: [ConsentSection.BASIC, ConsentSection.ACHIEVEMENTS],
      scopeNote: "不公开推荐单位",
    },
    "张医生"
  );
  const state = api.selection.state();
  assert.deepEqual(state.consents["cand-zhang-tech"].sections, [
    ConsentSection.BASIC,
    ConsentSection.ACHIEVEMENTS,
  ]);
  expectError(Errors.VALIDATION, () =>
    api.selection.setCandidateConsent(
      { candidateId: "cand-zhang-tech", sections: ["not-a-section"] },
      "张医生"
    )
  );
});
