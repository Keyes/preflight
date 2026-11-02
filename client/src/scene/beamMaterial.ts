import { Constants, Effect, RawTexture3D, ShaderMaterial, Texture, Vector3, type Scene } from '@babylonjs/core'
import { goboTexture } from './goboLibrary'

const NAME = 'preflightBeam'

/** Cells of random values along each side of the haze noise texture, which repeats after that many (so 16 units of shader noise coordinate). */
const NOISE_CELLS = 16
/** Texels along each side of the haze noise texture. */
const NOISE_SIZE = 64

const noiseTextures = new WeakMap<Scene, RawTexture3D>()

/**
 * Smooth, repeating value noise in three dimensions as a texture, so the shader reads it with one fetch instead of
 * computing eight hashes and a trilinear mix per octave at every step along every ray.
 */
function hazeNoiseTexture(scene: Scene): RawTexture3D {
  const existing = noiseTextures.get(scene)
  if (existing) return existing
  const cells = NOISE_CELLS
  const size = NOISE_SIZE
  let seed = 1234567
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const lattice = new Float32Array(cells * cells * cells)
  for (let i = 0; i < lattice.length; i++) lattice[i] = random()
  const at = (x: number, y: number, z: number) => lattice[((z % cells) * cells + (y % cells)) * cells + (x % cells)]
  const smooth = (f: number) => f * f * (3 - 2 * f)
  const data = new Uint8Array(size * size * size)
  let o = 0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // the value of the noise at the center of this texel
        const px = ((x + 0.5) / size) * cells
        const py = ((y + 0.5) / size) * cells
        const pz = ((z + 0.5) / size) * cells
        const ix = Math.floor(px)
        const iy = Math.floor(py)
        const iz = Math.floor(pz)
        const fx = smooth(px - ix)
        const fy = smooth(py - iy)
        const fz = smooth(pz - iz)
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t
        const v = lerp(
          lerp(lerp(at(ix, iy, iz), at(ix + 1, iy, iz), fx), lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
          lerp(lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy),
          fz,
        )
        data[o++] = Math.round(v * 255)
      }
    }
  }
  const texture = new RawTexture3D(
    data,
    size,
    size,
    size,
    Constants.TEXTUREFORMAT_R,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  )
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  texture.wrapR = Texture.WRAP_ADDRESSMODE
  noiseTextures.set(scene, texture)
  return texture
}

// Note for editing the GLSL below: keep semicolons out of comments. Babylon's shader preprocessor splits
// the source at semicolons, so a comment containing one can break the shader (the second half of the
// comment ends up on its own line and fails to compile).

/**
 * Light beam in haze, drawn as a volume. The mesh is only a closed hull around the beam (starting at the lens
 * plane at the origin, opening along +Y, slightly wider than the beam itself) that decides which pixels to shade. For each pixel
 * the shader intersects the view ray with the exact cone analytically and adds up the scattered light along
 * the stretch of the ray inside it. Nothing depends on how the hull is tessellated, so there are no facets,
 * the edges are soft by construction, and looking down a beam makes it brighter, as in real haze.
 *
 * Occlusion is also done in the shader, against the scene depth map, because a hull fragment behind a wall
 * must still be able to light the part of the beam in front of that wall. So the hardware depth test is off.
 *
 * Only the hull's far-side faces do any work. The hull is convex, so every pixel it covers has exactly one far-side
 * face whether the camera is outside or inside, and the shader does its work once per pixel (the near face drops out
 * at once, where drawing both faces in full would shade every pixel twice). Each fixture needs
 * its own material instance because color, strength and shape are per-material uniforms.
 */
