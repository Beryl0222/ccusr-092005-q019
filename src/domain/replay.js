import { EventJournal } from "./journal.js";
import { SelectionService } from "./service.js";

/**
 * 历史复现：以某条事件序号为界截取日志前缀（前缀天然保持哈希链有效），
 * 在其上重建完整服务，从而复现任一历史轮次当时的规则、选票、结果与公示。
 */
export function serviceAt(events, upToSeq, { clock, actor } = {}) {
  const prefix = events.filter((e) => e.seq <= upToSeq);
  return new SelectionService({ journal: new EventJournal(prefix), clock, actor });
}

export function reproduceRound(events, roundId, upToSeq = Number.POSITIVE_INFINITY, opts = {}) {
  const service = serviceAt(events, upToSeq, opts);
  const state = service.state();
  const round = state.rounds[roundId] ?? null;
  const result = state.results[roundId] ?? null;
  const report = {
    asOfSeq: Math.min(upToSeq, events.length),
    edition: {
      status: state.edition.status,
      rulesVersion: state.edition.rules?.version ?? null,
      frozenAt: state.edition.frozenAt,
      frozenBy: state.edition.frozenBy,
    },
    round: round
      ? {
          id: roundId,
          status: round.status,
          openedAt: round.openedAt,
          closedAt: round.closedAt,
          countedAt: round.countedAt,
        }
      : null,
    result: null,
    tieResolutions: [],
    awardees: null,
    publications: [],
  };
  if (result) {
    report.result = {
      perCandidate: result.perCandidate,
      ties: result.ties,
      ballotDigest: result.ballotDigest,
      quotaSnapshot: result.quotaSnapshot,
      countedAt: result.at,
    };
    report.tieResolutions = (state.tieResolutions[roundId] ?? []).map((r) => ({
      method: r.method,
      orderedCandidateIds: r.orderedCandidateIds,
      reason: r.reason,
      at: r.at,
    }));
    try {
      report.awardees = service.awardeesOf(roundId);
    } catch (e) {
      report.awardees = { unresolved: e.code, details: e.details };
    }
    report.publications = Object.values(state.publications)
      .filter((pub) => pub.roundId === roundId)
      .map((pub) => ({
        id: pub.id,
        candidateId: pub.candidateId,
        status: pub.status,
        version: pub.snapshot.version,
        corrections: pub.corrections.length,
      }));
  }
  return report;
}

/** 勘误前后对照（递归差异 + 批准人），用于向异议人清楚说明“改了什么、谁批准”。 */
export function deepDiff(before, after, prefix = "") {
  const changes = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const b = before?.[key];
    const a = after?.[key];
    if (bothPlainObjects(b, a)) {
      changes.push(...deepDiff(b, a, path));
    } else if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ path, before: b ?? null, after: a ?? null });
    }
  }
  return changes;
}

function bothPlainObjects(a, b) {
  return (
    a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)
  );
}
