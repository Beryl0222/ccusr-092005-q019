import { Event, Stage } from "./events.js";

/** 折叠的初始空状态。 */
export function initialState() {
  return {
    editions: {},
    candidates: {},
    persons: {},
    nominators: {},
    reviewers: {},
    achievements: {},
    evidences: {},
    consents: {},
    factEligibility: {},
    cois: [],
    teamLinks: [],
    scores: [],
    tieResolutions: [],
    roundResults: [],
    publications: [],
    objections: {},
    stageHistory: [],
  };
}

/** 沿 mergedInto 链找到规范候选（身份归并后的真实主体）。 */
export function canonicalCandidateId(state, candidateId) {
  let current = candidateId;
  const seen = new Set();
  while (state.candidates[current]?.mergedInto) {
    if (seen.has(current)) break; // 防御环
    seen.add(current);
    current = state.candidates[current].mergedInto;
  }
  return current;
}

export function getCandidate(state, candidateId) {
  return state.candidates[canonicalCandidateId(state, candidateId)];
}

export function isMergedAway(state, candidateId) {
  const c = state.candidates[candidateId];
  return Boolean(c && c.mergedInto);
}

/** 归并链上的全部候选（含已并入者）。 */
export function equivalenceGroup(state, canonicalId) {
  return Object.values(state.candidates).filter(
    (c) => canonicalCandidateId(state, c.id) === canonicalId
  );
}

/**
 * 同一自然人身份组：归并链 + 人工身份关联（可跨类别）。
 * 用于利益冲突传导与重复成果排查；各候选资格的计票仍相互独立。
 */
export function identityGroupCandidateIds(state, candidateId) {
  const canonicalId = canonicalCandidateId(state, candidateId);
  const ids = new Set(equivalenceGroup(state, canonicalId).map((c) => c.id));
  const personId = state.candidates[canonicalId]?.personId;
  if (personId) {
    for (const id of state.persons[personId].candidateIds) {
      ids.add(canonicalCandidateId(state, id));
    }
  }
  return [...ids];
}

