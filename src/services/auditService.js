import { project, canonicalCandidateId } from "../domain/projection.js";
import { rankRound, buildPublicationContent } from "../domain/policy.js";
import { sha256Hex } from "../core/hash.js";
import { Errors, fail } from "../core/errors.js";

/**
 * 审计与复现服务。只读，不追加任何事件。
 * 秘书处可据此：
 *  1. 校验哈希链完整性；
 *  2. 复现任意历史轮次（折叠到封存时记录的 toSeq）；
 *  3. 用封存的选票集合指纹比对复现计票，证明选票未被暗改；
 *  4. 输出公示勘误前后差异、理由与批准人；
 *  5. 输出证据版本链（原件哈希保留情况）与身份归并轨迹。
 */
export class AuditService {
  constructor(store) {
    this.store = store;
  }

  verifyIntegrity() {
    this.store.verifyChain(); // 失败即抛 CHAIN_TAMPERED
    return { ok: true, events: this.store.events.length, headHash: this.store.headHash() };
  }

  /** 折叠到指定事件序号（不含），复现历史时点状态。 */
  replayAt(toSeq) {
    return project(this.store.events, { toSeq });
  }

  /** 列出已封存轮次及其复现坐标。 */
  listRounds(editionId = null) {
    const state = project(this.store.events);
    return state.roundResults
      .filter((r) => !editionId || r.editionId === editionId)
      .map((r) => ({
        editionId: r.editionId,
        roundId: r.roundId,
        sealedAt: r.at,
        sealedBy: r.actor,
        fromSeq: r.fromSeq,
        toSeq: r.toSeq,
        scoreSetHash: r.scoreSetHash,
      }));
  }

  /**
   * 复现某轮封存时的完整情形：
   * 把事件折叠回 toSeq，重新计票并与封存快照比对。
   * 任一不一致都会明确报出——暗改选票必然在此暴露。
   */
  replayRound(editionId, roundId) {
    const current = project(this.store.events);
    const sealed = current.roundResults.find(
      (r) => r.editionId === editionId && r.roundId === roundId
    );
    if (!sealed) fail(Errors.NOT_FOUND, `轮次 ${roundId} 未封存，无历史可复现`);

    const state = project(this.store.events, { toSeq: sealed.toSeq });

    // 1) 重新计算封存时点的选票集合指纹
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
    const recomputedHash = sha256Hex(scoreRows);

    // 2) 重新计票（同样的回避/弃权规则）
    const eligibleIds = Object.values(state.candidates)
      .filter((c) => c.editionId === editionId && !c.mergedInto)
      .map((c) => c.id)
      .filter((id) => state.factEligibility[id]?.decision === "ENTERS_REVIEW");
    const rankings = rankRound(state, roundId, eligibleIds);

    return {
      roundId,
      sealedAt: sealed.at,
      sealedBy: sealed.actor,
      replayedToSeq: sealed.toSeq,
      ballotCount: scoreRows.length,
      scoreSetHashMatches: recomputedHash === sealed.scoreSetHash,
      storedScoreSetHash: sealed.scoreSetHash,
      recomputedScoreSetHash: recomputedHash,
      rankingsMatch:
        JSON.stringify(rankings) === JSON.stringify(sealed.rankings),
      rankings,
      sealedRankings: sealed.rankings,
      winners: sealed.winners,
      // 复现当时各评委对各候选的回避/弃权标记，便于向异议人解释
      ballots: scoreRows,
    };
  }

  /** 公示勘误审计：逐条列出改了什么、前后值、理由、批准人、时间。 */
  publicationCorrections(editionId) {
    const state = project(this.store.events);
    const pubs = state.publications.filter((p) => p.editionId === editionId);
    return pubs.flatMap((pub) =>
      pub.corrections.map((c) => ({
        roundId: pub.roundId,
        candidateId: c.candidateId,
        section: c.section,
        before: c.before,
        after: c.after,
        reason: c.reason,
        approver: c.approver,
        approvedAt: c.approvedAt,
        objectionId: c.objectionId ?? null,
      }))
    );
  }

  /** 证据版本链：证明原件哈希始终保留、每次更正都有理由。 */
  evidenceTrail(evidenceId) {
    const state = project(this.store.events);
    const evidence = state.evidences[evidenceId];
    if (!evidence) fail(Errors.NOT_FOUND, `证据 ${evidenceId} 不存在`);
    return {
      evidenceId,
      candidateId: canonicalCandidateId(state, evidence.candidateId),
      source: evidence.source,
      state: evidence.state,
      verdict: evidence.verdict,
      originalHash: evidence.versions[0].hash,
      currentHash: evidence.versions.at(-1).hash,
      amended: evidence.versions.length > 1,
      versions: evidence.versions.map((v, i) => ({
        version: i + 1,
        hash: v.hash,
        label: v.label,
        reason: v.reason,
        at: v.submittedAt,
      })),
    };
  }

  /** 身份归并轨迹：同一自然人的全部候选资格与归并依据。 */
  identityTrail(personId) {
    const state = project(this.store.events);
    const person = state.persons[personId];
    if (!person) fail(Errors.NOT_FOUND, `自然人 ${personId} 不存在`);
    return {
      personId,
      name: person.name,
      credentialHash: person.credentialHash,
      links: person.candidateIds.map((id) => {
        const c = state.candidates[id];
        return {
          candidateId: id,
          category: c.category,
          candidateType: c.candidateType,
          nominator: state.nominators[c.nominatorId]?.name,
          log: c.identityLog ?? [],
          mergedAway: Boolean(c.mergedInto),
          mergedInto: c.mergedInto,
        };
      }),
    };
  }

  /** 候选维度的完整时间线（提名、归并、证据、授权、回避、评分、公示）。 */
  candidateTimeline(candidateId) {
    const state = project(this.store.events);
    const canonical = canonicalCandidateId(state, candidateId);
    const groupIds = new Set([canonical]);
    // 含归并前身份
    for (const c of Object.values(state.candidates)) {
      if (canonicalCandidateId(state, c.id) === canonical) groupIds.add(c.id);
    }
    return this.store.events
      .filter((e) => eventTouches(e, groupIds, canonical))
      .map((e) => ({ seq: e.seq, at: e.at, actor: e.actor, type: e.type, data: e.data }));
  }
}

function eventTouches(event, groupIds, canonicalId) {
  const d = event.data;
  if (d.candidateId && groupIds.has(d.candidateId)) return true;
  if (d.survivingId === canonicalId || (d.mergedId && groupIds.has(d.mergedId))) return true;
  if (Array.isArray(d.candidateIds) && d.candidateIds.some((id) => groupIds.has(id))) {
    return true;
  }
  return false;
}
