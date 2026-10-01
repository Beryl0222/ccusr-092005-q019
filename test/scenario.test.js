import assert from "node:assert/strict";
import test from "node:test";

import { SelectionService } from "../src/domain/service.js";
import { fixedClock } from "../src/domain/clock.js";
import { bootstrapFromSeed } from "../src/bootstrap.js";
import { loadSeed } from "../src/seed.js";
import { reproduceRound } from "../src/domain/replay.js";

const SEED_PATH = new URL("../fixtures/seed.json", import.meta.url);

async function setup() {
  const clock = fixedClock("2027-01-10T08:00:00Z");
  const service = new SelectionService({ clock, actor: "secretariat" });
  const seed = await loadSeed(SEED_PATH);
  const summary = await bootstrapFromSeed(service, seed);
  return { service, clock, seed, summary };
}

test("端到端：拆分提名 → 重名归并 → 本人授权 → 三阶段 → 回避计票 → 并列/公示 → 异议复核 → 历史复现", async (t) => {
  const { service, clock } = await setup();

  // 1) 秘书处人工归并：王崇安被两家单位按个人技术与社会服务拆分提名
  service.mergeIdentities(
    { clusterId: "cl-wang", memberCandidateIds: ["cand-wang-tech", "cand-wang-service"], note: "身份证、执业证号核对一致" },
    "staff-li"
  );
  // 本人只同意隐去姓名公开事迹
  service.confirmConsent({ clusterId: "cl-wang", scope: "deeds_only" }, "candidate-wang");
  // 团队单独授权（个人与团队不混并）
  service.confirmConsent({ candidateId: "cand-team-105", scope: "full" }, "candidate-team");

  // 2) 共同成果只计入一方，避免个人条目与团队条目重复计入
  service.allocateSharedWork({ workId: "work-stroke-path", countedForCandidateId: "cand-team-105", note: "核验为团队落地成效" });

  // 3) 事实核验阶段：更正证明但原件哈希保留
  service.openStage("fact_check");
  for (const id of ["cand-wang-tech", "cand-wang-service", "cand-team-105", "cand-li"]) {
    service.recordStageVerdict({ stage: "fact_check", candidateId: id, verdict: "pass" });
  }
  service.correctEvidence(
    { evidenceId: "ev-tech-wang", newContentHash: "sha256:corrected-version-2", reason: "鉴定机构重发勘误页，更正落款文号" },
    "staff-li"
  );
  const ev = service.state().evidences["ev-tech-wang"];
  assert.equal(ev.originalHash.startsWith("sha256:9f2c"), true);
  assert.equal(ev.currentHash, "sha256:corrected-version-2");
  assert.equal(ev.corrections[0].reason.includes("落款文号"), true);
  service.completeStage("fact_check");

  // 4) 专业评议阶段：评委陈述与市第一中心医院（nom-central）有课题合作 → 回避
  service.openStage("professional_review");
  const rp = "r-professional";
  for (const j of ["judge-chen", "judge-zhao", "judge-sun"]) {
    service.assignJudge({ roundId: rp, judgeId: j });
  }
  service.declareCOI(
    { declarationId: "coi-chen-central", judgeId: "judge-chen", targetType: "nominator", targetId: "nom-central", scope: "recuse", relation: "在研课题合作" },
    "judge-chen"
  );
  service.declareCOI({ declarationId: "coi-chen-li", judgeId: "judge-chen", targetType: "candidate", targetId: "cand-li", scope: "none" }, "judge-chen");
  service.declareCOI({ declarationId: "coi-chen-team", judgeId: "judge-chen", targetType: "candidate", targetId: "cand-team-105", scope: "none" }, "judge-chen");
  for (const [j, list] of [
    ["judge-zhao", ["cand-wang-tech", "cand-li", "cand-team-105"]],
    ["judge-sun", ["cand-wang-tech", "cand-li", "cand-team-105"]],
  ]) {
    for (const c of list) {
      service.declareCOI({ declarationId: `coi-${j}-${c}`, judgeId: j, targetType: "candidate", targetId: c, scope: "none" }, j);
    }
  }
  // 回避评委看不到王崇安技术条目
  assert.equal(service.judgeViewForCandidate("judge-chen", "cand-wang-tech").visible, false);

  service.openRound(rp);
  // 王崇安（技术）：陈述回避，仅赵/孙打分
  service.castBallot({ roundId: rp, judgeId: "judge-zhao", candidateId: "cand-wang-tech", verdict: "score", score: 88 }, "judge-zhao");
  service.castBallot({ roundId: rp, judgeId: "judge-sun", candidateId: "cand-wang-tech", verdict: "score", score: 92 }, "judge-sun");
  // 李沐晴：三人打分
  service.castBallot({ roundId: rp, judgeId: "judge-chen", candidateId: "cand-li", verdict: "score", score: 70 }, "judge-chen");
  service.castBallot({ roundId: rp, judgeId: "judge-zhao", candidateId: "cand-li", verdict: "abstain" }, "judge-zhao"); // 赵了解不深，弃权
  service.castBallot({ roundId: rp, judgeId: "judge-sun", candidateId: "cand-li", verdict: "score", score: 80 }, "judge-sun");
  // 团队：三人打分
  service.castBallot({ roundId: rp, judgeId: "judge-chen", candidateId: "cand-team-105", verdict: "score", score: 85 }, "judge-chen");
  service.castBallot({ roundId: rp, judgeId: "judge-zhao", candidateId: "cand-team-105", verdict: "score", score: 90 }, "judge-zhao");
  service.castBallot({ roundId: rp, judgeId: "judge-sun", candidateId: "cand-team-105", verdict: "score", score: 88 }, "judge-sun");

  service.closeRound(rp);
  const result = service.countRound(rp);
  // 王崇安均分 90（分母是 2，陈述的回避没有折算成 0）
  assert.equal(result.perCandidate["cand-wang-tech"].average, 90);
  assert.equal(result.perCandidate["cand-wang-tech"].excludedCount, 1);
  // 李沐晴：赵的弃权不进分母 → (70+80)/2 = 75
  assert.equal(result.perCandidate["cand-li"].average, 75);
  assert.equal(result.perCandidate["cand-li"].abstainCount, 1);
  assert.deepEqual(result.ties, []);

  const winners1 = service.awardeesOf(rp).map((a) => a.candidateId).sort();
  assert.deepEqual(winners1, ["cand-team-105", "cand-wang-tech"]);

  // 5) 公示：仅展示授权内容。王崇安隐名，团队完整公开
  const pub1 = service.publishRound(rp);
  assert.deepEqual(pub1.published.sort(), ["pub-r-professional-cand-team-105", "pub-r-professional-cand-wang-tech"]);
  const wangPub = service.state().publications["pub-r-professional-cand-wang-tech"].snapshot;
  assert.match(wangPub.publishedFrom.identity.name, /隐去姓名/);
  assert.equal(wangPub.publishedFrom.deeds.includes("卒中"), true);
  service.verifyBallotsIntact(rp);

  // 6) 社会责任终审轮（社会服务类别）
  service.completeStage("professional_review");
  service.openStage("social_responsibility_review");
  const rf = "r-final";
  service.assignJudge({ roundId: rf, judgeId: "judge-zhao" });
  service.assignJudge({ roundId: rf, judgeId: "judge-sun" });
  for (const j of ["judge-zhao", "judge-sun"]) {
    service.declareCOI({ declarationId: `coi-${j}-wang-service`, judgeId: j, targetType: "candidate", targetId: "cand-wang-service", scope: "none" }, j);
  }
  service.openRound(rf);
  service.castBallot({ roundId: rf, judgeId: "judge-zhao", candidateId: "cand-wang-service", verdict: "score", score: 90 }, "judge-zhao");
  service.castBallot({ roundId: rf, judgeId: "judge-sun", candidateId: "cand-wang-service", verdict: "score", score: 93 }, "judge-sun");
  service.closeRound(rf);
  service.countRound(rf);
  const pub2 = service.publishRound(rf);
  assert.deepEqual(pub2.published, ["pub-r-final-cand-wang-service"]);
  service.verifyBallotsIntact(rf);

  const seqAfterFinalPublish = service.journal.length;

  // 7) 异议期：可复核证据，但任何改动都要批准；选票不得暗改
  service.openObjectionPeriod({ deadline: "2027-06-01T00:00:00Z" });
  service.requestEvidenceReview({ candidateId: "cand-wang-service", scope: "all" }, "objector-007");
  service.closeEvidenceReview({ candidateId: "cand-wang-service", conclusion: "台账原件哈希与备案一致，异议不成立" }, "staff-li");
  // 异议期内无批准的更正被拒
  assert.throws(
    () => service.correctEvidence({ evidenceId: "ev-service-wang", newContentHash: "sha256:hacked", reason: "x" }),
    /批准/
  );
  // 公示勘误：批准后留痕，公众可查前后差异与批准人
  service.grantApproval({ approvalId: "ap-pub-team", action: "publication_correction", targetId: "pub-r-professional-cand-team-105", reason: "机构名称表述勘误" }, "chair");
  const teamSnapshot = service.state().publications["pub-r-professional-cand-team-105"].snapshot;
  service.correctPublication(
    {
      publicationId: "pub-r-professional-cand-team-105",
      changes: { publishedFrom: { ...teamSnapshot.publishedFrom, identity: { name: "心脑血管联合救治团队", affiliation: "市第一中心医院（规范名称）" } } },
      reason: "机构名称表述勘误",
      approvalId: "ap-pub-team",
    },
    "staff-li"
  );
  const diff = service.publicationDiff("pub-r-professional-cand-team-105");
  assert.equal(diff.corrections[0].approvedBy, "chair");
  assert.ok(JSON.stringify(diff.corrections[0].diff).includes("规范名称"));
  service.closeObjectionPeriod();

  // 8) 全程哈希链完好；选票摘要复核一致
  assert.equal(service.journal.verify().ok, true);
  assert.equal(service.verifyBallotsIntact(rp).intact, true);
  assert.equal(service.verifyBallotsIntact(rf).intact, true);

  // 9) 历史复现：终审公示之前，r-final 无公示；复现 r-professional 结果不变
  const historical = reproduceRound(service.journal.events, rf, seqAfterFinalPublish - 1);
  assert.deepEqual(historical.publications, []);
  const pro = reproduceRound(service.journal.events, rp);
  assert.equal(pro.result.perCandidate.find((r) => r.candidateId === "cand-wang-tech").average, 90);
  assert.equal(pro.publications.find((p) => p.id === "pub-r-professional-cand-team-105").corrections, 1);
  assert.equal(pro.edition.rulesVersion, "2027.1");
});

test("端到端种子：引导结果包含全部基线记录标识", async () => {
  const { summary } = await setup();
  assert.equal(summary.candidates.length, 4);
  assert.equal(summary.evidences.length, 5);
  assert.equal(summary.sharedWorks.length, 1);
  assert.equal(summary.judges.length, 3);
  assert.equal(summary.rules.categories.length, 3);
});
