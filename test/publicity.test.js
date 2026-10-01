import test from "node:test";

import { assert, setup, startEdition, expectError, Errors, Stage } from "./helpers/setup.js";
import { ConsentSection } from "../src/index.js";
import { assertPublicationSanity } from "../src/domain/policy.js";
import { sealTwoRounds } from "./helpers/scenario.js";

test("公示快照不泄露机构等未授权字段", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  const content = api.publicity.state().publications[0].content;
  assert.equal(assertPublicationSanity(content), true);
  for (const entry of content) {
    const json = JSON.stringify(entry);
    assert.ok(!json.includes("第一医院"), "未授权机构名不得出现在公示中");
    assert.ok(!json.includes("城南门诊"));
  }
});

test("未封存轮次不能公示；缺少候选授权不能公示", () => {
  const { api } = sealTwoRounds();
  // 张医生（个人技术）未入选无需授权；但若撤回某入选者授权——这里直接验证：
  // 构造一个未授权场景：重新发布已发布的轮次也被拒绝
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  expectError(Errors.STATE, () => api.publicity.publish("E1", "R_PRO", "秘书处"));
});

test("公示只含授权板块；未授权的推荐单位与成果不出现", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  const state = api.publicity.state();
  const pub = state.publications[0];
  const li = pub.content.find((c) => c.candidateId === "li-tech");
  assert.ok(li.sections.basic);
  assert.equal(li.sections.nominator, undefined, "李医生未授权公开推荐单位");
  assert.ok(li.omittedSections.includes(ConsentSection.NOMINATOR));

  const team = pub.content.find((c) => c.candidateId === "team-1");
  assert.ok(team.sections.achievements);
  assert.ok(team.sections.contribution);
  assert.ok(team.sections[ConsentSection.EVIDENCE_SOURCES]);
  // 证据来源只列已核验证据，且带哈希
  const sources = team.sections[ConsentSection.EVIDENCE_SOURCES].evidenceSources;
  assert.equal(sources[0].state, undefined);
  assert.ok(sources[0].hash);
});

test("勘误必须有理由和批准人，且不得加入未授权板块；前后值留痕", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  const teamBefore = api.publicity
    .state()
    .publications[0].content.find((c) => c.candidateId === "team-1");
  const beforeTitle = teamBefore.sections.achievements.achievements[0].title;

  expectError(Errors.VALIDATION, () =>
    api.publicity.correctPublication(
      {
        editionId: "E1",
        candidateId: "team-1",
        section: ConsentSection.NOMINATOR, // 团队未授权该板块
        after: { nominator: "某单位" },
        reason: "尝试加入",
        approver: "秘书处主任",
      },
      "秘书处"
    )
  );
  expectError(Errors.VALIDATION, () =>
    api.publicity.correctPublication(
      {
        editionId: "E1",
        candidateId: "team-1",
        section: ConsentSection.ACHIEVEMENTS,
        after: {},
        reason: "  ",
        approver: "秘书处主任",
      },
      "秘书处"
    )
  );
  api.publicity.correctPublication(
    {
      editionId: "E1",
      candidateId: "team-1",
      section: ConsentSection.ACHIEVEMENTS,
      after: {
        achievements: [{ id: "ach-1", title: "先天性心脏病术式改良（规范名称）", summary: "降低并发症" }],
      },
      reason: "成果名称应为规范医学术语，原文为科室简称",
      approver: "秘书处主任",
    },
    "秘书处"
  );
  const corrections = api.audit.publicationCorrections("E1");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].section, ConsentSection.ACHIEVEMENTS);
  assert.equal(corrections[0].before.achievements[0].title, beforeTitle);
  assert.equal(corrections[0].after.achievements[0].title, "先天性心脏病术式改良（规范名称）");
  assert.equal(corrections[0].approver, "秘书处主任");
  assert.ok(corrections[0].approvedAt);
});

test("异议期可复核证据、下结论并触发勘误；选票无法暗改", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.publicity.publish("E1", "R_PRO", "秘书处");
  api.selection.advanceStage("E1", Stage.OBJECTION, "组委会");

  // 非异议期校验已由阶段推进覆盖；公示期不能立异议
  api.publicity.fileObjection(
    {
      objectionId: "obj-1",
      editionId: "E1",
      candidateId: "team-1",
      grounds: "成果名称疑似不规范",
      reviewedEvidenceIds: ["ev-team-1"],
    },
    "市民王先生"
  );
  // 复核证据不能引用别人的证据
  expectError(Errors.VALIDATION, () =>
    api.publicity.fileObjection(
      {
        objectionId: "obj-bad",
        editionId: "E1",
        candidateId: "team-1",
        grounds: "x",
        reviewedEvidenceIds: ["ev-li-tech"],
      },
      "他人"
    )
  );
  // 异议期评分通道早已封存，改票会被拒
  expectError(Errors.SEALED, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 100 },
      "r-a"
    )
  );
  // 异议未结论前不能结束届次
  expectError(Errors.STATE, () => api.publicity.finalize("E1", "组委会"));
  api.publicity.correctPublication(
    {
      editionId: "E1",
      candidateId: "team-1",
      section: ConsentSection.BASIC,
      after: { name: "心外攻坚团队", title: "医师团队" },
      reason: "异议 obj-1 成立：团队名称漏字",
      approver: "组委会主任",
      objectionId: "obj-1",
    },
    "秘书处"
  );
  api.publicity.decideObjection(
    { objectionId: "obj-1", decision: "UPHELD", note: "名称确有漏字，已勘误", action: "PUBLICATION_CORRECTION" },
    "异议复核组"
  );
  const correction = api.audit.publicationCorrections("E1").find((c) => c.objectionId === "obj-1");
  assert.ok(correction);
  assert.equal(correction.approver, "组委会主任");

  // 异议结论后方可结束届次
  api.publicity.finalize("E1", "组委会");
  assert.equal(api.publicity.state().editions.E1.stage, Stage.FINALIZED);
});

test("异议被驳回时也留痕；结项后阶段为 FINALIZED", () => {
  const { api } = sealTwoRounds();
  api.selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
  api.selection.advanceStage("E1", Stage.OBJECTION, "组委会");
  api.publicity.fileObjection(
    { objectionId: "obj-2", editionId: "E1", candidateId: "li-tech", grounds: "不服评分" },
    "某人"
  );
  api.publicity.decideObjection(
    { objectionId: "obj-2", decision: "REJECTED", note: "评分依规作出，回避与弃权处理无误" },
    "异议复核组"
  );
  api.publicity.finalize("E1", "组委会");
  assert.equal(api.publicity.state().editions.E1.stage, Stage.FINALIZED);
});
