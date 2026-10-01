import { randomUUID } from "node:crypto";

import { Event, Stage } from "../domain/events.js";
import { project, canonicalCandidateId, getCandidate } from "../domain/projection.js";
import {
  hasConflict,
  accessFor,
  rankRound,
  allocateQuotas,
} from "../domain/policy.js";
import { Errors, fail } from "../core/errors.js";
import { sha256Hex } from "../core/hash.js";

/**
 * 评审服务：利益冲突声明决定查看/评分权限；分阶段推进；
 * 事实核验通过方可进入打分；弃权与回避不折算成低分；
 * 轮次结果记录后选票即封存，禁止任何改动。
 */
export class ReviewService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  state(toSeq) {
    return project(this.store.events, toSeq === undefined ? undefined : { toSeq });
  }

  #append(type, data, actor) {
    return this.store.append(type, data, { actor, at: this.clock() });
  }

  #getEdition(state, editionId) {
    const edition = state.editions[editionId];
    if (!edition) fail(Errors.NOT_FOUND, `届次 ${editionId} 不存在`);
    return edition;
  }

  #round(edition, roundId) {
    const round = edition.rules.rounds.find((r) => r.roundId === roundId);
    if (!round) fail(Errors.NOT_FOUND, `轮次 ${roundId} 不在冻结规则中`);
    return round;
  }

  #isSealed(state, roundId) {
    return state.roundResults.some((r) => r.roundId === roundId);
  }

  /* ---------------- 评委 ---------------- */

  registerReviewer({ reviewerId, name, organization = null, expertise = [] }, actor = "组委会") {
    const state = this.state();
    if (state.reviewers[reviewerId]) {
      fail(Errors.VALIDATION, `评委 ${reviewerId} 已登记`);
    }
    return this.#append(
      Event.REVIEWER_REGISTERED,
      { reviewerId, name, organization, expertise },
      actor
    );
  }

  /**
   * 声明利益冲突。scope 可指定 candidateId / personId / nominatorId /
   * organization / teamLink。声明即生效（宁可回避），
   * 误报只能经秘书处留痕撤回。
   */
  declareCOI({ reviewerId, scope, reason }, actor) {
    const state = this.state();
    if (!state.reviewers[reviewerId]) fail(Errors.NOT_FOUND, "评委未登记");
    if (!reason?.trim()) fail(Errors.VALIDATION, "利益冲突声明必须说明理由");
    const declarationId = `coi_${randomUUID()}`;
    this.#append(
      Event.COI_DECLARED,
      { declarationId, reviewerId, scope, reason },
      actor ?? reviewerId
    );
    return declarationId;
  }

  withdrawCOI({ declarationId, reason }, actor = "秘书处") {
    const state = this.state();
    const coi = state.cois.find((c) => c.declarationId === declarationId);
    if (!coi) fail(Errors.NOT_FOUND, "利益冲突声明不存在");
    if (coi.withdrawn) fail(Errors.STATE, "该声明已撤回");
    if (!reason?.trim()) fail(Errors.VALIDATION, "撤回应声明必须说明理由");
    return this.#append(Event.COI_WITHDRAWN, { declarationId, reason }, actor);
  }

  /** 评委查看候选材料：存在冲突即拒绝（查看权限与评分权限一致收回）。 */
  viewCandidateMaterial(reviewerId, candidateId) {
    const state = this.state();
    if (!state.reviewers[reviewerId]) fail(Errors.NOT_FOUND, "评委未登记");
    if (accessFor(state, reviewerId, candidateId) === "CONFLICT") {
      fail(Errors.CONFLICT, "存在利益冲突，已回避：不得查看该候选材料", {
        candidateId,
      });
    }
    const canonicalId = canonicalCandidateId(state, candidateId);
    const candidate = getCandidate(state, canonicalId);
    return {
      candidateId: canonicalId,
      candidateType: candidate.candidateType,
      category: candidate.category,
      profile: candidate.profile,
      eligibility: state.factEligibility[canonicalId] ?? null,
      achievements: Object.values(state.achievements)
        .filter((a) =>
          a.candidateIds
            .map((x) => canonicalCandidateId(state, x))
            .includes(canonicalId)
        )
        .map((a) => ({
          id: a.id,
          title: a.title,
          summary: a.summary,
          contribution: a.credits[canonicalId]?.contribution ?? null,
        })),
      evidences: Object.values(state.evidences)
        .filter((e) => canonicalCandidateId(state, e.candidateId) === canonicalId)
        .map((e) => ({
          id: e.id,
          type: e.evidenceType,
          source: e.source,
          state: e.state,
          versions: e.versions.map((v) => ({ hash: v.hash, label: v.label, reason: v.reason })),
        })),
    };
  }

  /* ---------------- 事实核验门槛 ---------------- */

  decideFactEligibility({ candidateId, decision, note = "", evidenceIds = [] }, actor = "事实核验组") {
    const state = this.state();
    const candidate = getCandidate(state, candidateId);
    if (!candidate) fail(Errors.NOT_FOUND, "候选不存在");
    const edition = this.#getEdition(state, candidate.editionId);
    const canonicalId = canonicalCandidateId(state, candidateId);
    const recheck = state.factEligibility[canonicalId]?.decision === "PENDING_RECHECK";
    if (![Stage.FACT_CHECK, Stage.PROFESSIONAL_REVIEW, Stage.SOCIAL_REVIEW].includes(edition.stage)) {
      fail(Errors.STAGE, "事实核验结论只能在核验或评审阶段作出");
    }
    if (!recheck && edition.stage !== Stage.FACT_CHECK) {
      fail(Errors.STAGE, "初次入围结论只能在 FACT_CHECK 阶段作出");
    }
    if (!["ENTERS_REVIEW", "EXCLUDED"].includes(decision)) {
      fail(Errors.VALIDATION, "结论只能是 ENTERS_REVIEW 或 EXCLUDED");
    }
    if (decision === "ENTERS_REVIEW" && evidenceIds.length === 0) {
      fail(Errors.VALIDATION, "进入评审必须列明所依据的已核验证据");
    }
    for (const id of evidenceIds) {
      const ev = state.evidences[id];
      if (!ev || ev.state !== "VERIFIED") {
        fail(Errors.VALIDATION, `证据 ${id} 未通过核验，不能作为入围依据`);
      }
    }
    return this.#append(
      Event.FACT_ELIGIBILITY_DECIDED,
      { candidateId: canonicalCandidateId(state, candidateId), decision, note, evidenceIds },
      actor
    );
  }

  /* ---------------- 打分 ---------------- */

  /**
   * 提交评分或弃权。
   * - 冲突评委不能评分（服务端强制，前端隐藏只是体验）；
   * - 候选必须通过事实核验门槛；
   * - 弃权显式标记，value 为 null，绝不折算 0 分；
   * - 轮次结果记录后选票封存，拒绝一切改动。
   */
  submitScore(
    { editionId, roundId, candidateId, value, abstain = false, abstainReason = null },
    actor
  ) {
    const state = this.state();
    const edition = this.#getEdition(state, editionId);
    const round = this.#round(edition, roundId);
    const reviewerId = actor;
    if (!state.reviewers[reviewerId]) fail(Errors.NOT_FOUND, "评委未登记");
    // 封存检查优先于阶段检查：轮次一旦封存，在任何后续阶段都不可改票
    if (this.#isSealed(state, roundId)) {
      fail(Errors.SEALED, "该轮次选票已封存，禁止修改");
    }
    if (edition.stage !== round.stage) {
      fail(Errors.STAGE, `轮次 ${roundId} 只在 ${round.stage} 阶段开放，当前 ${edition.stage}`);
    }
    if (hasConflict(state, reviewerId, candidateId)) {
      fail(Errors.CONFLICT, "存在利益冲突，已回避：不得评分", { candidateId });
    }
    const canonicalId = canonicalCandidateId(state, candidateId);
    const already = state.scores.some(
      (s) =>
        s.roundId === roundId &&
        s.reviewerId === reviewerId &&
        canonicalCandidateId(state, s.candidateId) === canonicalId
    );
    if (already) {
      fail(Errors.SEALED, "投票以首次提交为准，不得修改或重复投票（选票不可暗改）");
    }
    const eligibility = state.factEligibility[canonicalId];
    if (!eligibility || eligibility.decision !== "ENTERS_REVIEW") {
      fail(Errors.STATE, "候选未通过事实核验，不具备评分资格");
    }
    if (abstain) {
      if (!abstainReason?.trim()) {
        fail(Errors.VALIDATION, "弃权必须填写理由（弃权不折算低分，但须留痕）");
      }
    } else {
      const { min, max } = round.scoring ?? {};
      if (typeof value !== "number" || Number.isNaN(value)) {
        fail(Errors.VALIDATION, "评分必须是数值；如不评分请显式弃权");
      }
      if (min !== undefined && value < min) fail(Errors.VALIDATION, `评分不得低于 ${min}`);
      if (max !== undefined && value > max) fail(Errors.VALIDATION, `评分不得高于 ${max}`);
    }
    return this.#append(
      Event.SCORE_SUBMITTED,
      {
        editionId,
        roundId,
        candidateId: canonicalId,
        reviewerId,
        value: abstain ? null : value,
        abstain,
        abstainReason,
      },
      reviewerId
    );
  }

  /* ---------------- 并列处置与轮次计票 ---------------- */

  /**
   * 处置并列。METHOD=RULE 时必须引用冻结规则 tieRule 中的顺位键；
   * METHOD=COMMITTEE 时必须有批准人、理由与最终胜出者。
   */
  resolveTie(
    { roundId, tiedCandidateIds, winnerIds, method, ruleCited = null, reason, approver },
    actor = "评审委员会"
  ) {
    const state = this.state();
    const edition = Object.values(state.editions).find((e) =>
      e.rules?.rounds.some((r) => r.roundId === roundId)
    );
    if (!edition) fail(Errors.NOT_FOUND, `轮次 ${roundId} 不在任何冻结规则中`);
    if (winnerIds.length === 0) fail(Errors.VALIDATION, "并列处置必须确定胜出者");
    if (!winnerIds.every((id) => tiedCandidateIds.includes(id))) {
      fail(Errors.VALIDATION, "胜出者必须来自并列名单");
    }
    if (method === "RULE") {
      const tieRule = edition.rules.tieRule ?? "";
      if (!ruleCited || !tieRule.includes(ruleCited)) {
        fail(Errors.VALIDATION, "按规则处置并列必须引用冻结 tieRule 中的顺位键", {
          frozenTieRule: tieRule,
        });
      }
    } else if (method === "COMMITTEE") {
      if (!approver || !reason?.trim()) {
        fail(Errors.VALIDATION, "委员会裁定并列必须有批准人与理由");
      }
    } else {
      fail(Errors.VALIDATION, "并列处置方式只能是 RULE 或 COMMITTEE");
    }
    return this.#append(
      Event.TIE_RESOLVED,
      { roundId, tiedCandidateIds, winnerIds, method, ruleCited, reason, approver: approver ?? actor },
      actor
    );
  }

  /**
   * 计票并封存轮次结果。封存记录含：
   *  - 计票所依据的事件序号区间 [fromSeq, toSeq)；
   *  - 本轮全部选票集合的指纹 scoreSetHash；
   * 之后任何改票都将因序号/指纹不一致而在复现时暴露。
   */
  recordRoundResult(editionId, roundId, actor = "监票组") {
    const state = this.state();
    const edition = this.#getEdition(state, editionId);
    const round = this.#round(edition, roundId);
    if (edition.stage !== round.stage && edition.stage !== Stage.DELIBERATION) {
      fail(Errors.STAGE, `当前阶段 ${edition.stage} 不能封存 ${roundId}`);
    }
    if (this.#isSealed(state, roundId)) {
      fail(Errors.SEALED, "轮次结果已封存，不得重复计票");
    }

    const eligibleIds = Object.values(state.candidates)
      .filter((c) => c.editionId === editionId && !c.mergedInto)
      .map((c) => c.id)
      .filter((id) => state.factEligibility[id]?.decision === "ENTERS_REVIEW");

    const rankings = rankRound(state, roundId, eligibleIds);
    const { winners: rawWinners, unresolvedTies } = allocateQuotas(
      state,
      roundId,
      rankings,
      edition.rules.quotas
    );

    // 用已留痕的并列处置消化所有跨配额线并列；仍有未处置的则拒绝封存。
    const resolutions = state.tieResolutions.filter((t) => t.roundId === roundId);
    const winners = [...rawWinners];
    const remaining = [];
    for (const tie of unresolvedTies) {
      const resolution = resolutions.find((r) =>
        tie.tiedCandidateIds.every(
          (id) => r.tiedCandidateIds.includes(id) || r.winnerIds.includes(id)
        )
      );
      if (!resolution) {
        remaining.push(tie);
        continue;
      }
      // 以裁定结果为准：移除未胜出者，补入胜出者
      for (const id of tie.tiedCandidateIds) {
        if (!resolution.winnerIds.includes(id)) {
          const idx = winners.indexOf(id);
          if (idx >= 0) winners.splice(idx, 1);
        } else if (!winners.includes(id)) {
          winners.push(id);
        }
      }
    }
    if (remaining.length > 0) {
      fail(
        Errors.TIE,
        "存在跨越名额线且未处置的并列，必须按冻结规则或委员会裁定后再计票",
        { unresolvedTies: remaining }
      );
    }

    const fromSeq = 0;
    const toSeq = this.store.events.length;
    const scoreRows = state.scores
      .filter((s) => s.roundId === roundId)
      .map((s) => ({
        reviewerId: s.reviewerId,
        candidateId: canonicalCandidateId(state, s.candidateId),
        value: s.value,
        abstain: s.abstain,
      }))
      .sort((a, b) =>
        a.reviewerId === b.reviewerId
          ? a.candidateId.localeCompare(b.candidateId)
          : a.reviewerId.localeCompare(b.reviewerId)
      );
    const scoreSetHash = sha256Hex(scoreRows);

    this.#append(
      Event.ROUND_RESULT_RECORDED,
      {
        editionId,
        roundId,
        fromSeq,
        toSeq,
        scoreSetHash,
        rankings,
        winners,
      },
      actor
    );
    return { rankings, winners, scoreSetHash, toSeq };
  }
}