// eslint-disable-next-line complexity
export function reducer(state, event) {
  const { type, data, at, actor } = event;
  switch (type) {
    case Event.EDITION_CREATED: {
      state.editions[data.editionId] = {
        id: data.editionId,
        name: data.name,
        year: data.year,
        rules: null,
        rulesFrozen: false,
        rulesFrozenAt: null,
        stage: Stage.SETUP,
        createdAt: at,
      };
      break;
    }

    case Event.RULES_FROZEN: {
      const edition = state.editions[data.editionId];
      edition.rules = data.rules; // { categories, quotas, rounds, deadlines, tieRule }
      edition.rulesFrozen = true;
      edition.rulesFrozenAt = at;
      break;
    }

    case Event.STAGE_CHANGED: {
      const edition = state.editions[data.editionId];
      edition.stage = data.to;
      state.stageHistory.push({
        editionId: data.editionId,
        from: data.from,
        to: data.to,
        at,
        actor,
      });
      break;
    }

    case Event.REVIEWER_REGISTERED: {
      state.reviewers[data.reviewerId] = {
        id: data.reviewerId,
        name: data.name,
        organization: data.organization ?? null,
        expertise: data.expertise ?? [],
        registeredAt: at,
      };
      break;
    }

    case Event.NOMINATION_SUBMITTED: {
      state.nominators[data.nominatorId] ??= {
        id: data.nominatorId,
        name: data.nominatorName,
        kind: data.nominatorKind ?? "机构",
      };
      state.candidates[data.candidateId] = {
        id: data.candidateId,
        editionId: data.editionId,
        candidateType: data.candidateType, // PERSON | TEAM
        category: data.category,
        nominatorId: data.nominatorId,
        profile: data.profile ?? {},
        teamContact: data.teamContact ?? null,
        status: "NOMINATED",
        mergedInto: null,
        mergeLog: [],
        nominatedAt: at,
      };
      break;
    }

    case Event.PERSON_CREATED: {
      state.persons[data.personId] = {
        id: data.personId,
        name: data.name,
        credentialHash: data.credentialHash ?? null, // 证件号只存哈希
        organization: data.organization ?? null,
        createdAt: at,
        candidateIds: [],
      };
      break;
    }

    case Event.IDENTITY_LINKED: {
      const person = state.persons[data.personId];
      person.candidateIds.push(data.candidateId);
      state.candidates[data.candidateId].personId = data.personId;
      state.candidates[data.candidateId].identityLog ??= [];
      state.candidates[data.candidateId].identityLog.push({
        basis: data.basis,
        reason: data.reason,
        at,
        actor,
      });
      break;
    }

    case Event.CANDIDATES_MERGED: {
      const { survivingId, mergedId, basis, reason } = data;
      const target = state.candidates[survivingId];
      const absorbed = state.candidates[mergedId];
      absorbed.mergedInto = canonicalCandidateId(state, survivingId);
      absorbed.status = "MERGED";
      target.mergeLog.push({
        mergedId,
        basis, // 人工归并依据，如证件号比对
        reason,
        at,
        actor,
      });
      break;
    }

    case Event.TEAM_LINKED: {
      state.teamLinks.push({
        teamCandidateId: data.teamCandidateId,
        personCandidateId: data.personCandidateId,
        role: data.role ?? null,
        at,
      });
      break;
    }

    case Event.ACHIEVEMENT_DECLARED: {
      state.achievements[data.achievementId] = {
        id: data.achievementId,
        title: data.title,
        summary: data.summary ?? "",
        candidateIds: [...data.candidateIds], // 个人与团队共同成果共享同一记录
        dedupeKey: data.dedupeKey ?? null,
        duplicateOf: data.duplicateOf ?? null,
        declaredAt: at,
        credits: {},
      };
      break;
    }

    case Event.ACHIEVEMENT_CREDIT_DECIDED: {
      const achievement = state.achievements[data.achievementId];
      achievement.credits[data.candidateId] = {
        contribution: data.contribution,
        decidedAt: at,
      };
      break;
    }

    case Event.EVIDENCE_SUBMITTED: {
      state.evidences[data.evidenceId] = {
        id: data.evidenceId,
        candidateId: data.candidateId,
        achievementId: data.achievementId ?? null,
        evidenceType: data.evidenceType,
        source: data.source,
        versions: [
          {
            hash: data.originalHash, // 原件指纹，永久保留
            label: data.label ?? "原件",
            submittedAt: at,
            reason: "首次提交",
          },
        ],
        state: "SUBMITTED", // SUBMITTED | VERIFIED | REJECTED
        verdict: null,
        deadline: data.deadline ?? null,
      };
      break;
    }

    case Event.EVIDENCE_AMENDED: {
      const evidence = state.evidences[data.evidenceId];
      evidence.versions.push({
        hash: data.newHash,
        label: data.label ?? `修订版${evidence.versions.length}`,
        submittedAt: at,
        reason: data.reason, // 更正理由必填
      });
      // 更正使既有核验结论失效，需重新核验；原结论保留在 verdictHistory
      if (evidence.verdict) {
        evidence.verdictHistory ??= [];
        evidence.verdictHistory.push(evidence.verdict);
      }
      evidence.state = "SUBMITTED";
      evidence.verdict = null;
      // 依赖该证据作出的入围决定一并失效，须重新核验后重作
      for (const eligibility of Object.values(state.factEligibility)) {
        if (eligibility.decision === "ENTERS_REVIEW" && eligibility.evidenceIds.includes(data.evidenceId)) {
          eligibility.decision = "PENDING_RECHECK";
          eligibility.invalidatedAt = at;
          eligibility.invalidatedReason = "所依据的证据被更正，等待重新核验";
        }
      }
      break;
    }

    case Event.FACT_VERDICT: {
      const evidence = state.evidences[data.evidenceId];
      evidence.state = data.verdict === "VERIFIED" ? "VERIFIED" : "REJECTED";
      evidence.verdict = {
        verdict: data.verdict,
        note: data.note ?? "",
        by: actor,
        at,
      };
      break;
    }

    case Event.FACT_ELIGIBILITY_DECIDED: {
      const canonicalId = canonicalCandidateId(state, data.candidateId);
      const prev = state.factEligibility[canonicalId];
      const prevHistory = prev?.history ?? [];
      const prevSnapshot = prev
        ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== "history"))
        : null;
      state.factEligibility[canonicalId] = {
        candidateId: canonicalId,
        decision: data.decision, // ENTERS_REVIEW | EXCLUDED
        note: data.note ?? "",
        evidenceIds: data.evidenceIds ?? [],
        by: actor,
        at,
        history: prevSnapshot ? [...prevHistory, prevSnapshot] : prevHistory,
      };
      break;
    }

    case Event.CANDIDATE_CONSENT: {
      const prev = state.consents[data.candidateId];
      state.consents[data.candidateId] = {
        candidateId: data.candidateId,
        sections: data.sections, // 候选本人确认的公开范围（白名单）
        scopeNote: data.scopeNote ?? "",
        confirmedAt: at,
        // 授权可收紧/调整，但每次调整本身留痕
        history: [
          ...(prev?.history ?? []),
          { sections: data.sections, at, actor },
        ],
      };
      break;
    }

    case Event.COI_DECLARED: {
      state.cois.push({
        declarationId: data.declarationId,
        reviewerId: data.reviewerId,
        scope: data.scope, // { candidateId? personId? nominatorId? organization? teamLink? }
        reason: data.reason,
        at,
        withdrawn: false,
      });
      break;
    }

    case Event.COI_WITHDRAWN: {
      const coi = state.cois.find((c) => c.declarationId === data.declarationId);
      if (coi) {
        coi.withdrawn = true;
        coi.withdrawnAt = at;
        coi.withdrawnBy = actor;
        coi.withdrawReason = data.reason;
      }
      break;
    }

    case Event.SCORE_SUBMITTED: {
      state.scores.push({
        roundId: data.roundId,
        editionId: data.editionId,
        candidateId: data.candidateId,
        reviewerId: data.reviewerId,
        value: data.abstain ? null : data.value,
        abstain: Boolean(data.abstain),
        abstainReason: data.abstainReason ?? null,
        at,
      });
      break;
    }

    case Event.TIE_RESOLVED: {
      state.tieResolutions.push({
        roundId: data.roundId,
        tiedCandidateIds: data.tiedCandidateIds,
        winnerIds: data.winnerIds,
        method: data.method, // RULE | COMMITTEE
        ruleCited: data.ruleCited ?? null,
        reason: data.reason,
        approver: data.approver,
        at,
      });
      break;
    }

    case Event.ROUND_RESULT_RECORDED: {
      state.roundResults.push({
        roundId: data.roundId,
        editionId: data.editionId,
        at,
        actor,
        fromSeq: data.fromSeq, // 计票所依据的事件序号区间
        toSeq: data.toSeq,
        scoreSetHash: data.scoreSetHash, // 所计选票集合指纹
        rankings: structuredClone(data.rankings), // 冻结时的名次快照
        winners: [...data.winners], // 冻结时的入选名单快照
      });
      break;
    }

    case Event.PUBLICATION_PUBLISHED: {
      state.publications.push({
        editionId: data.editionId,
        roundId: data.roundId,
        candidateIds: data.candidateIds,
        // 必须复制：后续勘误就地更新快照，绝不能回写到事件 data 而破坏哈希链
        content: structuredClone(data.content),
        publishedAt: at,
        approver: actor,
        corrections: [],
      });
      break;
    }

    case Event.PUBLICATION_CORRECTED: {
      const pub = state.publications
        .filter((p) => p.editionId === data.editionId)
        .find((p) => p.content.some((c) => c.candidateId === data.candidateId));
      pub.corrections.push({
        candidateId: data.candidateId,
        section: data.section,
        before: data.before,
        after: data.after,
        reason: data.reason,
        approver: data.approver,
        approvedAt: at,
        objectionId: data.objectionId ?? null,
      });
      // 同步修正当前公示快照
      const entry = pub.content.find((c) => c.candidateId === data.candidateId);
      if (entry) entry.sections[data.section] = data.after;
      break;
    }

    case Event.OBJECTION_FILED: {
      state.objections[data.objectionId] = {
        id: data.objectionId,
        editionId: data.editionId,
        candidateId: data.candidateId,
        grounds: data.grounds,
        reviewedEvidenceIds: data.reviewedEvidenceIds ?? [],
        filedBy: actor,
        filedAt: at,
        status: "OPEN",
        verdict: null,
      };
      break;
    }

    case Event.OBJECTION_VERDICT: {
      const objection = state.objections[data.objectionId];
      objection.status = "CLOSED";
      objection.verdict = {
        decision: data.decision, // UPHELD | REJECTED
        note: data.note,
        action: data.action ?? null, // 例如 PUBLICATION_CORRECTION
        by: actor,
        at,
      };
      break;
    }

    case Event.EDITION_FINALIZED: {
      state.editions[data.editionId].stage = Stage.FINALIZED;
      state.editions[data.editionId].finalizedAt = at;
      break;
    }

    default:
      // 未知事件不改变状态（向前兼容），但哈希链仍保证其不可被删除
      break;
  }
  return state;
}

/** 从事件数组（或其子集）折叠出状态。 */
export function project(events, { toSeq = events.length } = {}) {
  let state = initialState();
  for (const event of events) {
    if (event.seq >= toSeq) break;
    state = reducer(state, event);
  }
  return state;
}
