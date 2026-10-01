/**
 * 可注入时钟。领域服务接受 { now }，测试可固定/快进时间，
 * 使“截止时间”“冻结时刻”等规则可被确定性验证。
 */
export function systemClock() {
  return { now: () => new Date() };
}

export function fixedClock(iso) {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}
