// Fragment shader that renders an equirectangular or little-planet tile directly from the source photos.
// Every output pixel is projected into all photos; each frequency band is blended with a
// different sharpness so exposure differences fade smoothly while detail comes from one photo.

export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uTex;
uniform sampler2D uPose;     // 4 texels per photo: 3 rows of world->camera rotation, then rgb gain
uniform int uCount;
uniform vec2 uFull;          // full output size in pixels
uniform vec2 uTile;          // tile origin in the output (pixels, from the top left)
uniform float uCenterLon;    // heading (radians) shown in the middle of the panorama
uniform int uMode;           // 0 = equirectangular, 1 = little planet (stereographic, looking at the nadir)
uniform float uPlanetScale;  // planet: r = scale * tan(theta / 2), in output pixels
uniform float uPlanetRot;    // planet: extra heading (radians) at the top of the image
uniform float uF;            // focal length in source pixels
uniform float uK1;
uniform vec2 uTexSize;
uniform vec2 uVig;           // log vignette polynomial
uniform vec4 uBandPow;       // blend sharpness per band, finest first
uniform sampler2D uFill;     // row 0: top edge, row 1: bottom edge; rgb edge colour, a = latitude where coverage ends
uniform int uFillOn;
uniform int uFillCols;
uniform vec3 uZenith;
uniform vec3 uNadir;

out vec4 outColor;

const float PI = 3.14159265358979;

vec3 fetchBilinear(vec2 uv, float layer, float lod) {
  return textureLod(uTex, vec3(uv, layer), lod).rgb;
}

// Catmull-Rom resampling with 9 bilinear taps.
vec3 sampleCatmullRom(vec2 uv, float layer, float lod) {
  vec2 texSize = vec2(textureSize(uTex, int(floor(lod))).xy);
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / w12;
  vec2 p0 = (texPos1 - 1.0) / texSize;
  vec2 p3 = (texPos1 + 2.0) / texSize;
  vec2 p12 = (texPos1 + offset12) / texSize;
  vec3 c = vec3(0.0);
  c += fetchBilinear(vec2(p0.x, p0.y), layer, lod) * w0.x * w0.y;
  c += fetchBilinear(vec2(p12.x, p0.y), layer, lod) * w12.x * w0.y;
  c += fetchBilinear(vec2(p3.x, p0.y), layer, lod) * w3.x * w0.y;
  c += fetchBilinear(vec2(p0.x, p12.y), layer, lod) * w0.x * w12.y;
  c += fetchBilinear(vec2(p12.x, p12.y), layer, lod) * w12.x * w12.y;
  c += fetchBilinear(vec2(p3.x, p12.y), layer, lod) * w3.x * w12.y;
  c += fetchBilinear(vec2(p0.x, p3.y), layer, lod) * w0.x * w3.y;
  c += fetchBilinear(vec2(p12.x, p3.y), layer, lod) * w12.x * w3.y;
  c += fetchBilinear(vec2(p3.x, p3.y), layer, lod) * w3.x * w3.y;
  return c;
}

// Projects a world direction into photo i. Returns the pyramid-shaped feather weight (0 = outside).
float project(int i, vec3 dir, out vec2 pu, out vec2 px) {
  vec3 r0 = texelFetch(uPose, ivec2(0, i), 0).xyz;
  vec3 r1 = texelFetch(uPose, ivec2(1, i), 0).xyz;
  vec3 r2 = texelFetch(uPose, ivec2(2, i), 0).xyz;
  vec3 c = vec3(dot(r0, dir), dot(r1, dir), dot(r2, dir));
  pu = vec2(0.0);
  px = vec2(-1.0);
  if (c.z <= 0.05) return 0.0;
  pu = c.xy / c.z;
  vec2 pd = pu;
  if (uK1 != 0.0) {
    for (int k = 0; k < 6; k++) pd = pu / (1.0 + uK1 * dot(pd, pd));
  }
  vec2 halfSize = 0.5 * uTexSize;
  px = pd * uF + halfSize;
  vec2 edge = min(px, uTexSize - px) / halfSize;
  float d = min(edge.x, edge.y);
  return d <= 0.0 ? 0.0 : max(d, 1e-4);
}

