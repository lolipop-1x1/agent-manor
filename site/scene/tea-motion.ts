export const TEA_LAYOUT = {
  tableRadius: 1.55,
  tableTop: 1.13,
  agentRadius: 2.08,
  walkRadius: 3.20,
  serviceRadius: 2.4,
  serviceAngle: .65,
  cupX: -.49,
  cupZ: .89,
  cupY: 1.15,
} as const;

export const TEA_SLOT_DURATION = 16;
export const TEA_CYCLE_DURATION = TEA_SLOT_DURATION * 4;

const quarter = Math.PI / 2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const ramp = (time: number, from: number, to: number) => smooth((time - from) / (to - from));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const cycleTime = (time: number) => ((time % TEA_CYCLE_DURATION) + TEA_CYCLE_DURATION) % TEA_CYCLE_DURATION;
const angleMix = (from: number, to: number, amount: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * amount;

export function teaCupPosition(index: number) {
  const angle = index * quarter;
  const radial = TEA_LAYOUT.agentRadius - TEA_LAYOUT.cupZ;
  return {
    x: Math.sin(angle) * radial - Math.cos(angle) * TEA_LAYOUT.cupX,
    z: Math.cos(angle) * radial + Math.sin(angle) * TEA_LAYOUT.cupX,
  };
}

function serviceHeading(index: number) {
  const angle = index * quarter + TEA_LAYOUT.serviceAngle;
  const cup = teaCupPosition(index);
  return Math.atan2(cup.x - Math.sin(angle) * TEA_LAYOUT.serviceRadius, cup.z - Math.cos(angle) * TEA_LAYOUT.serviceRadius);
}

// 路径先退到椅背外侧，再沿圆弧绕行；停稳后才将壶嘴移到杯口。
export function getTeaMotion(time: number) {
  const elapsed = cycleTime(time);
  const guestIndex = Math.floor(elapsed / TEA_SLOT_DURATION);
  const slotTime = elapsed - guestIndex * TEA_SLOT_DURATION;
  const fromAngle = (guestIndex - 1) * quarter + TEA_LAYOUT.serviceAngle;
  const toAngle = guestIndex * quarter + TEA_LAYOUT.serviceAngle;
  const radialDistance = TEA_LAYOUT.walkRadius - TEA_LAYOUT.serviceRadius;
  const arcDistance = quarter * TEA_LAYOUT.walkRadius;
  let angle = fromAngle;
  let radius: number = TEA_LAYOUT.serviceRadius;
  let heading = angleMix(serviceHeading(guestIndex - 1), fromAngle, ramp(slotTime, 0, .5));
  let walkDistance = 0;
  let walkWeight = 0;

  if (slotTime >= .5 && slotTime < 1.8) {
    const progress = (slotTime - .5) / 1.3;
    radius = mix(TEA_LAYOUT.serviceRadius, TEA_LAYOUT.walkRadius, smooth(progress));
    walkDistance = radialDistance * smooth(progress);
    walkWeight = Math.sin(Math.PI * progress);
    heading = fromAngle;
  } else if (slotTime >= 1.8 && slotTime < 2.2) {
    radius = TEA_LAYOUT.walkRadius;
    walkDistance = radialDistance;
    heading = angleMix(fromAngle, fromAngle + quarter, ramp(slotTime, 1.8, 2.2));
  } else if (slotTime >= 2.2 && slotTime < 5.2) {
    const progress = (slotTime - 2.2) / 3;
    angle = mix(fromAngle, toAngle, smooth(progress));
    radius = TEA_LAYOUT.walkRadius;
    heading = angle + quarter;
    walkDistance = radialDistance + arcDistance * smooth(progress);
    walkWeight = Math.sin(Math.PI * progress);
  } else if (slotTime >= 5.2 && slotTime < 5.6) {
    angle = toAngle;
    radius = TEA_LAYOUT.walkRadius;
    heading = angleMix(toAngle + quarter, toAngle + Math.PI, ramp(slotTime, 5.2, 5.6));
    walkDistance = radialDistance + arcDistance;
  } else if (slotTime >= 5.6 && slotTime < 7) {
    const progress = (slotTime - 5.6) / 1.4;
    angle = toAngle;
    radius = mix(TEA_LAYOUT.walkRadius, TEA_LAYOUT.serviceRadius, smooth(progress));
    heading = toAngle + Math.PI;
    walkDistance = radialDistance + arcDistance + radialDistance * smooth(progress);
    walkWeight = Math.sin(Math.PI * progress);
  } else if (slotTime >= 7) {
    angle = toAngle;
    heading = angleMix(toAngle + Math.PI, serviceHeading(guestIndex), ramp(slotTime, 7, 7.6));
    walkDistance = 2 * radialDistance + arcDistance;
  }

  return {
    guestIndex,
    slotTime,
    x: Math.sin(angle) * radius,
    z: Math.cos(angle) * radius,
    heading,
    walkDistance: guestIndex * (2 * radialDistance + arcDistance) + walkDistance,
    walkWeight,
    lift: ramp(slotTime, 7.6, 8.6) * (1 - ramp(slotTime, 10.9, 11.8)),
    tilt: ramp(slotTime, 8.45, 8.9) * (1 - ramp(slotTime, 10.45, 10.85)),
    pour: ramp(slotTime, 8.95, 9.1) * (1 - ramp(slotTime, 10.3, 10.43)),
    nod: Math.sin(Math.PI * ramp(slotTime, 11.85, 12.65)) * .12,
  };
}

export function getAgentTeaPose(time: number, index: number) {
  const local = cycleTime(time - index * TEA_SLOT_DURATION);
  return {
    lift: ramp(local, 11.95, 12.95) * (1 - ramp(local, 14.35, 15.65)),
    nod: Math.sin(Math.PI * ramp(local, 11.6, 12.3)) * .11,
    attention: ramp(local, 6.5, 7.6) * (1 - ramp(local, 12.7, 14)),
  };
}
