#!/usr/bin/env node
/**
 * 端到端演示：秘书处关注的三件事——
 *  1) 同医生多类别提名归并 + 合作评委回避如何影响计票；
 *  2) 任一历史轮次如何复现、选票指纹是否一致；
 *  3) 公示勘误前后改了什么、由谁批准。
 * 运行：node examples/walkthrough.js
 */
import { createHonorsBackend, Stage, ConsentSection } from "../src/index.js";

const clock = (() => {
  let t = Date.parse("2026-03-01T08:00:00Z");
  return () => new Date((t += 1000)).toISOString();
})();
const api = createHonorsBackend({ clock });
const { selection, review, publicity, audit } = api;

selection.createEdition({ editionId: "E1", name: "2026 年度医者荣誉", year: 2026 }, "组委会");
selection.freezeRules(
  "E1",
  {
    categories: ["个人技术奖", "社会服务奖", "金牌团队奖"],
    quotas: { 个人技术奖: 1, 社会服务奖: 1, 金牌团队奖: 1 },
    rounds: [
      { roundId: "R_PRO", name: "专业评议", stage: Stage.PROFESSIONAL_REVIEW, scoring: { min: 0, max: 100 } },
      { roundId: "R_SOC", name: "社会责任审议", stage: Stage.SOCIAL_REVIEW, scoring: { min: 0, max: 100 } },
    ],
    tieRule: "SEQUENCE:factVote,seniority",
    deadlines: {
      evidence: "2026-04-01T00:00:00Z",
      evidenceSupplement: "2026-04-05T00:00:00Z",
    },
  },
  "组委会"
);
selection.advanceStage("E1", Stage.NOMINATION, "组委会");

// 同一医生被医院拆成个人技术、社会服务两条提名；另加团队
for (const [id, category, type, contact] of [
  ["zhang-tech", "个人技术奖", "PERSON", null],
  ["zhang-service", "社会服务奖", "PERSON", null],
  ["team-1", "金牌团队奖", "TEAM", "王主任"],
]) {
  selection.submitNomination(
    {
      editionId: "E1",
      candidateId: id,
      candidateType: type,
      category,
      nominatorId: "org-hospital",
      nominatorName: "第一医院",
      profile: {
        name: id === "team-1" ? "心外团队" : "张医生",
        title: "主任医师",
        organization: "第一医院",
      },
      teamContact: contact,
    },
    "第一医院"
  );
}

// 人工归并身份：两条提名是同一自然人，但候选资格独立
selection.resolveIdentity(
  {
    personId: "p-zhang",
    name: "张医生",
    credentialHash: "sha256-of-credential",
    links: [
      { candidateId: "zhang-tech", basis: "证件号哈希一致", reason: "同名同人" },
      { candidateId: "zhang-service", basis: "证件号哈希一致", reason: "同名同人" },
    ],
  },
  "秘书处"
);
selection.linkTeamMember({ teamCandidateId: "team-1", personCandidateId: "zhang-tech", role: "主刀" }, "秘书处");

// 共同成果只报一次，分别说明贡献
selection.declareAchievement(
  {
    achievementId: "ach-1",
    title: "先心术式改良",
    candidateIds: ["zhang-tech", "team-1"],
    dedupeKey: "case-007",
  },
  "第一医院"
);
selection.decideContribution({ achievementId: "ach-1", candidateId: "zhang-tech", contribution: "术式设计与主刀" }, "秘书处");
selection.decideContribution({ achievementId: "ach-1", candidateId: "team-1", contribution: "团队围术期协同" }, "秘书处");

// 证据与事实核验
selection.advanceStage("E1", Stage.FACT_CHECK, "组委会");
for (const id of ["zhang-tech", "zhang-service", "team-1"]) {
  selection.submitEvidence(
    { evidenceId: `ev-${id}`, candidateId: id, evidenceType: "服务记录", source: "病案室", content: `原件-${id}` },
    "第一医院"
  );
  selection.recordFactVerdict({ evidenceId: `ev-${id}`, verdict: "VERIFIED" }, "事实核验组");
  review.decideFactEligibility(
    { candidateId: id, decision: "ENTERS_REVIEW", evidenceIds: [`ev-${id}`] },
    "事实核验组"
  );
}

