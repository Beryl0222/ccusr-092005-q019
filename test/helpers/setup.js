import assert from "node:assert/strict";

import { createHonorsBackend, Errors, Stage } from "../../src/index.js";

export function makeClock(start = "2026-03-01T08:00:00.000Z") {
  let t = new Date(start).getTime();
  const clock = () => new Date(t).toISOString();
  clock.advance = (ms) => {
    t += ms;
    return clock();
  };
  clock.set = (iso) => {
    t = new Date(iso).getTime();
    return clock();
  };
  return clock;
}

export function frozenRules(overrides = {}) {
  return {
    categories: ["个人技术奖", "社会服务奖", "金牌团队奖"],
    quotas: { 个人技术奖: 1, 社会服务奖: 1, 金牌团队奖: 1 },
    rounds: [
      {
        roundId: "R_PRO",
        name: "专业评议",
        stage: Stage.PROFESSIONAL_REVIEW,
        scoring: { min: 0, max: 100 },
      },
      {
        roundId: "R_SOC",
        name: "社会责任审议",
        stage: Stage.SOCIAL_REVIEW,
        scoring: { min: 0, max: 100 },
      },
    ],
    tieRule: "SEQUENCE:factVote,seniority",
    deadlines: {
      evidence: "2026-04-01T00:00:00.000Z",
      evidenceSupplement: "2026-04-05T00:00:00.000Z",
    },
    ...overrides,
  };
}

export function setup() {
  const clock = makeClock();
  const backend = createHonorsBackend({ clock });
  return { clock, ...backend };
}

export function startEdition(api, rules = frozenRules()) {
  api.selection.createEdition(
    { editionId: "E1", name: "2026 年度医者荣誉", year: 2026 },
    "组委会"
  );
  api.selection.freezeRules("E1", rules, "组委会");
  api.selection.advanceStage("E1", Stage.NOMINATION, "组委会");
}

/** 断言某调用抛出指定领域错误码。 */
export async function expectError(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛出错误码 ${code}，但未抛出`);
}

export { assert, Errors, Stage };
