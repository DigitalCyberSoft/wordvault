/*
 * game-fx.js - the holographic vault: a WebGL shader scene that replaces the
 * SVG cross-section lock when the device can run it.
 *
 * Same contract as every other presentation layer: NO grading lives here.
 * game-ui.js pushes state snapshots (FX.set) and event pulses (FX.pulse);
 * this file only draws them. If WebGL is missing, mount() refuses, the html
 * root never gets the `fx` class, and the SVG vault renders exactly as
 * before - the game is complete without this file ever succeeding.
 *
 * The whole lock is one fragment shader over one triangle: a glass panel,
 * a row of energy pin cells (the tumblers), three segmented holo rings that
 * quarter-turn per seat (the dial), a plasma core that charges, a bolt that
 * retracts, and an eight-blade iris that opens on the crack. All easing is
 * computed CPU-side per frame and handed over as uniforms, so under
 * prefers-reduced-motion there is no animation loop at all: state changes
 * render one static frame with every transient at its end state.
 */
(function () {
  'use strict';

  var VERT = [
    'attribute vec2 a;',
    'void main(){ gl_Position = vec4(a, 0.0, 1.0); }'
  ].join('\n');

  var FRAG = [
    // highp where the GPU has it (any tablet this decade); mediump fallback
    // wraps time-derived values so nothing leaves the 2^14 mediump range fast
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 u_res;',
    'uniform float u_time;',   // wrapped seconds; multiplied out for idle motion under reduced motion
    'uniform float u_anim;',   // 1 = animate idle drift, 0 = reduced motion (static)
    'uniform float u_need;',   // pins in this lock (2..5)
    'uniform float u_pins[5];',// eased seat level per pin, 0..1
    'uniform float u_misses;', // lamps lit (0..3)
    'uniform float u_charge;', // eased seated/need, drives the core
    'uniform float u_dial;',   // accumulated quarter turns, spring-eased
    'uniform float u_bolt;',   // 0 locked .. 1 retracted
    'uniform float u_iris;',   // 0 shut .. 1 open
    'uniform float u_boot;',   // seconds since encounter boot sweep (1e3 = long ago)
    'uniform float u_seatT;',  // seconds since last pin seat
    'uniform float u_seatI;',  // which pin seated last
    'uniform float u_springT;',// seconds since a relock drain
    'uniform float u_alarmT;', // seconds since the klaxon
    'uniform float u_openT;',  // seconds since the crack began
    'uniform float u_clock;',  // lock-timer fraction remaining; negative = no clock
    'uniform float u_failT;',  // seconds since a lock failure (wrong word or timeout)
    'uniform float u_failK;',  // failure flavour: 0 wrong word, 1 timed out
    'uniform vec3 u_accent;',  // holo tint (cosmetic skins recolour this)
    'uniform vec3 u_pinc;',    // seated-cell tint (pins cosmetic)',
    '',
    'float hash11(float n){ return fract(sin(n * 127.1) * 43758.5453); }',
    'float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i), b = hash21(i + vec2(1, 0));',
    '  float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
    'float fbm(vec2 p){ return vnoise(p) * .62 + vnoise(p * 2.03) * .38; }',
    'float sdRoundBox(vec2 p, vec2 b, float r){',
    '  vec2 q = abs(p) - b + r;',
    '  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;',
    '}',
    'float sdSeg(vec2 p, vec2 a, vec2 b){',
    '  vec2 pa = p - a, ba = b - a;',
    '  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
    '  return length(pa - ba * h);',
    '}',
    // soft line/edge helpers; fixed-width AA so no derivative extension is
    // needed. smoothstep edges must ascend (GLSL ES §8.3: undefined otherwise).
    'float fill(float d, float aa){ return 1.0 - smoothstep(-aa, aa, d); }',
    'float line(float d, float w, float aa){ return 1.0 - smoothstep(w - aa, w + aa, abs(d)); }',
    'float glow(float d, float w){ return w / (w + max(d, 0.0) * max(d, 0.0)); }',
    '',
    'void main(){',
    '  float t = u_time;',
    '  float it = t * u_anim;', // idle time: frozen under reduced motion
    // design space: 640x420 box centred in the canvas, y up
    '  float scale = min(u_res.x / 640.0, u_res.y / 420.0);',
    '  vec2 p = (gl_FragCoord.xy - u_res * 0.5) / scale;',
    '  float aa = 1.2 / scale;',
    '',
    // glitch: row shear during relock (small) and alarm (big), decaying
    '  float gAmp = 9.0 * exp(-u_springT * 7.0) + 26.0 * exp(-u_alarmT * 3.0) + 16.0 * exp(-u_failT * 5.0);',
    '  float row = floor((p.y + 500.0) / 13.0);',
    '  float gRnd = hash11(row + floor(mod(t, 60.0) * 24.0) * 7.0);',
    '  p.x += (gRnd - 0.5) * gAmp * step(0.4, gRnd);',
    '',
    '  vec3 accent = u_accent;',
    '  vec3 gold = vec3(1.0, 0.80, 0.34);',
    '  vec3 red = vec3(1.0, 0.30, 0.22);',
    '  vec3 col = vec3(0.0);',
    '',
    '  float dPanel = sdRoundBox(p, vec2(300.0, 192.0), 24.0);',
    '  float inPanel = fill(dPanel, aa);',
    '',
    // panel body: deep glass, faint diagonal weave, drifting sheen
    '  vec3 body = mix(vec3(0.030, 0.058, 0.102), vec3(0.016, 0.030, 0.058), (p.y + 192.0) / 384.0);',
    '  body += accent * 0.030 * fbm(p * 0.013 + vec2(it * 0.05, 0.0));',
    '  float grid = line(mod(p.x + p.y, 34.0) - 17.0, 0.7, aa) + line(mod(p.x - p.y, 34.0) - 17.0, 0.7, aa);',
    '  body += accent * grid * 0.028;',
    '  col += body * inPanel;',
    '',
    // boot sweep: one bright scanline runs down the panel when a job arms
    '  float sweepY = 192.0 - u_boot * 640.0;',
    '  col += accent * inPanel * exp(-abs(p.y - sweepY) * 0.05) * exp(-u_boot * 2.4) * 0.9;',
    '',
    '  vec2 core = vec2(0.0, -52.0);',
    '  vec2 pc = p - core;',
    '  float rc = length(pc);',
    '  float ang = atan(pc.y, pc.x);',
    '  float TAU = 6.2831853;',
    '',
    // ---- front face of the door: pins, conduits, rings, orb, bolt, lamps ----
    '  vec3 face = vec3(0.0);',
    '',
    // energy pin cells across the top; the lock grows pins with the band
    '  for (int i = 0; i < 5; i++) {',
    '    if (float(i) >= u_need) { continue; }',
    '    float fi = float(i);',
    '    vec2 c = vec2((fi - (u_need - 1.0) * 0.5) * 82.0, 118.0);',
    '    vec2 q = p - c;',
    '    float lv = u_pins[i];',
    // conduit from cell to the ring stack, lit while its pin holds charge
    '    vec2 endc = core + normalize(c - core) * 122.0;',
    '    float dw = sdSeg(p, c - vec2(0.0, 22.0), endc);',
    '    face += mix(accent * 0.12, mix(accent, gold, 0.4) * (0.55 + 0.20 * sin(it * 5.0 - fi)), lv) * glow(dw, 2.4);',
    // socket ring
    '    float dsock = abs(length(q) - 24.0);',
    '    face += mix(accent * 0.35, accent, lv) * line(dsock, 2.0, aa) * 0.9;',
    '    face += accent * glow(dsock, 1.6) * 0.25;',
    // cell: fills bottom-up as the pin seats; seated cells hum
    '    float dcell = length(q) - 17.0;',
    '    float filled = fill(dcell, aa) * step(q.y, mix(-19.0, 19.0, lv));',
    '    vec3 cellc = mix(accent, u_pinc, 0.75);',
    '    face += cellc * filled * (0.75 + 0.25 * sin(it * 3.0 + fi * 1.7) * lv);',
    '    face += cellc * glow(dcell, 3.0) * lv * 0.5;',
    // the seat moment: an expanding ring snaps outward from this cell
    '    if (abs(fi - u_seatI) < 0.5) {',
    '      float st = u_seatT;',
    '      face += gold * line(length(q) - (24.0 + st * 190.0), 3.0, aa + st * 4.0) * exp(-st * 5.0);',
    '    }',
    // lock failure: charge arcs violently down the conduit while the cell drains
    '    float dis = exp(-u_failT * 6.0) * lv;',
    '    if (dis > 0.02) {',
    '      vec2 jp = p;',
    '      jp.x += (hash21(vec2(floor(p.y / 7.0), floor(mod(t, 10.0) * 40.0))) - 0.5) * 9.0;',
    '      float darc = sdSeg(jp, c - vec2(0.0, 22.0), endc);',
    '      face += vec3(1.0, 0.9, 0.6) * glow(darc, 1.4) * dis * 1.6;',
    '    }',
    '  }',
    '',
    // tick ring: 24 static graduations, the instrument face
    '  float ticks = step(0.82, fract(ang / TAU * 24.0)) * line(rc - 128.0, 5.0, aa);',
    '  face += accent * ticks * 0.35;',
    '',
    // the lock-timer arc: a cyan fuse burning clockwise from the top; goes
    // amber and pulses when time runs short
    '  if (u_clock >= 0.0) {',
    '    float c01 = fract(atan(pc.x, pc.y) / TAU);',
    '    float lit = 1.0 - step(u_clock, c01);',
    '    vec3 cc = mix(vec3(1.0, 0.72, 0.30), accent, smoothstep(0.20, 0.50, u_clock));',
    '    float urge = u_clock < 0.33 ? 0.72 + 0.28 * sin(t * 10.0) : 1.0;',
    '    face += cc * lit * line(rc - 138.0, 3.0, aa) * urge;',
    '    face += cc * lit * glow(abs(rc - 138.0), 2.0) * 0.30 * urge;',
    '  }',
    '',
    // three segmented rings; the dial spring turns them opposite ways. A
    // timeout winds them BACKWARDS: the lock re-seals itself.
    '  float turn = u_dial * 1.5708;',
    '  float spinUp = exp(-u_boot * 1.8) * 6.0 + exp(-u_openT * 1.2) * 9.0 - 7.0 * exp(-u_failT * 2.0) * u_failK;',
    '  for (int k = 0; k < 3; k++) {',
    '    float fk = float(k);',
    '    float R = 112.0 - fk * 23.0;',
    '    float dir = mix(1.0, -1.0, mod(fk, 2.0));',
    '    float rot = dir * (turn * (1.0 - fk * 0.25) + it * (0.05 + fk * 0.04) + spinUp);',
    '    float seg = step(0.30, fract(ang / TAU * (6.0 + fk * 3.0) + rot));',
    '    float dr = abs(rc - R);',
    '    float bright = 0.45 + 0.55 * u_charge;',
    '    face += accent * seg * line(dr, 3.2, aa) * bright;',
    '    face += accent * seg * glow(dr, 2.2) * 0.30 * bright;',
    '  }',
    '',
    // plasma core: swirled noise inside the innermost ring, fed by charge
    '  float orb = fill(rc - 44.0, aa);',
    '  float swirl = fbm(vec2(ang * 1.6 + it * 0.5, rc * 0.06 - it * 0.35));',
    '  vec3 orbc = mix(accent * 0.16, accent, swirl) * (0.28 + 0.85 * u_charge);',
    '  orbc += gold * pow(max(1.0 - rc / 44.0, 0.0), 2.2) * u_charge * (0.8 + 0.2 * sin(it * 1.3));',
    '  face += orbc * orb;',
    '  face += accent * line(rc - 44.0, 1.8, aa) * (0.5 + 0.5 * u_charge);',
    '  face += accent * glow(rc - 44.0, 5.0) * u_charge * 0.35;',
    // crack flare: the core blows white-gold as the door lets go
    '  face += gold * orb * 2.2 * exp(-u_openT * 2.6);',
    '',
    // the bolt: an energy bar pinning the door to the frame, melts back on unlock
    '  float bLen = (1.0 - u_bolt) * 158.0;',
    '  if (bLen > 1.0) {',
    '    float db = sdSeg(p, vec2(296.0 - bLen, -52.0), vec2(296.0, -52.0)) - 7.0;',
    '    face += mix(gold, accent, 0.25) * fill(db, aa) * 0.9;',
    '    face += gold * glow(db, 3.0) * 0.4;',
    '  }',
    '',
    // alarm lamps: one per miss; the klaxon strobes them
    '  float strobe = 0.6 + 0.4 * sin(u_alarmT * 22.0);',
    '  for (int m = 0; m < 3; m++) {',
    '    float fm = float(m);',
    '    vec2 lp = p - vec2(196.0 + fm * 34.0, 158.0);',
    '    float dl = length(lp) - 7.0;',
    '    float on = step(fm + 0.5, u_misses);',
    '    face += mix(vec3(0.05, 0.09, 0.14), red * (0.9 + strobe * exp(-u_alarmT)), on) * fill(dl, aa);',
    '    face += red * glow(dl, 4.0) * on * 0.6;',
    '    face += accent * line(dl, 1.2, aa) * 0.3;',
    '  }',
    '',
    // sparks: a hash burst from the last seated cell, and from the core on the crack
    '  vec2 seatPos = vec2((u_seatI - (u_need - 1.0) * 0.5) * 82.0, 118.0);',
    '  for (int s = 0; s < 12; s++) {',
    '    float fs = float(s);',
    '    float a1 = hash11(fs * 3.7 + 1.0) * TAU;',
    '    float v1 = 90.0 + hash11(fs * 9.1) * 130.0;',
    '    vec2 dir1 = vec2(cos(a1), sin(a1));',
    '    if (u_seatT < 0.8) {',
    '      vec2 sp = seatPos + dir1 * v1 * u_seatT - vec2(0.0, 130.0 * u_seatT * u_seatT);',
    '      face += gold * glow(length(p - sp) - 1.6, 2.4) * exp(-u_seatT * 4.5);',
    '    }',
    '    if (u_openT < 1.2) {',
    '      vec2 op = core + dir1 * v1 * 1.6 * u_openT - vec2(0.0, 90.0 * u_openT * u_openT);',
    '      face += mix(gold, accent, hash11(fs)) * glow(length(p - op) - 2.0, 3.0) * exp(-u_openT * 3.0);',
    '    }',
    '  }',
    '',
    // ---- the iris door ----
    // the front face rides the door: it is visible outside the aperture. Inside,
    // golden light and rays: the same reveal the SVG door-swing gave.
    // lock failure: the whole face browns out and flickers for a beat; a
    // timeout adds an amber wash while the rings wind back
    '  face *= 1.0 - 0.45 * exp(-u_failT * 5.0) * (0.5 + 0.5 * sin(u_failT * 60.0));',
    '  face += vec3(1.0, 0.65, 0.2) * 0.15 * exp(-u_failT * 2.5) * u_failK;',
    '',
    '  float blades = 1.0 - u_iris;',
    '  float serr = abs(fract(ang / TAU * 8.0) - 0.5) * 2.0;',
    '  float aperture = u_iris * 420.0 + serr * 16.0 * blades * u_iris;',
    '  float inside = fill(rc - aperture, aa * 2.0) * inPanel;',
    '  vec3 interior = vec3(0.10, 0.055, 0.015);',
    '  interior += gold * pow(max(cos(ang * 5.0 + it * 0.25), 0.0), 3.0) * 0.35;',
    '  interior += gold * exp(-rc * 0.012) * 0.85;',
    '  interior += vec3(1.0, 0.95, 0.75) * exp(-rc * 0.05) * 0.9;',
    '  col += face * inPanel * (1.0 - inside);',
    '  col += interior * inside;',
    '  col += gold * line(rc - aperture, 3.0, aa) * u_iris * step(0.01, blades) * inPanel;',
    '',
    // panel rim: edge-lit, breathing faintly; red-washed while the alarm rings
    '  vec3 rimc = mix(accent, red, clamp(exp(-u_alarmT * 1.2) * step(0.001, 60.0 - u_alarmT), 0.0, 1.0) * step(2.5, u_misses));',
    '  col += rimc * line(dPanel, 2.2, aa) * (0.8 + 0.2 * sin(it * 1.7));',
    '  col += rimc * glow(abs(dPanel), 3.2) * 0.35;',
    '',
    // alarm wash over the whole face',
    '  col += red * inPanel * 0.22 * exp(-u_alarmT * 1.6) * (0.5 + 0.5 * sin(u_alarmT * 10.0));',
    '',
    // outside the panel: transparent, but let the glow bleed onto the page
    '  float a = max(inPanel, clamp((col.r + col.g + col.b) * 0.8, 0.0, 0.92));',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  // ---- CPU-side animation state ----
  var G = null;        // {gl, canvas, uni, ...} once mounted
  var probed = null;   // cached supported() result
  var st = {
    need: 5, seated: 0, misses: 0, door: false,
    pins: [0, 0, 0, 0, 0],                     // eased values
    tw: [null, null, null, null, null],        // per-pin tweens
    charge: 0,
    dial: 0, dialTarget: 0, dialVel: 0,
    ev: { boot: -1e3, seat: -1e3, spring: -1e3, alarm: -1e3, open: -1e3, fail: -1e3 },
    seatI: 0, failK: 0,
    clock: -1,                                 // lock-timer fraction; -1 = no clock
    accent: [0.28, 0.90, 1.00],
    pinc: [0.45, 1.00, 0.95]
  };

  function now() { return performance.now() / 1000; }
  function reduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function easeOutBack(x) {
    var c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  function stepPins(t) {
    for (var i = 0; i < 5; i++) {
      var tw = st.tw[i];
      if (!tw) continue;
      var x = (t - tw.t0) / tw.dur;
      if (x >= 1) { st.pins[i] = tw.to; st.tw[i] = null; continue; }
      if (x < 0) { continue; } // stagger delay
      st.pins[i] = tw.from + (tw.to - tw.from) * (tw.back ? easeOutBack(x) : x * x);
    }
  }

  function frame() {
    var t = now(), dt = Math.min(0.05, t - (G.last || t));
    G.last = t;
    stepPins(t);
    // dial: an underdamped spring so each quarter turn lands with a wobble
    var acc = (st.dialTarget - st.dial) * 90.0;
    st.dialVel = (st.dialVel + acc * dt) * Math.exp(-7.0 * dt);
    st.dial += st.dialVel * dt;
    // charge follows the seated fraction
    var target = st.need ? st.seated / st.need : 0;
    st.charge += (target - st.charge) * Math.min(1, dt * 5);
    draw(t);
    if (!G.reduced) G.raf = requestAnimationFrame(frame);
  }

  // reduced motion: no loop; jump every transient to where it ends and draw once
  function snapAndDraw() {
    for (var i = 0; i < 5; i++) {
      if (st.tw[i]) { st.pins[i] = st.tw[i].to; st.tw[i] = null; }
    }
    st.dial = st.dialTarget; st.dialVel = 0;
    st.charge = st.need ? st.seated / st.need : 0;
    draw(now() + 100); // every "seconds since" uniform reads as long-finished
  }

  function draw(t) {
    var gl = G.gl, u = G.uni;
    var w = G.canvas.clientWidth, h = G.canvas.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var W = Math.max(2, Math.round(w * dpr)), H = Math.max(2, Math.round(h * dpr));
    if (G.canvas.width !== W || G.canvas.height !== H) {
      G.canvas.width = W; G.canvas.height = H;
      gl.viewport(0, 0, W, H);
    }
    var doorT = t - st.ev.open;
    var bolt = st.door ? smooth(0.00, 0.32, doorT) : 0;
    var iris = st.door ? smooth(0.45, 1.15, doorT) : 0;
    gl.uniform2f(u.u_res, W, H);
    gl.uniform1f(u.u_time, t % 3600);
    gl.uniform1f(u.u_anim, G.reduced ? 0 : 1);
    gl.uniform1f(u.u_need, st.need);
    gl.uniform1fv(u.u_pins, st.pins);
    gl.uniform1f(u.u_misses, st.misses);
    gl.uniform1f(u.u_charge, st.charge);
    gl.uniform1f(u.u_dial, st.dial);
    gl.uniform1f(u.u_bolt, bolt);
    gl.uniform1f(u.u_iris, iris);
    gl.uniform1f(u.u_boot, clampT(t - st.ev.boot));
    gl.uniform1f(u.u_seatT, clampT(t - st.ev.seat));
    gl.uniform1f(u.u_seatI, st.seatI);
    gl.uniform1f(u.u_springT, clampT(t - st.ev.spring));
    gl.uniform1f(u.u_alarmT, clampT(t - st.ev.alarm));
    gl.uniform1f(u.u_openT, clampT(t - st.ev.open));
    gl.uniform1f(u.u_clock, st.clock);
    gl.uniform1f(u.u_failT, clampT(t - st.ev.fail));
    gl.uniform1f(u.u_failK, st.failK);
    gl.uniform3fv(u.u_accent, st.accent);
    gl.uniform3fv(u.u_pinc, st.pinc);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function smooth(a, b, x) { var v = Math.min(1, Math.max(0, (x - a) / (b - a))); return v * v * (3 - 2 * v); }
  function clampT(v) { return Math.min(1e3, Math.max(0, v)); }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      // a compile failure downgrades to the SVG vault; the log names the line
      console.error('game-fx shader: ' + gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  function getContext(canvas) {
    var opts = { alpha: true, antialias: false, premultipliedAlpha: true,
                 powerPreference: 'low-power', failIfMajorPerformanceCaveat: false };
    return canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  }

  var FX = {
    supported: function () {
      // only a SUCCESSFUL probe is cached: a context that fails during GPU
      // process startup may succeed seconds later, and caching that failure
      // would grey the setting out until a reload
      if (probed === true) return true;
      var c = document.createElement('canvas');
      var gl = null;
      // context creation THROWS on some locked-down/blocklisted GPUs instead
      // of returning null (crbug 315430); either way means "use the SVG vault"
      try { gl = getContext(c); } catch (e) { gl = null; }
      if (gl) probed = true;
      return !!gl;
    },

    mounted: function () { return !!G; },

    mount: function (canvas) {
      if (G || !FX.supported()) return !!G;
      var gl;
      try { gl = getContext(canvas); } catch (e) { gl = null; }
      if (!gl) return false;
      var vs = compile(gl, gl.VERTEX_SHADER, VERT);
      var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;
      var prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('game-fx link: ' + gl.getProgramInfoLog(prog));
        return false;
      }
      gl.useProgram(prog);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'a');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var uni = {};
      ['u_res', 'u_time', 'u_anim', 'u_need', 'u_pins', 'u_misses', 'u_charge',
       'u_dial', 'u_bolt', 'u_iris', 'u_boot', 'u_seatT', 'u_seatI', 'u_springT',
       'u_alarmT', 'u_openT', 'u_clock', 'u_failT', 'u_failK',
       'u_accent', 'u_pinc'].forEach(function (n) {
        uni[n] = gl.getUniformLocation(prog, n);
      });
      G = { gl: gl, canvas: canvas, uni: uni, raf: 0, reduced: reduced(), last: 0 };
      // GPU reset / driver eviction: drop back to the SVG vault cleanly
      canvas.addEventListener('webglcontextlost', function (e) {
        e.preventDefault();
        FX.unmount();
      });
      if (window.matchMedia) {
        window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) {
          if (!G) return;
          G.reduced = e.matches;
          cancelAnimationFrame(G.raf);
          if (G.reduced) snapAndDraw(); else G.raf = requestAnimationFrame(frame);
        });
      }
      document.documentElement.classList.add('fx');
      if (G.reduced) snapAndDraw(); else G.raf = requestAnimationFrame(frame);
      return true;
    },

    unmount: function () {
      if (!G) return;
      cancelAnimationFrame(G.raf);
      G = null;
      document.documentElement.classList.remove('fx');
    },

    // declarative snapshot from the UI; only deltas animate
    set: function (o) {
      if (o.cosmetic !== undefined) {
        st.accent = o.cosmetic.skin === 'bronze' ? [1.00, 0.72, 0.30] : [0.28, 0.90, 1.00];
        st.pinc = o.cosmetic.pins === 'copper' ? [1.00, 0.62, 0.38] : [0.45, 1.00, 0.95];
      }
      if (typeof o.need === 'number') st.need = o.need;
      if (typeof o.misses === 'number') st.misses = o.misses;
      if (typeof o.clock === 'number') st.clock = o.clock;
      if (typeof o.seated === 'number' && o.seated !== st.seated) {
        var t = now();
        if (o.seated > st.seated) {          // a pin seats: overshoot up
          st.seatI = o.seated - 1;
          st.ev.seat = t;
          st.tw[o.seated - 1] = { from: st.pins[o.seated - 1], to: 1, t0: t, dur: 0.38, back: true };
        } else if (o.seated === 0) {         // relock: drain with a stagger
          for (var i = 0; i < 5; i++) {
            if (st.pins[i] > 0 || st.tw[i]) {
              st.tw[i] = { from: st.pins[i], to: 0, t0: t + i * 0.045, dur: 0.24, back: false };
            }
          }
        }
        st.seated = o.seated;
      }
      if (typeof o.door === 'boolean' && o.door !== st.door) {
        st.door = o.door;
        if (!o.door) st.ev.open = -1e3;      // instant reset when the next job racks in
      }
      if (G && G.reduced) snapAndDraw();
    },

    // transient beats; each maps to a decaying term in the shader
    pulse: function (kind, arg) {
      var t = now();
      if (kind === 'boot') st.ev.boot = t;
      else if (kind === 'spring') st.ev.spring = t;
      else if (kind === 'alarm') st.ev.alarm = t;
      else if (kind === 'fail') { st.ev.fail = t; st.failK = arg ? 1 : 0; }
      else if (kind === 'dial') st.dialTarget += (arg || 1);
      else if (kind === 'open') { st.ev.open = t; st.door = true; }
      if (G && G.reduced) snapAndDraw();
    }
  };

  window.FX = FX;
})();
