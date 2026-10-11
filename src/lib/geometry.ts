// Small 3D math helpers. Mat3 is row-major; world frame is ENU (x=East, y=North, z=Up).

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const DEG = Math.PI / 180;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const normalize = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function mulVec(m: ArrayLike<number>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Multiplies the transpose of `m` with `v` (rotation inverse for orthonormal matrices). */
export function mulVecT(m: ArrayLike<number>, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function mul(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const r = new Array<number>(9) as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

export function transpose(m: ArrayLike<number>): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Rodrigues formula: rotation matrix for the axis-angle vector `w`. */
export function expSO3(w: Vec3): Mat3 {
  const theta = Math.hypot(w[0], w[1], w[2]);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = w[0] / theta;
  const y = w[1] / theta;
  const z = w[2] / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Re-orthonormalizes a rotation matrix (Gram-Schmidt on its columns). */
export function orthonormalize(m: ArrayLike<number>): Mat3 {
  let c0: Vec3 = normalize([m[0], m[3], m[6]]);
  const c1raw: Vec3 = [m[1], m[4], m[7]];
  const d = dot(c0, c1raw);
  const c1 = normalize([c1raw[0] - d * c0[0], c1raw[1] - d * c0[1], c1raw[2] - d * c0[2]]);
  c0 = normalize(c0);
  const c2 = cross(c0, c1);
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

/** Rotation angle (radians) of a rotation matrix. */
export function rotationAngle(m: ArrayLike<number>): number {
  const tr = m[0] + m[4] + m[8];
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}

export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
}

/**
 * Camera-to-world rotation from DJI gimbal angles.
 * Camera axes: x right, y down, z forward. Yaw is a compass heading (clockwise from north),
 * pitch is positive when looking up.
 */
export function gimbalToRotation(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const forward: Vec3 = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const right0: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
  const down0 = cross(forward, right0);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const right: Vec3 = [
    right0[0] * cr + down0[0] * sr,
    right0[1] * cr + down0[1] * sr,
    right0[2] * cr + down0[2] * sr,
  ];
  const down: Vec3 = [
    down0[0] * cr - right0[0] * sr,
    down0[1] * cr - right0[1] * sr,
    down0[2] * cr - right0[2] * sr,
  ];
  return [
    right[0], down[0], forward[0],
    right[1], down[1], forward[1],
    right[2], down[2], forward[2],
  ];
}

/** Longitude (clockwise from north) and latitude of a world direction. */
export function dirToLonLat(d: Vec3): [number, number] {
  return [Math.atan2(d[0], d[1]), Math.asin(Math.max(-1, Math.min(1, d[2] / Math.hypot(d[0], d[1], d[2]))))];
}

export function lonLatToDir(lon: number, lat: number): Vec3 {
  const cl = Math.cos(lat);
  return [Math.sin(lon) * cl, Math.cos(lon) * cl, Math.sin(lat)];
}
