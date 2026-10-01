import test from "node:test";

import { assert, setup, startEdition, expectError, Errors, Stage } from "./helpers/setup.js";
import { hasConflict, tallyCandidate } from "../src/index.js";

/**
 * 构造进入专业评议阶段的局面：
 * - 张医生两条候选（个人技术 / 社会服务）已归并到同一自然人；
 * - 李医生一条个人技术候选；团队一条；
 * - 证据已核验、事实门槛通过。
 */
function prepareReview(api) {
  startEdition(api);
  const { selection, review } = api;
  selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "zhang-tech",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: { name: "张医生", title: "主任医师", organization: "第一医院" },
    },
    "第一医院"
  );
  selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "zhang-service",
      candidateType: "PERSON",
      category: "社会服务奖",
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: { name: "张医生", organization: "第一医院" },
    },
    "第一医院"
  );
  selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "li-tech",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "org-clinic",
      nominatorName: "城南门诊",
      profile: { name: "李医生", organization: "城南门诊" },
    },
    "城南门诊"
  );
  selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "team-1",
      candidateType: "TEAM",
      category: "金牌团队奖",
      nominatorId: "org-society",
      nominatorName: "行业学会",
      profile: { name: "心外团队", organization: "第一医院" },
      teamContact: "王主任",
    },
    "行业学会"
  );
  selection.resolveIdentity(
    {
      personId: "person-zhang",
      name: "张医生",
      links: [
        { candidateId: "zhang-tech", basis: "证件号哈希一致", reason: "同人" },
        { candidateId: "zhang-service", basis: "证件号哈希一致", reason: "同人" },
      ],
    },
    "秘书处"
  );
  selection.linkTeamMember(
    { teamCandidateId: "team-1", personCandidateId: "zhang-tech", role: "主刀" },
    "秘书处"
  );
  // 证据
  for (const [id, candidateId] of [
    ["ev-z1", "zhang-tech"],
    ["ev-z2", "zhang-service"],
    ["ev-l1", "li-tech"],
    ["ev-t1", "team-1"],
  ]) {
    selection.submitEvidence(
      {
        evidenceId: id,
        candidateId,
        evidenceType: "服务记录",
        source: "病案室",
        content: `原件-${id}`,
      },
      "推荐机构"
    );
  }
  selection.advanceStage("E1", Stage.FACT_CHECK, "组委会");
  for (const id of ["ev-z1", "ev-z2", "ev-l1", "ev-t1"]) {
    selection.recordFactVerdict({ evidenceId: id, verdict: "VERIFIED", note: "属实" }, "事实核验组");
  }
  for (const candidateId of ["zhang-tech", "zhang-service", "li-tech", "team-1"]) {
    review.decideFactEligibility(
      {
        candidateId,
        decision: "ENTERS_REVIEW",
        evidenceIds: [`ev-${candidateId === "zhang-tech" ? "z1" : candidateId === "zhang-service" ? "z2" : candidateId === "li-tech" ? "l1" : "t1"}`],
      },
      "事实核验组"
    );
  }
  // 评委：r-coi 与第一医院有合作；r-a / r-b / r-c 无涉
  review.registerReviewer({ reviewerId: "r-coi", name: "陈评委", organization: "第一医院合作实验室" });
  review.registerReviewer({ reviewerId: "r-a", name: "甲评委" });
  review.registerReviewer({ reviewerId: "r-b", name: "乙评委" });
  review.registerReviewer({ reviewerId: "r-c", name: "丙评委" });
  review.declareCOI(
    { reviewerId: "r-coi", scope: { nominatorId: "org-hospital" }, reason: "与第一医院有在研合作项目" },
    "r-coi"
  );
  selection.advanceStage("E1", Stage.PROFESSIONAL_REVIEW, "组委会");
}

test("利益冲突：与推荐单位有合作的评委对该医生的所有候选（含跨类别）与相关团队均回避", () => {
  const api = setup();
  prepareReview(api);
  const state = api.review.state();
  assert.equal(hasConflict(state, "r-coi", "zhang-tech"), true);
  assert.equal(hasConflict(state, "r-coi", "zhang-service"), true, "社会服务类别同样回避");
  // 团队成员（张医生）回避传导到团队
  assert.equal(hasConflict(state, "r-coi", "team-1"), true, "团队成员冲突传导到团队");
  // 城南门诊提名的李医生不受影响
  assert.equal(hasConflict(state, "r-coi", "li-tech"), false);
});