export function createBeamMaterial(scene: Scene, name: string): ShaderMaterial {
  Effect.ShadersStore[`${NAME}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    uniform mat4 world;
    uniform mat4 view;
    uniform mat4 worldViewProjection;
    uniform vec3 cameraPosition;
    varying vec3 vLocalPos;
    varying vec3 vLocalCam;
    varying float vViewZ;
    void main() {
      vLocalPos = position;
      // The camera in the beam's own frame (the world matrix is a rigid transform, so distances are unchanged).
      vLocalCam = (inverse(world) * vec4(cameraPosition, 1.0)).xyz;
      vViewZ = (view * world * vec4(position, 1.0)).z;
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }`

  Effect.ShadersStore[`${NAME}FragmentShader`] = `
    precision highp float;
    varying vec3 vLocalPos;
    varying vec3 vLocalCam;
    varying float vViewZ;
    uniform vec3 beamColor;
    uniform float strength;
    uniform mat4 world;
    uniform float beamLength;
    uniform float lensRadius;       // the beam leaves the fixture through a disc of this radius (half the width of the lens)
    uniform float lensHalfLength;   // or through a strip: the disc's centre slides this far either way along local x (0 for a round lens)
    uniform float tanHalf;          // tangent of the beam's half angle
    uniform float focusDistance;    // meters from the lens where the beam edge is sharpest
    uniform float focusBlur;        // how quickly the edge blurs away from that distance, relative to the lens size
    uniform float edgeFixed;        // a fixed edge softness (fraction of the beam radius) for fixtures without focus optics, or -1 to use the focus
    uniform highp sampler3D hazeNoise; // repeating value noise for the haze wisps
    uniform highp sampler2DArray goboSampler; // the gobo patterns, one layer each (white where light passes)
    uniform float faceTest;         // 1 when the shader must drop the hull's near faces itself (see main)
    uniform float goboOn;           // 1 when a gobo is in the beam
    uniform vec3 venueMin;          // the venue's bounding box in world meters: the haze (and so the beam) ends at its walls
    uniform vec3 venueMax;
    uniform float venueClip;        // 1 when the box is known
    uniform vec4 crowdRect[8];      // the crowd zones that absorb light: min x, min z, max x, max z in world meters
    uniform vec4 crowdInfo[8];      // and for each: the height of its floor and of its top, and how strongly it absorbs per meter
    uniform vec4 crowdBounds;       // one box around all of them: min x, min z, max x, max z, to skip lines that miss every zone
    uniform vec2 crowdLevels;       // and the lowest floor and the highest top of the zones
    uniform int crowdCount;         // how many of them there are (a loop bound that is a uniform, so the compiler does not copy the loop out for every step)
    uniform float goboLayer;        // which pattern
    uniform float goboAngle;        // its rotation in radians
    uniform float goboSpin;         // and how fast it turns, in turns per second
    uniform sampler2D depthSampler; // camera-space distance of the nearest solid surface per pixel, 0 where there is none
    uniform vec2 screenSize;        // render size in pixels, to turn gl_FragCoord into a texture coordinate
    uniform float softDistance;     // meters over which light fades out before a surface (0 for a hard cut)
    uniform sampler2D shadowSampler; // the scene as seen from the lens: camera-space distance of the first solid surface, 0 where there is none
    uniform mat4 lightView;          // view matrix of that lens camera
    uniform float lightTanHalf;      // tangent of its half field of view (the view is square)
    uniform float shadowEnabled;     // 1 when this light casts shadows
    uniform float shadowBias;        // meters of tolerance before something counts as behind a blocker
    uniform float hazeMotion;        // how strongly the haze varies in space and time (0 for an even haze)
    uniform float hazeTime;          // seconds, for moving the haze

    const int STEPS = 16;
    // Widest half-width of the soft edge, as a fraction of the beam radius (keep in sync with MAX_EDGE in FixtureRig.ts).
    // The beam is drawn this much wider than its geometric cone, so a soft edge straddles the cone's edge.
    const float EDGE_MAX = 0.5;

    // The view ray in world space and in the lens camera's space, as origin plus direction times t. Both are straight
    // lines, so they are worked out once per pixel and every step along the ray only adds.
    vec3 gWorldO;
    vec3 gWorldD;
    vec3 gLensO;
    vec3 gLensD;
    // How much of the light the crowd lets through at the last step that worked it out, and the number of the step now:
    // the crowd's effect changes slowly along a ray, so it is worked out at every other step and reused at the one after.
    float gCrowd = -1.0;
    int gStep = 0;

    // Distance from a point on the xz plane to the strip the light leaves through (a plain point for a round lens).
    float segmentDistance(vec2 q) {
      return length(vec2(max(abs(q.x) - lensHalfLength, 0.0), q.y));
    }

    // Smooth noise in three dimensions, read from a repeating texture of value noise (one cell per unit).
    float valueNoise(vec3 x) {
      return texture(hazeNoise, x * ${1 / NOISE_CELLS}).r;
    }

    // How thick the haze is at a point in the room, around 1 on average. It is a slowly drifting, slowly changing
    // field fixed in the room, so every beam crossing a spot sees the same haze there.
    float hazeField(vec3 pw) {
      vec3 drift = vec3(0.16, 0.05, -0.11) * hazeTime;
      float big = valueNoise(pw * 0.5 + drift + vec3(0.0, hazeTime * 0.04, 0.0));
      float fine = valueNoise(pw * 1.4 - drift * 1.6 + vec3(17.0, 3.0, 9.0));
      float n = 0.65 * big + 0.35 * fine;
      return clamp(1.0 + (n - 0.5) * 4.2, 0.0, 2.3);
    }

    // Does the light reach this point (given in the shifted beam frame), or is something between it and the lens?
    // The lens's own view of the scene tells how far its light travels in this direction before it hits something.
    float lightReaches(float t) {
      if (shadowEnabled < 0.5) return 1.0;
      vec3 lv = gLensO + gLensD * t;
      if (lv.z < 0.05) return 1.0;
      vec2 suv = 0.5 + 0.5 * lv.xy / (lv.z * lightTanHalf);
      if (suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0) return 1.0;
      float blocker = texture2D(shadowSampler, suv).r;
      return (blocker > 0.0 && lv.z > blocker + shadowBias) ? 0.0 : 1.0;
    }

    // How much of the light that leaves the lens at point a still reaches point b after crossing the crowd. A crowd zone
    // is a box, and the light is absorbed along the stretch of the straight line a to b that lies inside it, so haze behind
    // or in a crowd gets dim while haze above the heads, which the light reaches over them, stays bright.
    float crowdTransmit(vec3 a, vec3 b) {
      // a line that stays above all the zones, below them, or beside all of them crosses no crowd
      if (min(a.y, b.y) > crowdLevels.y || max(a.y, b.y) < crowdLevels.x) return 1.0;
      if (min(a.x, b.x) > crowdBounds.z || max(a.x, b.x) < crowdBounds.x || min(a.z, b.z) > crowdBounds.w || max(a.z, b.z) < crowdBounds.y) return 1.0;
      vec3 d = b - a;
      vec3 safe = mix(d, vec3(1e-5), lessThan(abs(d), vec3(1e-5)));
      vec3 inv = 1.0 / safe;
      float len = length(d);
      float absorbed = 0.0;
      for (int i = 0; i < crowdCount; i++) {
        vec4 r = crowdRect[i];
        vec4 h = crowdInfo[i];
        vec3 t0 = (vec3(r.x, h.x, r.y) - a) * inv;
        vec3 t1 = (vec3(r.z, h.y, r.w) - a) * inv;
        vec3 lo = min(t0, t1);
        vec3 hi = max(t0, t1);
        float enter = max(max(lo.x, lo.y), max(lo.z, 0.0));
        float leave = min(min(hi.x, hi.y), min(hi.z, 1.0));
        absorbed += max(0.0, leave - enter) * len * h.z;
      }
      return exp(-absorbed);
    }

    // How much scattered light a unit of path contributes at point p: soft edge toward the rim, fading toward the
    // far end, fading out before a surface, per diameter of the beam there.
    float beamDensity(vec3 p, float y0, float t, float sceneT) {
      float y = max(p.y, 1e-4);
      float along = y - y0; // distance from the lens
      float beamRadius = tanHalf * y;
      float r = segmentDistance(vec2(p.x, p.z)) / beamRadius;
      // Focus: the lens images the edge sharply at one distance and blurs it on either side, by a blur circle that grows
      // with the lens opening and with the distance from the focus. The blur is centered on the geometric edge, so the
      // beam keeps its width and only its rim turns soft.
      float blur = focusBlur * lensRadius * abs(along - focusDistance) / focusDistance;
      float edge = edgeFixed >= 0.0 ? min(edgeFixed, EDGE_MAX) : clamp(blur / beamRadius + 0.02, 0.02, EDGE_MAX);
      float profile = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
      float axial = pow(clamp(1.0 - along / beamLength, 0.0, 1.0), 1.2) * smoothstep(0.0, 0.05, along);
      float diameter = 2.0 * tanHalf * y;
      float soft = 1.0;
      if (softDistance > 0.0) {
        float away = clamp((sceneT - t) / softDistance, 0.0, 1.0);
        soft = away * away * (3.0 - 2.0 * away);
      }
      float wisps = 1.0;
      if (hazeMotion > 0.001) {
        wisps = mix(1.0, hazeField(gWorldO + gWorldD * t), hazeMotion);
      }
      // A gobo is a pattern at the lens that the beam projects: where the ray crosses the cone, the point's position
      // across the beam (in beam radii) is the position in the pattern. It is sharp at the focus distance, and away
      // from it the same blur that softens the edge softens the pattern, by reading a smaller mipmap level.
      float gobo = 1.0;
      if (goboOn > 0.5) {
        float turn = goboAngle + goboSpin * hazeTime * 6.2831853;
        float cs = cos(turn);
        float sn = sin(turn);
        vec2 across = vec2(p.x, p.z) / beamRadius;
        across = vec2(cs * across.x - sn * across.y, sn * across.x + cs * across.y);
        float texels = max(edge, 0.02) * 64.0;
        gobo = textureLod(goboSampler, vec3(0.5 + 0.5 * across, goboLayer), log2(1.0 + texels)).r;
      }
      // The crowd absorbs light on its way from the lens (the nearest point of a strip lens) to this point.
      float crowd = 1.0;
      if (crowdCount > 0 && shadowEnabled < 0.5) { // a beam with a shadow view of its own sees the people themselves
        if ((gStep & 1) == 1 || gCrowd < 0.0) {
          vec3 lens = world[3].xyz + world[0].xyz * clamp(p.x, -lensHalfLength, lensHalfLength);
          gCrowd = crowdTransmit(lens, gWorldO + gWorldD * t);
        }
        crowd = gCrowd;
      }
      return profile * axial * soft * wisps * gobo * crowd / diameter;
    }

    // The part of a ray, within [tLo, tHi], that lies inside a cone around the +Y axis with its apex at the origin
    // (callers shift the ray to put a cone's apex there). False when there is none.
    bool coneInterval(vec3 O, vec3 D, float tLo, float tHi, float tanC, out float c0, out float c1) {
      float k = tanC * tanC;
      float qa = D.x * D.x + D.z * D.z - k * D.y * D.y;
      float qb = 2.0 * (O.x * D.x + O.z * D.z - k * O.y * D.y);
      float qc = O.x * O.x + O.z * O.z - k * O.y * O.y;
      c0 = tLo;
      c1 = tHi;
      if (abs(qa) < 1e-7) {
        // The ray runs parallel to the cone's surface: the inside is a half line.
        if (abs(qb) < 1e-9) {
          if (qc > 0.0) return false;
        } else {
          float tr = -qc / qb;
          if (qb > 0.0) c1 = min(c1, tr); else c0 = max(c0, tr);
        }
      } else {
        float disc = qb * qb - 4.0 * qa * qc;
        if (disc < 0.0) {
          // No crossing: always inside the double cone (qa below zero) or never.
          if (qa > 0.0) return false;
        } else {
          float sq = sqrt(disc);
          float r0 = (-qb - sq) / (2.0 * qa);
          float r1 = (-qb + sq) / (2.0 * qa);
          float rl = min(r0, r1);
          float rh = max(r0, r1);
          if (qa > 0.0) {
            // Crossing from side to side: inside between the two roots.
            c0 = max(c0, rl);
            c1 = min(c1, rh);
          } else {
            // Looking along the beam: inside before the first root and after the second one. Only one of
            // those parts lies on the beam's side of the apex, and the start and end planes already took care of it.
            float s0 = tLo;
            float e0 = min(tHi, rl);
            float s1 = max(tLo, rh);
            float e1 = tHi;
            bool v0 = e0 > s0;
            bool v1 = e1 > s1;
            if (v0 && v1) { c0 = s0; c1 = e1; }
            else if (v0) { c0 = s0; c1 = e0; }
            else if (v1) { c0 = s1; c1 = e1; }
            else return false;
          }
        }
      }
      return c1 > c0;
    }

    // Keeps the part of [c0, c1] where a + b t is at most zero.
    void clipLinear(inout float c0, inout float c1, float a, float b) {
      if (abs(b) < 1e-9) {
        if (a > 0.0) c1 = c0 - 1.0;
      } else if (b > 0.0) {
        c1 = min(c1, -a / b);
      } else {
        c0 = max(c0, -a / b);
      }
    }

    void main() {
      vec3 O = vLocalCam;
      // Where the hull is drawn with both faces (faceTest), only the one where the view ray leaves it does any work. The
      // face's outward direction comes from its own geometry (the screen-space slope of its position, turned to point away
      // from a point inside the hull), so it does not depend on how the triangles are wound.
      vec3 faceN = vec3(0.0);
      if (faceTest > 0.5) {
        faceN = cross(dFdx(vLocalPos), dFdy(vLocalPos));
        if (dot(faceN, vLocalPos - vec3(0.0, 0.5 * beamLength, 0.0)) < 0.0) faceN = -faceN;
      }
      if (faceTest > 0.5 && dot(faceN, vLocalPos - O) <= 0.0) discard;
      vec3 D = vLocalPos - O;
      float tFrag = length(D);
      D /= tFrag;

      // The beam widens from the lens opening at the zoom angle, so it is a cone whose apex lies behind the lens.
      // Shift the frame so that apex is the origin, which keeps the cone math simple (y is then the distance
      // from that virtual apex, and the lens plane is at y0).
      float y0 = lensRadius / tanHalf;
      O.y += y0;
      gWorldO = (world * vec4(O - vec3(0.0, y0, 0.0), 1.0)).xyz;
      gWorldD = mat3(world) * D;
      gLensO = (lightView * vec4(gWorldO, 1.0)).xyz;
      gLensD = mat3(lightView) * gWorldD;
      float yEnd = y0 + beamLength;

      // Distance along this ray to the nearest solid surface. View depth is proportional to distance along a ray,
      // so the fragment's own view depth gives the scale. No surface means unlimited.
      float sceneZ = texture2D(depthSampler, gl_FragCoord.xy / screenSize).r;
      float sceneT = sceneZ > 0.0 ? tFrag * sceneZ / vViewZ : 1e5;

      // The part of the ray between the beam's start and end planes (the lens and beamLength further on), in front of any surface.
      float tLo = 0.0;
      float tHi = min(sceneT, 1e5);
      if (abs(D.y) < 1e-6) {
        if (O.y < y0 || O.y > yEnd) discard;
      } else {
        float tA = (y0 - O.y) / D.y;
        float tB = (yEnd - O.y) / D.y;
        tLo = max(tLo, min(tA, tB));
        tHi = min(tHi, max(tA, tB));
      }
      // The haze fills the venue and nothing outside it, so a beam that leaves through an opening (a door, an arch, a
      // window) ends where it passes the model's bounding box instead of running on for its full length.
      if (venueClip > 0.5) {
        vec3 inv = 1.0 / (gWorldD + vec3(1e-9));
        vec3 q0 = (venueMin - gWorldO) * inv;
        vec3 q1 = (venueMax - gWorldO) * inv;
        tLo = max(tLo, max(max(min(q0.x, q1.x), min(q0.y, q1.y)), min(q0.z, q1.z)));
        tHi = min(tHi, min(min(max(q0.x, q1.x), max(q0.y, q1.y)), max(q0.z, q1.z)));
      }
      if (tHi <= tLo) discard;

      // Where that stretch is inside the beam. A round lens gives a cone: x^2 + z^2 <= tan^2 * y^2, solved for the ray
      // as a quadratic. A strip-shaped lens gives that cone swept along the strip (a sheet with rounded ends), which is
      // the two cones at the ends of the strip joined by a slab between them, and the beam is the union of the three.
      float tanClip = tanHalf * (1.0 + EDGE_MAX);
      float c0 = 0.0;
      float c1 = 0.0;
      bool found = false;
      float a0;
      float a1;
      if (coneInterval(O - vec3(lensHalfLength, 0.0, 0.0), D, tLo, tHi, tanClip, a0, a1)) {
        c0 = a0;
        c1 = a1;
        found = true;
      }
      if (lensHalfLength > 1e-5) {
        if (coneInterval(O + vec3(lensHalfLength, 0.0, 0.0), D, tLo, tHi, tanClip, a0, a1)) {
          if (found) { c0 = min(c0, a0); c1 = max(c1, a1); } else { c0 = a0; c1 = a1; found = true; }
        }
        float m0 = tLo;
        float m1 = tHi;
        clipLinear(m0, m1, O.z - tanClip * O.y, D.z - tanClip * D.y);
        clipLinear(m0, m1, -O.z - tanClip * O.y, -D.z - tanClip * D.y);
        clipLinear(m0, m1, O.x - lensHalfLength, D.x);
        clipLinear(m0, m1, -O.x - lensHalfLength, -D.x);
        if (m1 > m0) {
          if (found) { c0 = min(c0, m0); c1 = max(c1, m1); } else { c0 = m0; c1 = m1; found = true; }
        }
      }
      if (!found || c1 <= c0) discard;

      // Add up the scattered light along that stretch, as a sum over short pieces of the ray. Each piece counts for
      // the fraction of the beam's own diameter that it covers, so a beam seen from the side looks equally bright
      // whatever its width, and looking down the beam adds up to much more. Pieces in shadow add nothing.
      //
      // Two things keep the shadows crisp. Whether a piece is lit is only checked at its ends, so where the two
      // differ the exact position of the shadow edge is found by halving the piece a few times. And the piece
      // boundaries are shifted by a different amount for each pixel, so thin shadows and the piece boundaries
      // themselves turn into fine grain instead of bands across the beam.
      float dt = (c1 - c0) / float(STEPS);
      float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float sum = 0.0;
      float tA = c0;
      float vA = lightReaches(tA);
      gCrowd = -1.0;
      for (int k = 1; k <= STEPS + 1; k++) {
        gStep = k;
        float tB = k > STEPS ? c1 : min(c0 + (float(k - 1) + jit) * dt, c1);
        if (tB > tA) {
          float vB = lightReaches(tB);
          float len = tB - tA;
          float litLen = 0.0;
          if (vA > 0.5 && vB > 0.5) {
            litLen = len;
          } else if (vA > 0.5 || vB > 0.5) {
            float lo = tA;
            float hi = tB;
            for (int b = 0; b < 6; b++) {
              float mid = 0.5 * (lo + hi);
              if ((lightReaches(mid) > 0.5) == (vA > 0.5)) lo = mid; else hi = mid;
            }
            float edge = 0.5 * (lo + hi);
            litLen = vA > 0.5 ? edge - tA : tB - edge;
          }
          if (litLen > 0.0) {
            float tm = tA + 0.5 * len;
            sum += beamDensity(O + D * tm, y0, tm, sceneT) * litLen;
          }
          tA = tB;
          vA = vB;
        }
      }

      // Light saturates rather than adding without limit.
      float shown = 1.0 - exp(-strength * sum);
      // The brightness is tuned by eye as a display value, but the scene is rendered in linear light
      // (gamma is applied at the end), so convert it.
      float a = pow(max(shown, 0.0), 2.2);

      gl_FragColor = vec4(beamColor * a, 1.0);
    }`

  const material = new ShaderMaterial(
    name,
    scene,
    { vertex: NAME, fragment: NAME },
    {
      attributes: ['position'],
      uniforms: [
        'world',
        'view',
        'worldViewProjection',
        'cameraPosition',
        'beamColor',
        'strength',
        'beamLength',
        'lensRadius',
        'lensHalfLength',
        'hazeMotion',
        'hazeTime',
        'tanHalf',
        'focusDistance',
        'focusBlur',
        'edgeFixed',
        'screenSize',
        'softDistance',
        'lightView',
        'lightTanHalf',
        'shadowEnabled',
        'shadowBias',
        'venueMin',
        'venueMax',
        'venueClip',
        'crowdRect',
        'crowdInfo',
        'crowdBounds',
        'crowdLevels',
        'crowdCount',
        'goboOn',
        'goboLayer',
        'goboAngle',
        'goboSpin',
        'faceTest',
      ],
      samplers: ['depthSampler', 'shadowSampler', 'hazeNoise', 'goboSampler'],
    },
  )
  material.setTexture('hazeNoise', hazeNoiseTexture(scene))
  material.setTexture('goboSampler', goboTexture(scene))
  material.setFloat('goboOn', 0)
  material.setVector3('venueMin', new Vector3(0, 0, 0))
  material.setVector3('venueMax', new Vector3(0, 0, 0))
  material.setFloat('venueClip', 0)
  material.setArray4('crowdRect', new Array(32).fill(0))
  material.setArray4('crowdInfo', new Array(32).fill(0))
  material.setInt('crowdCount', 0)
  material.setArray4('crowdBounds', [0, 0, 0, 0])
  material.setArray2('crowdLevels', [0, 0])
  material.alphaMode = Constants.ALPHA_ONEONE // plain addition: the shader outputs the light it adds
  material.disableDepthWrite = true
  material.depthFunction = Constants.ALWAYS // occlusion is done in the shader against the depth map
  material.needAlphaBlending = () => true
  return material
}
