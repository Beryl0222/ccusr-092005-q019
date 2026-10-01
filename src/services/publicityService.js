import { Event, Stage, ConsentSection } from "../domain/events.js";
import { project, canonicalCandidateId, getCandidate } from "../domain/projection.js";
import { buildPublicationContent } from "../domain/policy.js";
import { Errors, fail } from "../core/errors.js";

/**
 * 公示与异议服务：
 * - 公示内容由候选本人授权白名单过滤生成；
 * - 异议期可复核证据，但选票已封存、评分通道已关闭，不可能暗改；
 * - 勘误保留前后值、理由与批准人。
 */
export class PublicityService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  state() {
    return project(this.store.events);
  }

  #append(type, data, actor) {
    return this.store.append(type, data, { actor, at: this.clock() });
  }

  /** 发布公示：取已封存轮次的入选名单，按授权生成快照。 */
  publish(editionId, roundId, actor = "秘书处") {
    const state = this.state();
    const edition = state.editions[editionId];
    if (!edition) fail(Errors.NOT_FOUND, "届次不存在");
    if (![Stage.DELIBERATION, Stage.PUBLICITY].includes(edition.stage)) {
      fail(Errors.STAGE, `当前阶段 ${edition.stage} 不能发布公示`);
    }
    const result = state.roundResults.find(
      (r) => r.editionId === editionId && r.roundId === roundId
    );
    if (!result) fail(Errors.STATE, "轮次结果尚未封存，不能公示");
    if (state.publications.some((p) => p.roundId === roundId)) {
      fail(Errors.STATE, "该轮次已发布公示");
    }
    const winnerIds = result.winners;
    for (const id of winnerIds) {
      const canonicalId = canonicalCandidateId(state, id);
      if (!state.consents[canonicalId]) {
        fail(Errors.STATE, `候选 ${canonicalId} 尚未确认公开范围，不能公示`);
      }
    }
    const content = buildPublicationContent(state, winnerIds);
    return this.#append(
      Event.PUBLICATION_PUBLISHED,
      { editionId, roundId, candidateIds: winnerIds, content },
      actor
    );
  }

  /**
   * 公示勘误。before 取当前公示快照，after 为更正值（null 表示撤下该板块）；
   * 更正后不得加入候选未授权的板块；必须记录理由与批准人。
   * 公示期与异议期均可勘误，但每次勘误本身永久留痕。
   */
  correctPublication(
    { editionId, candidateId, section, after, reason, approver, objectionId = null },
    actor = "秘书处"
  ) {
    const state = this.state();
    const edition = state.editions[editionId];
    if (![Stage.PUBLICITY, Stage.OBJECTION].includes(edition.stage)) {
      fail(Errors.STAGE, `当前阶段 ${edition.stage} 不允许勘误`);
    }
    if (!reason?.trim()) fail(Errors.VALIDATION, "勘误必须说明理由");
    if (!approver?.trim()) fail(Errors.VALIDATION, "勘误必须记录批准人");
    if (!Object.values(ConsentSection).includes(section)) {
      fail(Errors.VALIDATION, `未知公示板块 ${section}`);
    }
    const canonicalId = canonicalCandidateId(state, candidateId);
    const pubs = state.publications.filter((p) => p.editionId === editionId);
    const pub = pubs.find((p) => p.content.some((c) => c.candidateId === canonicalId));
    if (!pub) fail(Errors.NOT_FOUND, "该候选不在任何公示名单中");
    const entry = pub.content.find((c) => c.candidateId === canonicalId);
    const before = entry.sections[section] ?? null;
    if (after !== null) {
      const consent = state.consents[canonicalId];
      if (!consent?.sections.includes(section)) {
        fail(Errors.VALIDATION, "勘误不得加入候选本人未授权公开的板块");
      }
    }
    return this.#append(
      Event.PUBLICATION_CORRECTED,
      {
        editionId,
        candidateId: canonicalId,
        section,
        before,
        after,
        reason,
        approver,
        objectionId,
      },
      actor
    );
  }

  /** 提起异议并登记复核过的证据（异议期只复核，不改证据、不改选票）。 */
  fileObjection(
    { objectionId, editionId, candidateId, grounds, reviewedEvidenceIds = [] },
    actor
  ) {
    const state = this.state();
    const edition = state.editions[editionId];
    if (!edition) fail(Errors.NOT_FOUND, "届次不存在");
    if (edition.stage !== Stage.OBJECTION) {
      fail(Errors.STAGE, "只能在异议期提起异议");
    }
    if (!grounds?.trim()) fail(Errors.VALIDATION, "异议必须说明理由");
    if (state.objections[objectionId]) fail(Errors.VALIDATION, "异议编号已存在");
    for (const id of reviewedEvidenceIds) {
      const ev = state.evidences[id];
      if (!ev) fail(Errors.NOT_FOUND, `证据 ${id} 不存在`);
      const canonical = canonicalCandidateId(state, ev.candidateId);
      if (canonical !== canonicalCandidateId(state, candidateId)) {
        fail(Errors.VALIDATION, `证据 ${id} 不属于被异议候选`);
      }
    }
    return this.#append(
      Event.OBJECTION_FILED,
      {
        objectionId,
        editionId,
        candidateId: canonicalCandidateId(state, candidateId),
        grounds,
        reviewedEvidenceIds,
      },
      actor
    );
  }

  /** 异议复核结论。成立时应随后发起公示勘误（携 objectionId 关联）。 */
  decideObjection({ objectionId, decision, note, action = null }, actor = "异议复核组") {
    const state = this.state();
    const objection = state.objections[objectionId];
    if (!objection) fail(Errors.NOT_FOUND, "异议不存在");
    if (objection.status === "CLOSED") fail(Errors.STATE, "异议已结论");
    if (!["UPHELD", "REJECTED"].includes(decision)) {
      fail(Errors.VALIDATION, "结论只能是 UPHELD 或 REJECTED");
    }
    return this.#append(
      Event.OBJECTION_VERDICT,
      { objectionId, decision, note, action },
      actor
    );
  }

  finalize(editionId, actor = "组委会") {
    const state = this.state();
    const edition = state.editions[editionId];
    if (!edition) fail(Errors.NOT_FOUND, "届次不存在");
    const open = Object.values(state.objections).filter(
      (o) => o.editionId === editionId && o.status === "OPEN"
    );
    if (open.length > 0) fail(Errors.STATE, "尚有未结论的异议，不能结束届次");
    if (edition.stage !== Stage.OBJECTION) {
      fail(Errors.STAGE, `当前阶段 ${edition.stage} 不能结束届次`);
    }
    return this.#append(Event.EDITION_FINALIZED, { editionId }, actor);
  }
}