test("回避评委既不能查看材料也不能评分", () => {
  const api = setup();
  prepareReview(api);
  expectError(Errors.CONFLICT, () => api.review.viewCandidateMaterial("r-coi", "zhang-tech"));
  expectError(Errors.CONFLICT, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 95 },
      "r-coi"
    )
  );
  // 无冲突评委可查看
  const material = api.review.viewCandidateMaterial("r-a", "zhang-tech");
  assert.equal(material.candidateId, "zhang-tech");
});

test("撤回回避声明须秘书处留痕，撤回后恢复权限", () => {
  const api = setup();
  prepareReview(api);
  const declarationId = api.review.state().cois[0].declarationId;
  expectError(Errors.VALIDATION, () =>
    api.review.withdrawCOI({ declarationId, reason: " " }, "秘书处")
  );
  api.review.withdrawCOI({ declarationId, reason: "核实合作项目已于上年度结题，误报" }, "秘书处");
  assert.equal(hasConflict(api.review.state(), "r-coi", "zhang-tech"), false);
});

test("评审阶段证据被更正：既有核验与入围失效，重新核验前不能评分，重作后恢复", () => {
  const api = setup();
  prepareReview(api);
  // 专业轮进行中，团队证据在补充截止前被更正
  api.clock.set("2026-04-02T00:00:00.000Z");
  api.selection.amendEvidence(
    { evidenceId: "ev-t1", content: "原件-ev-t1-补页码", reason: "病案室补正页码", label: "修订版1" },
    "推荐机构"
  );
  const state1 = api.review.state();
  assert.equal(state1.evidences["ev-t1"].state, "SUBMITTED", "更正后核验结论失效");
  assert.equal(state1.factEligibility["team-1"].decision, "PENDING_RECHECK");

  // 未重新核验前评分被拒
  expectError(Errors.STATE, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 80 },
      "r-a"
    )
  );
  // 评审阶段仅受理被更正证据的重新核验；不能对未更正证据重作初次结论
  api.selection.recordFactVerdict(
    { evidenceId: "ev-t1", verdict: "VERIFIED", note: "修订版复核属实" },
    "事实核验组"
  );
  api.review.decideFactEligibility(
    { candidateId: "team-1", decision: "ENTERS_REVIEW", evidenceIds: ["ev-t1"], note: "重新核验后入围" },
    "事实核验组"
  );
  // 恢复评分权（无冲突评委）
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 82 },
    "r-a"
  );
  const eligibility = api.review.state().factEligibility["team-1"];
  assert.equal(eligibility.decision, "ENTERS_REVIEW");
  assert.ok(eligibility.history.length >= 1, "前次入围结论保留在历史中");
});

test("未通过事实核验不能评分", () => {
  const api = setup();
  startEdition(api);
  api.selection.submitNomination(
    {
      editionId: "E1",
      candidateId: "c1",
      candidateType: "PERSON",
      category: "个人技术奖",
      nominatorId: "o1",
      nominatorName: "单位",
      profile: { name: "赵医生" },
    },
    "单位"
  );
  api.selection.advanceStage("E1", Stage.FACT_CHECK, "组委会");
  api.selection.advanceStage("E1", Stage.PROFESSIONAL_REVIEW, "组委会");
  api.review.registerReviewer({ reviewerId: "r1", name: "评委" });
  expectError(Errors.STATE, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "c1", value: 80 },
      "r1"
    )
  );
});

test("弃权必须留理由且不折算低分；回避票也不进入分母", () => {
  const api = setup();
  prepareReview(api);
  expectError(Errors.VALIDATION, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", abstain: true, abstainReason: " " },
      "r-a"
    )
  );
  // r-a 弃权；r-b、r-c 给李医生打分；r-coi 对李无冲突但也弃权
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", abstain: true, abstainReason: "不熟悉该亚专业" },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 80 },
    "r-b"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 90 },
    "r-c"
  );
  const tally = tallyCandidate(
    api.review.state(),
    "R_PRO",
    "li-tech"
  );
  assert.equal(tally.validVotes, 2, "弃权票不计入有效票");
  assert.equal(tally.mean, 85);
  assert.deepEqual(tally.abstainedReviewers, ["r-a"]);
});