// 评委：陈评委与第一医院有合作 → 声明回避
review.registerReviewer({ reviewerId: "r-chen", name: "陈评委", organization: "第一医院合作实验室" });
review.registerReviewer({ reviewerId: "r-a", name: "甲评委" });
review.registerReviewer({ reviewerId: "r-b", name: "乙评委" });
review.declareCOI({ reviewerId: "r-chen", scope: { nominatorId: "org-hospital" }, reason: "与第一医院有在研合作" }, "r-chen");

// 两轮评分
selection.advanceStage("E1", Stage.PROFESSIONAL_REVIEW, "组委会");
for (const r of ["r-a", "r-b"]) {
  review.submitScore({ editionId: "E1", roundId: "R_PRO", candidateId: "zhang-tech", value: 90 }, r);
  review.submitScore({ editionId: "E1", roundId: "R_PRO", candidateId: "team-1", value: 88 }, r);
}
selection.advanceStage("E1", Stage.SOCIAL_REVIEW, "组委会");
for (const r of ["r-a", "r-b"]) {
  review.submitScore({ editionId: "E1", roundId: "R_SOC", candidateId: "zhang-service", value: 92 }, r);
}

// 封存
selection.advanceStage("E1", Stage.DELIBERATION, "组委会");
const pro = review.recordRoundResult("E1", "R_PRO", "监票组");
review.recordRoundResult("E1", "R_SOC", "监票组");

// 候选授权公开范围
selection.setCandidateConsent(
  { candidateId: "zhang-tech", sections: [ConsentSection.BASIC, ConsentSection.ACHIEVEMENTS, ConsentSection.CONTRIBUTION] },
  "张医生"
);
selection.setCandidateConsent(
  { candidateId: "zhang-service", sections: [ConsentSection.BASIC, ConsentSection.NOMINATOR, ConsentSection.ACHIEVEMENTS] },
  "张医生"
);
selection.setCandidateConsent(
  { candidateId: "team-1", sections: [ConsentSection.BASIC, ConsentSection.ACHIEVEMENTS, ConsentSection.CONTRIBUTION] },
  "王主任"
);

// 公示 → 异议 → 勘误
selection.advanceStage("E1", Stage.PUBLICITY, "组委会");
publicity.publish("E1", "R_SOC", "秘书处");
publicity.publish("E1", "R_PRO", "秘书处");
selection.advanceStage("E1", Stage.OBJECTION, "组委会");
publicity.fileObjection(
  { objectionId: "obj-1", editionId: "E1", candidateId: "team-1", grounds: "团队名称漏字", reviewedEvidenceIds: ["ev-team-1"] },
  "市民"
);
publicity.correctPublication(
  {
    editionId: "E1",
    candidateId: "team-1",
    section: ConsentSection.BASIC,
    after: { name: "心外攻坚团队", title: "主任医师团队" },
    reason: "obj-1 成立：名称漏字",
    approver: "组委会主任",
    objectionId: "obj-1",
  },
  "秘书处"
);
publicity.decideObjection({ objectionId: "obj-1", decision: "UPHELD", note: "已勘误" }, "异议复核组");
publicity.finalize("E1", "组委会");

/* ---------------- 秘书处复现与说明 ---------------- */
console.log("== 完整性 ==");
console.log(audit.verifyIntegrity());

console.log("\n== 专业轮复现 ==");
const replay = audit.replayRound("E1", "R_PRO");
console.log({
  封存人: replay.sealedBy,
  选票指纹一致: replay.scoreSetHashMatches,
  名次一致: replay.rankingsMatch,
  入选: replay.winners,
  回避者: replay.rankings.find((r) => r.candidateId === "zhang-tech").recusedReviewers,
});

console.log("\n== 身份归并轨迹 ==");
console.log(JSON.stringify(audit.identityTrail("p-zhang"), null, 2));

console.log("\n== 公示勘误说明 ==");
for (const c of audit.publicationCorrections("E1")) {
  console.log(`${c.candidateId} 的 ${c.section}：${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
  console.log(`  理由：${c.reason}；批准人：${c.approver}（${c.approvedAt}）；异议：${c.objectionId}`);
}

console.log("\n== 证据原件哈希保留 ==");
const trail = audit.evidenceTrail("ev-team-1");
console.log({ 原件: trail.originalHash, 当前: trail.currentHash, 更正次数: trail.versions.length - 1 });
console.log(`专业轮入选名单：${pro.winners.join("、")}`);
