import { Stage } from "../../src/index.js";
import { ConsentSection } from "../../src/index.js";
import { setup, startEdition } from "./setup.js";

/**
 * 端到端标准局面：
 * 张医生被医院按个人技术、社会服务两条提名（人工归并为同一自然人），
 * 同时是入选团队的主刀；李医生由城南门诊提名个人技术奖。
 * 评委 r-coi 与第一医院（张的推荐单位）有合作并已声明回避。
 * 两轮（专业评议 R_PRO、社会责任审议 R_SOC）评分完成并在 DELIBERATION 封存，
 * 候选已授权公开范围。返回 api 与封存结果。
 */
export function sealTwoRounds() {
  const api = setup();
  startEdition(api);
  const { selection, review } = api;
  const cands = [
    ["zhang-tech", "个人技术奖", "张医生", "第一医院", "org-hospital"],
    ["zhang-service", "社会服务奖", "张医生", "第一医院", "org-hospital"],
    ["li-tech", "个人技术奖", "李医生", "城南门诊", "org-clinic"],
    ["team-1", "金牌团队奖", "心外团队", "第一医院", "org-society"],
  ];
  for (const [id, category, name, org, nominatorId] of cands) {
    selection.submitNomination(
      {
        editionId: "E1",
        candidateId: id,
        candidateType: id === "team-1" ? "TEAM" : "PERSON",
        category,
        nominatorId,
        nominatorName: org,
        profile: { name, title: "医师", organization: org },
        teamContact: id === "team-1" ? "王主任" : null,
      },
      org
    );
  }
  selection.resolveIdentity(
    {
      personId: "p-zhang",
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
  selection.declareAchievement(
    {
      achievementId: "ach-1",
      title: "先心术式改良",
      summary: "降低并发症",
      candidateIds: ["zhang-tech", "team-1"],
      dedupeKey: "ach-key-1",
    },
    "第一医院"
  );
  selection.decideContribution(
    { achievementId: "ach-1", candidateId: "zhang-tech", contribution: "术式设计与主刀" },
    "秘书处"
  );
  selection.decideContribution(
    { achievementId: "ach-1", candidateId: "team-1", contribution: "围术期团队配合" },
    "秘书处"
  );
  selection.advanceStage("E1", Stage.FACT_CHECK, "组委会");
  for (const id of ["zhang-tech", "zhang-service", "li-tech", "team-1"]) {
    selection.submitEvidence(
      {
        evidenceId: `ev-${id}`,
        candidateId: id,
        evidenceType: "服务记录",
        source: "病案室",
        content: `原件-${id}`,
      },
      "推荐机构"
    );
    selection.recordFactVerdict({ evidenceId: `ev-${id}`, verdict: "VERIFIED" }, "事实核验组");
    review.decideFactEligibility(
      { candidateId: id, decision: "ENTERS_REVIEW", evidenceIds: [`ev-${id}`] },
      "事实核验组"
    );
  }
  review.registerReviewer({ reviewerId: "r-a", name: "甲评委" });
  review.registerReviewer({ reviewerId: "r-b", name: "乙评委" });
  review.registerReviewer({ reviewerId: "r-coi", name: "陈评委", organization: "合作实验室" });
  review.declareCOI(
    { reviewerId: "r-coi", scope: { nominatorId: "org-hospital" }, reason: "与第一医院有合作" },
    "r-coi"
  );

  selection.advanceStage("E1", Stage.PROFESSIONAL_REVIEW, "组委会");
  for (const r of ["r-a", "r-b"]) {
    review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "li-tech", value: 95 },
      r
    );
    review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 90 },
      r
    );
    review.submitScore(
      { editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 88 },
      r
    );
  }

  selection.advanceStage("E1", Stage.SOCIAL_REVIEW, "组委会");
  for (const r of ["r-a", "r-b"]) {
    review.submitScore(
      { editionId: "E1", roundId: "R_SOC", candidateId: "zhang-service", value: 92 },
      r
    );
  }

  selection.advanceStage("E1", Stage.DELIBERATION, "组委会");
  const pro = review.recordRoundResult("E1", "R_PRO", "监票组");
  const soc = review.recordRoundResult("E1", "R_SOC", "监票组");

  selection.setCandidateConsent(
    { candidateId: "li-tech", sections: [ConsentSection.BASIC, ConsentSection.ACHIEVEMENTS] },
    "李医生"
  );
  selection.setCandidateConsent(
    { candidateId: "zhang-service", sections: [ConsentSection.BASIC, ConsentSection.NOMINATOR] },
    "张医生"
  );
  selection.setCandidateConsent(
    {
      candidateId: "team-1",
      sections: [
        ConsentSection.BASIC,
        ConsentSection.ACHIEVEMENTS,
        ConsentSection.CONTRIBUTION,
        ConsentSection.EVIDENCE_SOURCES,
      ],
    },
    "王主任"
  );

  return { api, pro, soc };
}