test("张医生在专业轮：合作评委被排除，只由无冲突评委计分", () => {
  const api = setup();
  prepareReview(api);
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 70 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 80 },
    "r-b"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 90 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 90 },
    "r-b"
  );
  // 若错误地把 r-coi 当 0 分，张的平均会被拉低；正确结果为 75
  const zhang = tallyCandidate(api.review.state(), "R_PRO", "zhang-tech");
  assert.deepEqual(zhang.recusedReviewers, ["r-coi"]);
  assert.equal(zhang.mean, 75);
  assert.equal(zhang.validVotes, 2);
});

test("投票以首次为准，不能重复投票或改票", () => {
  const api = setup();
  prepareReview(api);
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 80 },
    "r-a"
  );
  expectError(Errors.SEALED, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 99 },
      "r-a"
    )
  );
});

test("并列：未处置跨名额线并列时拒绝计票；按冻结规则或委员会裁定后通过", () => {
  const api = setup();
  prepareReview(api);
  // 张、李在个人技术奖打成 90:90，名额仅 1
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 90 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 90 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 90 },
    "r-b"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 90 },
    "r-b"
  );
  // 团队与社会服务类别也给票，避免该轮无胜者（不影响个人技术奖并列）
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 80 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-service", value: 80 },
    "r-a"
  );
  expectError(Errors.TIE, () => api.review.recordRoundResult("E1", "R_PRO", "监票组"));

  // RULE 方式必须引用冻结 tieRule 中存在的顺位键
  expectError(Errors.VALIDATION, () =>
    api.review.resolveTie(
      {
        roundId: "R_PRO",
        tiedCandidateIds: ["zhang-tech", "li-tech"],
        winnerIds: ["li-tech"],
        method: "RULE",
        ruleCited: "coinFlip",
        reason: "掷币",
      },
      "评审委员会"
    )
  );
  api.review.resolveTie(
    {
      roundId: "R_PRO",
      tiedCandidateIds: ["zhang-tech", "li-tech"],
      winnerIds: ["li-tech"],
      method: "RULE",
      ruleCited: "factVote",
      reason: "冻结顺位：事实核验一致时比较从医年限，李医生年限更长",
      approver: "评审委员会主席",
    },
    "评审委员会"
  );
  const result = api.review.recordRoundResult("E1", "R_PRO", "监票组");
  assert.ok(result.winners.includes("li-tech"));
  assert.ok(!result.winners.includes("zhang-tech"));
  assert.ok(result.winners.includes("team-1"));
  assert.ok(result.winners.includes("zhang-service"));
});

test("委员会裁定并列必须有批准人；封存后评分通道关闭", () => {
  const api = setup();
  prepareReview(api);
  for (const [c, v] of [
    ["zhang-tech", 90],
    ["li-tech", 90],
  ]) {
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: c, value: v },
      "r-a"
    );
  }
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 70 },
    "r-a"
  );
  api.review.submitScore(
    { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-service", value: 70 },
    "r-a"
  );
  expectError(Errors.VALIDATION, () =>
    api.review.resolveTie(
      {
        roundId: "R_PRO",
        tiedCandidateIds: ["zhang-tech", "li-tech"],
        winnerIds: ["zhang-tech"],
        method: "COMMITTEE",
        reason: "综合考量",
      },
      "评审委员会"
    )
  );
  api.review.resolveTie(
    {
      roundId: "R_PRO",
      tiedCandidateIds: ["zhang-tech", "li-tech"],
      winnerIds: ["zhang-tech"],
      method: "COMMITTEE",
      reason: "委员会无记名表决，张医生入选",
      approver: "评审委员会主席",
    },
    "评审委员会"
  );
  api.review.recordRoundResult("E1", "R_PRO", "监票组");
  // 封存后禁止再投票
  expectError(Errors.SEALED, () =>
    api.review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 50 },
      "r-b"
    )
  );
  // 禁止重复计票
  expectError(Errors.SEALED, () => api.review.recordRoundResult("E1", "R_PRO", "监票组"));
});
