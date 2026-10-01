import { SelectionService } from "../src/domain/service.js";
import { fixedClock } from "../src/domain/clock.js";

export const RULES = {
  categories: [
    { id: "catA", name: "甲类奖", quota: 1 },
    { id: "catB", name: "乙类奖", quota: 2 },
  ],
  rounds: [
    { id: "r1", name: "专业评议轮", stage: "professional_review" },
    { id: "r2", name: "终审轮", stage: "social_responsibility_review" },
  ],
  scoreRange: { min: 0, max: 100 },
  deadlines: { nomination: "2030-03-01T00:00:00Z", supplements: "2030-04-15T00:00:00Z" },
};

export function makeService(iso = "2030-02-01T08:00:00Z") {
  const clock = fixedClock(iso);
  const service = new SelectionService({ clock, actor: "secretariat" });
  return { service, clock };
}

export function startEdition(service, rules = RULES) {
  service.defineRules({ version: "t1", rules });
  service.openEdition({ editionId: "ed-test", name: "测试届" }, "secretariat");
}

export function registerNominator(service, id = "nom-1", name = "第一医院") {
  service.registerNominator({ nominatorId: id, name, type: "hospital" }, "secretariat");
}

export function registerJudge(service, id, name = id, organization = "某机构") {
  service.registerJudge({ judgeId: id, name, organization }, "secretariat");
}

export function submitCandidate(service, { id, nominatorId = "nom-1", categoryId = "catA", candidateType = "person", rawName = "张某" } = {}) {
  service.submitCandidate(
    {
      candidateId: id,
      nominatorId,
      rawName,
      affiliation: "第一医院",
      candidateType,
      categoryId,
      deedsSummary: "事迹摘要",
      contributionNote: "",
    },
    nominatorId
  );
}

/** 推进到指定轮次可投票状态：fact_check → professional_review（→终审轮前置）。 */
export function advanceToRound(service, roundId) {
  if (!service.state().stageState.fact_check) {
    service.openStage("fact_check");
    service.completeStage("fact_check");
    service.openStage("professional_review");
  }
  if (roundId === "r1") {
    service.openRound("r1");
    return;
  }
  if (service.state().rounds.r1?.status !== "counted") {
    throw new Error("进入 r2 前必须先完成 r1 计票");
  }
  service.completeStage("professional_review");
  service.openStage("social_responsibility_review");
  service.openRound("r2");
}

export function declareNoneForAll(service, judgeId, candidateIds) {
  candidateIds.forEach((candidateId, i) => {
    service.declareCOI(
      { declarationId: `coi-${judgeId}-${candidateId}`, judgeId, targetType: "candidate", targetId: candidateId, scope: "none", relation: "" },
      judgeId
    );
  });
}

export function vote(service, { roundId, judgeId, candidateId, verdict = "score", score = 80 }) {
  const payload = { roundId, judgeId, candidateId, verdict, comment: "" };
  if (verdict === "score") payload.score = score;
  service.castBallot(payload, judgeId);
}