void main() {
  float X = uTile.x + gl_FragCoord.x;
  float Y = uTile.y + gl_FragCoord.y;
  float lon, lat, outDensity;
  vec3 dir;
  if (uMode == 0) {
    lon = (X / uFull.x - 0.5) * 2.0 * PI + uCenterLon;
    lat = (0.5 - Y / uFull.y) * PI;
    float cl = cos(lat);
    dir = vec3(sin(lon) * cl, cos(lon) * cl, sin(lat));
    outDensity = uFull.y / PI;
  } else {
    vec2 d = vec2(X - 0.5 * uFull.x, 0.5 * uFull.y - Y);
    float r = length(d);
    float theta = 2.0 * atan(r / uPlanetScale);
    lon = (r > 1e-3 ? atan(d.x, d.y) : 0.0) + uCenterLon + uPlanetRot;
    lat = theta - 0.5 * PI;
    float st = sin(theta);
    dir = vec3(sin(lon) * st, cos(lon) * st, -cos(theta));
    float q = r / uPlanetScale;
    // The stereographic projection is conformal: the same scale in every direction.
    outDensity = 0.5 * uPlanetScale * (1.0 + q * q);
  }

  vec2 pu, px;
  float dmax = 0.0;
  for (int i = 0; i < uCount; i++) dmax = max(dmax, project(i, dir, pu, px));
  if (dmax <= 0.0) {
    outColor = vec4(0.0);
    if (uFillOn == 0) return;
    // Uncovered sky/ground beyond the photos: extend the edge colour of the column towards the pole colour.
    int col = clamp(int(fract((lon - uCenterLon) / (2.0 * PI) + 0.5) * float(uFillCols)), 0, uFillCols - 1);
    vec4 top = texelFetch(uFill, ivec2(col, 0), 0);
    vec4 bottom = texelFetch(uFill, ivec2(col, 1), 0);
    if (lat > top.a) {
      float t = clamp((lat - top.a) / (0.5 * PI - top.a), 0.0, 1.0);
      outColor = vec4(mix(top.rgb, uZenith, t * t * (3.0 - 2.0 * t)), 1.0);
    } else if (lat < bottom.a) {
      float t = clamp((bottom.a - lat) / (bottom.a + 0.5 * PI), 0.0, 1.0);
      outColor = vec4(mix(bottom.rgb, uNadir, t * t * (3.0 - 2.0 * t)), 1.0);
    }
    return;
  }

  vec2 halfSize = 0.5 * uTexSize;
  float halfDiag = length(halfSize);

  vec3 acc0 = vec3(0.0), acc1 = vec3(0.0), acc2 = vec3(0.0), acc3 = vec3(0.0);
  float sum0 = 0.0, sum1 = 0.0, sum2 = 0.0, sum3 = 0.0;

  for (int i = 0; i < uCount; i++) {
    float d = project(i, dir, pu, px);
    if (d <= 0.0) continue;
    float rel = d / dmax;
    // Skip photos that cannot contribute to even the softest band.
    if (rel < 0.02) continue;

    vec3 gain = texelFetch(uPose, ivec2(3, i), 0).rgb;
    vec2 rv = (px - halfSize) / halfDiag;
    float rr = dot(rv, rv);
    gain *= exp(-(uVig.x * rr + uVig.y * rr * rr));

    float ratio = uF * (1.0 + dot(pu, pu)) / outDensity;
    float lod = clamp(log2(max(ratio, 1.0)), 0.0, 4.0);
    vec2 uv = px / uTexSize;
    float layer = float(i);

    vec3 s0 = sampleCatmullRom(uv, layer, lod);
    vec3 s1 = fetchBilinear(uv, layer, lod + 2.0);
    vec3 s2 = fetchBilinear(uv, layer, lod + 4.0);
    vec3 s3 = fetchBilinear(uv, layer, lod + 6.0);

    float w0 = pow(rel, uBandPow.x);
    float w1 = pow(rel, uBandPow.y);
    float w2 = pow(rel, uBandPow.z);
    float w3 = pow(rel, uBandPow.w);
    acc0 += w0 * (s0 - s1) * gain;
    acc1 += w1 * (s1 - s2) * gain;
    acc2 += w2 * (s2 - s3) * gain;
    acc3 += w3 * s3 * gain;
    sum0 += w0; sum1 += w1; sum2 += w2; sum3 += w3;
  }

  vec3 color = acc3 / sum3 + acc2 / sum2 + acc1 / sum1 + acc0 / sum0;
  float edgeFade = smoothstep(0.0, 0.12, dmax);
  if (uFillOn == 1 && edgeFade < 1.0) {
    // Near the top/bottom edge of the photos, fade into the filled colour so no outline shows.
    int col = clamp(int(fract((lon - uCenterLon) / (2.0 * PI) + 0.5) * float(uFillCols)), 0, uFillCols - 1);
    vec4 top = texelFetch(uFill, ivec2(col, 0), 0);
    vec4 bottom = texelFetch(uFill, ivec2(col, 1), 0);
    if (lat > top.a - 0.15) {
      float t = clamp((lat - top.a) / (0.5 * PI - top.a), 0.0, 1.0);
      color = mix(mix(top.rgb, uZenith, t * t * (3.0 - 2.0 * t)), color, edgeFade);
    } else if (bottom.a > -1.5707 && lat < bottom.a + 0.15) {
      float t = clamp((bottom.a - lat) / (bottom.a + 0.5 * PI), 0.0, 1.0);
      color = mix(mix(bottom.rgb, uNadir, t * t * (3.0 - 2.0 * t)), color, edgeFade);
    }
  }
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
