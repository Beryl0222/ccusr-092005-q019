import { Event, Stage, STAGE_ORDER, ConsentSection } from "../domain/events.js";
import { project, canonicalCandidateId, getCandidate } from "../domain/projection.js";
import { Errors, fail } from "../core/errors.js";
import { sha256Hex, fingerprint } from "../core/hash.js";

/**
 * 遴选命令服务：所有方法先基于当前投影做校验，再向事件存储追加事件。
 * 规则、名额、轮次在 RULES_FROZEN 之后不可修改（再发冻结事件即被拒绝）。
 */
export class SelectionService {
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
    if (!edition) fail(Errors.NOT_FOUND, `届次 ${editionId} 不存在`, { editionId });
    return edition;
  }

  #requireCandidate(state, candidateId) {
    const c = getCandidate(state, candidateId);
    if (!c) fail(Errors.NOT_FOUND, `候选 ${candidateId} 不存在`, { candidateId });
    return c;
  }

  #assertStage(edition, allowed) {
    if (!allowed.includes(edition.stage)) {
      fail(Errors.STAGE, `当前阶段 ${edition.stage} 不允许该操作`, {
        stage: edition.stage,
        allowed,
      });
    }
  }

  /* ---------------- 届次与规则 ---------------- */

  createEdition({ editionId, name, year }, actor = "秘书处") {
    const state = this.state();
    if (state.editions[editionId]) {
      fail(Errors.VALIDATION, `届次 ${editionId} 已存在`);
    }
    return this.#append(
      Event.EDITION_CREATED,
      { editionId, name, year },
      actor
    );
  }

  /**
   * 冻结规则。rules 形如：
   * { categories: [...], quotas: {类别: 名额},
   *   rounds: [{roundId, name, stage, scoring:{min,max,eligibleFactStates}}],
   *   deadlines: { nomination, evidenceSupplement, ... },
   *   tieRule: "SEQUENCE:factVote,seniority" }
   * 一旦冻结，任何重复冻结/改动均被拒绝。
   */
  freezeRules(editionId, rules, actor = "组委会") {
    const state = this.state();
    const edition = this.#getEdition(state, editionId);
    if (edition.rulesFrozen) {
      fail(Errors.FROZEN, "规则、名额与评审轮次一经开始即冻结，不得修改", {
        frozenAt: edition.rulesFrozenAt,
      });
    }
    validateRules(rules);
    return this.#append(
      Event.RULES_FROZEN,
      { editionId, rules: { ...rules, rulesHash: sha256Hex(rules) } },
      actor
    );
  }

  advanceStage(editionId, to, actor = "组委会") {
    const state = this.state();
    const edition = this.#getEdition(state, editionId);
    const fromIdx = STAGE_ORDER.indexOf(edition.stage);
    const toIdx = STAGE_ORDER.indexOf(to);
    if (toIdx <= fromIdx) {
      fail(Errors.STATE, `阶段只能向前推进：${edition.stage} → ${to}`);
    }
    if (!edition.rulesFrozen && toIdx > STAGE_ORDER.indexOf(Stage.NOMINATION)) {
      fail(Errors.FROZEN, "进入评审前必须先冻结规则");
    }
    return this.#append(
      Event.STAGE_CHANGED,
      { editionId, from: edition.stage, to },
      actor
    );
  }

  /* ---------------- 提名 ---------------- */

  submitNomination(
    {
      editionId,
      candidateId,
      candidateType, // PERSON | TEAM
      category,
      nominatorId,
      nominatorName,
      nominatorKind = "机构",
      profile = {},
      teamContact = null,
    },
    actor
  ) {
    const state = this.state();
    const edition = this.#getEdition(state, editionId);
    this.#assertStage(edition, [Stage.SETUP, Stage.NOMINATION]);
    if (!edition.rulesFrozen) fail(Errors.FROZEN, "规则冻结后方可接受提名");
    if (!edition.rules.categories.includes(category)) {
      fail(Errors.VALIDATION, `类别 ${category} 不在冻结规则内`);
    }
    if (state.candidates[candidateId]) {
      fail(Errors.VALIDATION, `候选标识 ${candidateId} 已存在`);
    }
    if (candidateType === "TEAM" && !teamContact) {
      fail(Errors.VALIDATION, "团队候选必须提供联系人");
    }
    return this.#append(
      Event.NOMINATION_SUBMITTED,
      {
        editionId,
        candidateId,
        candidateType,
        category,
        nominatorId,
        nominatorName,
        nominatorKind,
        profile,
        teamContact,
      },
      actor ?? nominatorName
    );
  }

  /** 秘书处人工归并身份：创建规范自然人并关联候选（可跨类别）。 */
  resolveIdentity(
    { personId, name, credentialHash = null, organization = null, links },
    actor = "秘书处"
  ) {
    const state = this.state();
    if (!state.persons[personId]) {
      this.#append(
        Event.PERSON_CREATED,
        { personId, name, credentialHash, organization },
        actor
      );
    }
    const after = this.state();
    for (const link of links) {
      this.#requireCandidate(after, link.candidateId);
      const candidate = after.candidates[link.candidateId];
      if (candidate.personId && candidate.personId !== personId) {
        fail(Errors.VALIDATION, `候选 ${link.candidateId} 已归属其他自然人`);
      }
      this.#append(
        Event.IDENTITY_LINKED,
        {
          personId,
          candidateId: link.candidateId,
          basis: link.basis, // 如：证件号哈希一致 / 本人确认
          reason: link.reason,
        },
        actor
      );
    }
  }

  /** 同类别重复提名的吸收式归并（真正的重复候选资格）。 */
  mergeDuplicateCandidates({ survivingId, mergedId, basis, reason }, actor = "秘书处") {
    const state = this.state();
    const survivor = this.#requireCandidate(state, survivingId);
    const absorbed = this.#requireCandidate(state, mergedId);
    if (survivor.category !== absorbed.category) {
      fail(
        Errors.VALIDATION,
        "不同类别代表不同候选资格，应使用身份关联而非吸收归并"
      );
    }
    return this.#append(
      Event.CANDIDATES_MERGED,
      {
        survivingId: canonicalCandidateId(state, survivingId),
        mergedId,
        basis,
        reason,
      },
      actor
    );
  }

  linkTeamMember({ teamCandidateId, personCandidateId, role }, actor = "秘书处") {
    const state = this.state();
    const team = this.#requireCandidate(state, teamCandidateId);
    this.#requireCandidate(state, personCandidateId);
    if (team.candidateType !== "TEAM") {
      fail(Errors.VALIDATION, `${teamCandidateId} 不是团队候选`);
    }
    return this.#append(
      Event.TEAM_LINKED,
      { teamCandidateId, personCandidateId, role },
      actor
    );
  }

  /* ---------------- 成果与证据 ---------------- */

  /**
   * 申报成果。个人与团队的共同成果使用同一 achievementId/dedupeKey，
   * 各候选分别声明贡献，避免重复计入。
   */
  declareAchievement(
    { achievementId, title, summary = "", candidateIds, dedupeKey = null },
    actor = "秘书处"
  ) {
    const state = this.state();
    if (state.achievements[achievementId]) {
      fail(Errors.VALIDATION, `成果 ${achievementId} 已存在`);
    }
    if (dedupeKey) {
      const dup = Object.values(state.achievements).find(
        (a) => a.dedupeKey === dedupeKey
      );
      if (dup) {
        fail(
          Errors.VALIDATION,
          `成果与 ${dup.id} 疑似重复（dedupeKey 相同），请关联共同成果而非重复申报`,
          { duplicateOf: dup.id }
        );
      }
    }
    for (const id of candidateIds) this.#requireCandidate(state, id);
    return this.#append(
      Event.ACHIEVEMENT_DECLARED,
      { achievementId, title, summary, candidateIds, dedupeKey },
      actor
    );
  }

  decideContribution({ achievementId, candidateId, contribution }, actor = "秘书处") {
    const state = this.state();
    const achievement = state.achievements[achievementId];
    if (!achievement) fail(Errors.NOT_FOUND, `成果 ${achievementId} 不存在`);
    if (!achievement.candidateIds.includes(candidateId)) {
      fail(Errors.VALIDATION, "该候选不在成果署名名单内");
    }
    return this.#append(
      Event.ACHIEVEMENT_CREDIT_DECIDED,
      { achievementId, candidateId, contribution },
      actor
    );
  }

  submitEvidence(
    {
      evidenceId,
      candidateId,
      achievementId = null,
      evidenceType,
      source,
      content, // 原件内容（字符串或 Buffer），用于计算哈希
      label = "原件",
    },
    actor = "推荐机构"
  ) {
    const state = this.state();
    this.#requireCandidate(state, candidateId);
    const edition = state.editions[state.candidates[candidateId].editionId];
    assertBeforeDeadline(edition, "evidence", this.clock());
    if (state.evidences[evidenceId]) {
      fail(Errors.VALIDATION, `证据 ${evidenceId} 已存在`);
    }
    return this.#append(
      Event.EVIDENCE_SUBMITTED,
      {
        evidenceId,
        candidateId,
        achievementId,
        evidenceType,
        source,
        originalHash: fingerprint(content),
        label,
      },
      actor
    );
  }

  /**
   * 更正证据：原件哈希永久保留，新版本连同处理理由一起追加。
   * 补充材料受截止时间约束。
   */
  amendEvidence({ evidenceId, content, reason, label }, actor = "推荐机构") {
    const state = this.state();
    const evidence = state.evidences[evidenceId];
    if (!evidence) fail(Errors.NOT_FOUND, `证据 ${evidenceId} 不存在`);
    if (!reason || !reason.trim()) {
      fail(Errors.VALIDATION, "证据更正必须填写处理理由");
    }
    const candidate = state.candidates[evidence.candidateId];
    const edition = state.editions[candidate.editionId];
    assertBeforeDeadline(edition, "evidenceSupplement", this.clock());
    return this.#append(
      Event.EVIDENCE_AMENDED,
      { evidenceId, newHash: fingerprint(content), reason, label },
      actor
    );
  }

  recordFactVerdict({ evidenceId, verdict, note = "" }, actor = "事实核验组") {
    const state = this.state();
    const evidence = state.evidences[evidenceId];
    if (!evidence) fail(Errors.NOT_FOUND, `证据 ${evidenceId} 不存在`);
    const edition = state.editions[state.candidates[evidence.candidateId].editionId];
    const reopened = evidence.versions.length > 1;
    if (edition.stage !== Stage.FACT_CHECK) {
      const reviewStages = [Stage.PROFESSIONAL_REVIEW, Stage.SOCIAL_REVIEW];
      if (!(reopened && reviewStages.includes(edition.stage))) {
        fail(Errors.STAGE, "事实核验只能在核验阶段进行；评审阶段仅受理被更正证据的重新核验");
      }
    }
    if (!["VERIFIED", "REJECTED"].includes(verdict)) {
      fail(Errors.VALIDATION, "核验结论只能是 VERIFIED 或 REJECTED");
    }
    return this.#append(Event.FACT_VERDICT, { evidenceId, verdict, note }, actor);
  }

  /** 候选本人确认公开范围（白名单授权）。 */
  setCandidateConsent(
    { candidateId, sections, scopeNote = "" },
    actor
  ) {
    const state = this.state();
    const candidate = this.#requireCandidate(state, candidateId);
    const valid = Object.values(ConsentSection);
    for (const section of sections) {
      if (!valid.includes(section)) {
        fail(Errors.VALIDATION, `未知公开板块 ${section}`);
      }
    }
    // actor 必须是候选人本人或其团队联系人（这里以候选本人标识为凭）
    return this.#append(
      Event.CANDIDATE_CONSENT,
      { candidateId: canonicalCandidateId(state, candidateId), sections, scopeNote },
      actor ?? candidate.teamContact ?? "候选本人"
    );
  }
}

/* ---------------- 校验辅助 ---------------- */

function validateRules(rules) {
  if (!rules || typeof rules !== "object") fail(Errors.VALIDATION, "规则为空");
  const { categories, quotas, rounds } = rules;
  if (!Array.isArray(categories) || categories.length === 0) {
    fail(Errors.VALIDATION, "至少需要一个奖项类别");
  }
  if (!quotas || categories.some((c) => !Number.isInteger(quotas[c]) || quotas[c] < 0)) {
    fail(Errors.VALIDATION, "每个类别必须配置非负整数名额");
  }
  if (!Array.isArray(rounds) || rounds.length === 0) {
    fail(Errors.VALIDATION, "至少需要配置一个评审轮次");
  }
  for (const round of rounds) {
    if (!round.roundId || !round.stage) {
      fail(Errors.VALIDATION, "轮次缺少 roundId 或 stage");
    }
  }
}

function assertBeforeDeadline(edition, key, now) {
  const deadline = edition.rules?.deadlines?.[key];
  if (deadline && new Date(now) > new Date(deadline)) {
    fail(Errors.DEADLINE, `已超过${key}截止时间 ${deadline}`, { deadline });
  }
}
