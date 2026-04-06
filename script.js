// ─── Scene Setup ──────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(6, 4, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);
document.body.insertBefore(renderer.domElement, document.body.firstChild);
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.top = '0';
renderer.domElement.style.left = '0';
renderer.domElement.style.zIndex = '0';

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1;
controls.maxDistance = 50;

// ─── Lighting ─────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);
const dirLight2 = new THREE.DirectionalLight(0x8888ff, 0.4);
dirLight2.position.set(-5, -4, -6);
scene.add(dirLight2);

// ─── Grid / Axes ──────────────────────────────────────────────────────────────
function buildGrid() {
  const size = 20, divisions = 20;
  const gridMat = new THREE.LineBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.5 });
  const points = [];
  const half = size / 2;
  for (let i = 0; i <= divisions; i++) {
    const t = -half + (i / divisions) * size;
    points.push(new THREE.Vector3(t, 0, -half), new THREE.Vector3(t, 0, half));
    points.push(new THREE.Vector3(-half, 0, t), new THREE.Vector3(half, 0, t));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const grid = new THREE.LineSegments(geo, gridMat);
  grid.position.y = -0.01;
  scene.add(grid);
}
buildGrid();

function buildAxes() {
  const axisPoints = (a, b) => new THREE.BufferGeometry().setFromPoints([a, b]);
  const mk = (geo, color) => new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  scene.add(mk(axisPoints(new THREE.Vector3(-10,0,0), new THREE.Vector3(10,0,0)), 0xff4444));
  scene.add(mk(axisPoints(new THREE.Vector3(0,-10,0), new THREE.Vector3(0,10,0)), 0x44ff88));
  scene.add(mk(axisPoints(new THREE.Vector3(0,0,-10), new THREE.Vector3(0,0,10)), 0x4488ff));

  // Axis labels via sprites
  [['X', 8.3,0,-0.5,0xff4444],['Y',-0.5,6.3,0,0x44ff88],['Z',-0.5,0,8.3,0x4488ff]].forEach(([lbl,x,y,z,col])=>{
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#' + col.toString(16).padStart(6,'0');
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sp.position.set(x,y,z);
    sp.scale.set(0.5,0.5,1);
    scene.add(sp);
  });
}
buildAxes();

// ─── State ────────────────────────────────────────────────────────────────────
let solidMesh = null, wireMesh = null, curveLine = null, curveLine2 = null, axisLine = null;

function clearScene() {
  [solidMesh, wireMesh, curveLine, curveLine2, axisLine].forEach(o => { if (o) scene.remove(o); });
  solidMesh = wireMesh = curveLine = curveLine2 = axisLine = null;
}

// ─── Safe numeric evaluator (supports pi, e, sqrt, etc.) ─────────────────────
function evalNum(str) {
  try {
    const v = math.evaluate(String(str).trim());
    return typeof v === 'number' ? v : NaN;
  } catch(e) { return NaN; }
}

// ─── Parse axis input ─────────────────────────────────────────────────────────
// Returns { variable: 'x'|'y', value: number, rawStr: string }
function parseAxis(str) {
  const orig = str.replace(/\s/g, '');
  const low = orig.toLowerCase();
  const mx = low.match(/^x=(.+)$/);
  if (mx) return { variable: 'x', value: evalNum(mx[1]), rawStr: mx[1] };
  const my = low.match(/^y=(.+)$/);
  if (my) return { variable: 'y', value: evalNum(my[1]), rawStr: my[1] };
  if (low === 'x') return { variable: 'x', value: 0, rawStr: '0' };
  if (low === 'y') return { variable: 'y', value: 0, rawStr: '0' };
  return null;
}

// ─── Determine method ─────────────────────────────────────────────────────────
// disk/washer: rotate around horizontal axis (y=k)
// shell:       rotate around vertical axis   (x=k)
function determineMethod(axis, hasTwo) {
  if (axis.variable === 'y') return hasTwo ? 'washer' : 'disk';
  return 'shell';
}

// ─── Numerical Integration (Simpson's 1/3) ────────────────────────────────────
function integrate(fn, a, b, n = 1000) {
  if (n % 2 !== 0) n++;
  const h = (b - a) / n;
  let sum = fn(a) + fn(b);
  for (let i = 1; i < n; i++) {
    sum += fn(a + i * h) * (i % 2 === 0 ? 2 : 4);
  }
  return (h / 3) * sum;
}

// ─── Helper: build a tube-ring BufferGeometry ─────────────────────────────────
// Sweeps an annulus (rInner..rOuter) along the x-axis from a to b.
// Each cross-section at position x is a ring in the YZ plane centred on the
// rotation axis (y = axisY).  Both the outer barrel, inner barrel, and the two
// annular end-caps are generated so the solid is fully closed.
function buildRevolutionGeometry(getRoRi, a, b, axisY, axialSegs = 240, radialSegs = 80) {
  // getRoRi(x) → { rOuter, rInner }  (both ≥ 0, rOuter ≥ rInner)
  const positions = [];
  const normals   = [];
  const indices   = [];

  // ── ring vertex helper ─────────────────────────────────────────────────────
  // Pushes (radialSegs+1) vertices for one ring at position x with radius r.
  // The ring lives in the plane perpendicular to X at height axisY on Y.
  // normal points outward (+1) or inward (-1).
  function pushRing(x, r, normalSign) {
    for (let i = 0; i <= radialSegs; i++) {
      const theta = (i / radialSegs) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      positions.push(x, axisY + r * cosT, r * sinT);
      normals.push(0, normalSign * cosT, normalSign * sinT);
    }
  }

  // ── annular cap helper ─────────────────────────────────────────────────────
  // Pushes one flat annular cap at position x.
  // normalX: +1 for right cap, -1 for left cap.
  // Returns base vertex index of the first vertex pushed.
  function pushCap(x, rOuter, rInner, normalX) {
    const base = positions.length / 3;
    // two rings: outer then inner
    for (let i = 0; i <= radialSegs; i++) {
      const theta = (i / radialSegs) * Math.PI * 2;
      positions.push(x, axisY + rOuter * Math.cos(theta), rOuter * Math.sin(theta));
      normals.push(normalX, 0, 0);
    }
    for (let i = 0; i <= radialSegs; i++) {
      const theta = (i / radialSegs) * Math.PI * 2;
      positions.push(x, axisY + rInner * Math.cos(theta), rInner * Math.sin(theta));
      normals.push(normalX, 0, 0);
    }
    // triangulate cap: quad strip between outer ring and inner ring
    const outerBase = base;
    const innerBase = base + (radialSegs + 1);
    for (let i = 0; i < radialSegs; i++) {
      const o0 = outerBase + i,     o1 = outerBase + i + 1;
      const i0 = innerBase + i,     i1 = innerBase + i + 1;
      if (normalX > 0) {
        indices.push(o0, i0, o1);
        indices.push(o1, i0, i1);
      } else {
        indices.push(o0, o1, i0);
        indices.push(o1, i1, i0);
      }
    }
    return base;
  }

  // ── barrel surfaces ────────────────────────────────────────────────────────
  // Store one ring of outer vertices and one of inner vertices per axial slice.
  const outerRingStart = []; // vertex index where each outer ring begins
  const innerRingStart = [];

  for (let j = 0; j <= axialSegs; j++) {
    const x = a + (j / axialSegs) * (b - a);
    const { rOuter, rInner } = getRoRi(x);
    outerRingStart.push(positions.length / 3);
    pushRing(x, rOuter, +1);
    innerRingStart.push(positions.length / 3);
    pushRing(x, rInner, -1);
  }

  // Connect barrel quads
  const stride = radialSegs + 1;
  for (let j = 0; j < axialSegs; j++) {
    for (let i = 0; i < radialSegs; i++) {
      // Outer barrel
      const oa = outerRingStart[j]   + i;
      const ob = outerRingStart[j]   + i + 1;
      const oc = outerRingStart[j+1] + i;
      const od = outerRingStart[j+1] + i + 1;
      indices.push(oa, oc, ob);
      indices.push(ob, oc, od);

      // Inner barrel (winding flipped so normals face inward)
      const ia = innerRingStart[j]   + i;
      const ib = innerRingStart[j]   + i + 1;
      const ic = innerRingStart[j+1] + i;
      const id = innerRingStart[j+1] + i + 1;
      indices.push(ia, ib, ic);
      indices.push(ib, id, ic);
    }
  }

  // End caps (annular discs at x=a and x=b)
  const { rOuter: roA, rInner: riA } = getRoRi(a);
  const { rOuter: roB, rInner: riB } = getRoRi(b);
  pushCap(a, roA, riA, -1); // left cap, normal points left
  pushCap(b, roB, riB, +1); // right cap, normal points right

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setIndex(indices);
  return geo;
}

// ─── Main geometry builder ────────────────────────────────────────────────────
function buildSolid(f1, f2, a, b, axis) {
  const method  = determineMethod(axis, !!f2);
  const axisVal = axis.value;

  if (axis.variable === 'y') {
    // ── Disk / Washer ─────────────────────────────────────────────────────────
    // Rotate around y = axisVal.
    // rOuter = distance of the farther function from the axis.
    // rInner = distance of the closer function (0 for disk).
    const getRoRi = x => {
      const d1 = f1(x) - axisVal;
      if (!f2) {
        return { rOuter: Math.abs(d1), rInner: 0 };
      }
      const d2 = f2(x) - axisVal;
      const r1 = Math.abs(d1), r2 = Math.abs(d2);
      return { rOuter: Math.max(r1, r2), rInner: Math.min(r1, r2) };
    };
    return buildRevolutionGeometry(getRoRi, a, b, axisVal);

  } else {
    // ── Shell method ──────────────────────────────────────────────────────────
    // Rotate around x = axisVal.
    // Each vertical strip at position x sweeps a cylindrical shell.
    // We visualise this as the union of all those shells = the full solid.
    // The solid's cross-section at angle θ is bounded by the two functions,
    // and its "radius" in the XZ-plane is |x - axisVal|.
    // We build it as a parametric surface: for each x, revolve the segment
    // [yBot, yTop] at distance r = |x - axisVal| around x = axisVal.
    const axialSegs  = 240;
    const radialSegs = 80;
    const positions = [];
    const indices   = [];

    // Each axial slice contributes two rings: one at yBot, one at yTop.
    const botRingStart = [];
    const topRingStart = [];

    for (let j = 0; j <= axialSegs; j++) {
      const x  = a + (j / axialSegs) * (b - a);
      const r  = Math.abs(x - axisVal);
      let yBot, yTop;
      if (f2) {
        yTop = Math.max(f1(x), f2(x));
        yBot = Math.min(f1(x), f2(x));
      } else {
        yTop = Math.max(f1(x), 0);
        yBot = Math.min(f1(x), 0);
      }

      botRingStart.push(positions.length / 3);
      for (let i = 0; i <= radialSegs; i++) {
        const theta = (i / radialSegs) * Math.PI * 2;
        positions.push(axisVal + r * Math.cos(theta), yBot, r * Math.sin(theta));
      }
      topRingStart.push(positions.length / 3);
      for (let i = 0; i <= radialSegs; i++) {
        const theta = (i / radialSegs) * Math.PI * 2;
        positions.push(axisVal + r * Math.cos(theta), yTop, r * Math.sin(theta));
      }
    }

    // Side barrel (outer surface of the swept solid)
    for (let j = 0; j < axialSegs; j++) {
      for (let i = 0; i < radialSegs; i++) {
        // Bottom ring quad (connects adjacent x-slices along the bottom curve)
        const ba  = botRingStart[j]   + i;
        const bb  = botRingStart[j]   + i + 1;
        const bc  = botRingStart[j+1] + i;
        const bd  = botRingStart[j+1] + i + 1;
        indices.push(ba, bc, bb, bb, bc, bd);

        // Top ring quad
        const ta  = topRingStart[j]   + i;
        const tb  = topRingStart[j]   + i + 1;
        const tc  = topRingStart[j+1] + i;
        const td  = topRingStart[j+1] + i + 1;
        indices.push(ta, tb, tc, tb, td, tc);

        // Vertical wall between top and bottom at each x-slice (outer)
        // handled by connecting top[j] to bot[j] at the same theta
      }
    }

    // Vertical walls at each x (connecting top ring to bottom ring)
    for (let j = 0; j <= axialSegs; j++) {
      for (let i = 0; i < radialSegs; i++) {
        const b0 = botRingStart[j] + i;
        const b1 = botRingStart[j] + i + 1;
        const t0 = topRingStart[j] + i;
        const t1 = topRingStart[j] + i + 1;
        indices.push(b0, t0, b1, b1, t0, t1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }
}

// ─── Build 2D curve line ──────────────────────────────────────────────────────
function buildCurve(f, a, b, color = 0x00ffff, zOffset = 0) {
  const pts = [];
  const steps = 300;
  for (let i = 0; i <= steps; i++) {
    const x = a + (i / steps) * (b - a);
    pts.push(new THREE.Vector3(x, f(x), zOffset));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
}

// ─── Build rotation axis indicator ───────────────────────────────────────────
function buildAxisLine(axis, a, b) {
  let pts;
  if (axis.variable === 'y') {
    pts = [new THREE.Vector3(a - 0.5, axis.value, 0), new THREE.Vector3(b + 0.5, axis.value, 0)];
  } else {
    const yMin = -6, yMax = 6;
    pts = [new THREE.Vector3(axis.value, yMin, 0), new THREE.Vector3(axis.value, yMax, 0)];
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({ color: 0xffff00, dashSize: 0.2, gapSize: 0.1 });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  return line;
}

// ─── Volume formulas ──────────────────────────────────────────────────────────
function computeVolume(f1, f2, a, b, axis) {
  const method = determineMethod(axis, !!f2);
  const k = axis.value;
  let volume;

  if (method === 'disk') {
    volume = Math.PI * integrate(x => Math.pow(f1(x) - k, 2), a, b);
  } else if (method === 'washer') {
    volume = Math.PI * integrate(x => {
      const r1 = Math.abs(f1(x) - k);
      const r2 = Math.abs(f2(x) - k);
      const R  = Math.max(r1, r2);
      const r  = Math.min(r1, r2);
      return R * R - r * r;
    }, a, b);
  } else {
    // Shell: V = 2π ∫ |x - k| · f(x) dx  (or |f1-f2|)
    if (f2) {
      volume = 2 * Math.PI * integrate(x => Math.abs(x - k) * Math.abs(f1(x) - f2(x)), a, b);
    } else {
      volume = 2 * Math.PI * integrate(x => Math.abs(x - k) * Math.abs(f1(x)), a, b);
    }
  }
  return volume;
}

// ─── Exact number recognition ────────────────────────────────────────────────
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function getAtoms() {
  const PI = Math.PI, E = Math.E;
  const atoms = [
    { val: PI,            tex: '\\pi' },
    { val: PI * PI,       tex: '\\pi^2' },
    { val: Math.sqrt(PI), tex: '\\sqrt{\\pi}' },
    { val: E,             tex: 'e' },
    { val: E * E,         tex: 'e^2' },
    { val: Math.log(2),   tex: '\\ln 2' },
    { val: Math.log(3),   tex: '\\ln 3' },
    { val: Math.log(5),   tex: '\\ln 5' },
  ];
  // sqrt(n) for n = 2..20, skipping perfect squares
  for (let n = 2; n <= 20; n++) {
    const s = Math.sqrt(n);
    if (Math.abs(s - Math.round(s)) > 1e-9)
      atoms.push({ val: s, tex: `\\sqrt{${n}}` });
  }
  // cbrt(n) for n = 2..10, skipping perfect cubes
  for (let n = 2; n <= 10; n++) {
    const c = Math.cbrt(n);
    if (Math.abs(c - Math.round(c)) > 1e-9)
      atoms.push({ val: c, tex: `\\sqrt[3]{${n}}` });
  }
  // pi * sqrt(n) — common in volume results
  for (let n = 2; n <= 10; n++) {
    const s = Math.sqrt(n);
    if (Math.abs(s - Math.round(s)) > 1e-9)
      atoms.push({ val: PI * s, tex: `\\pi\\sqrt{${n}}` });
  }
  return atoms;
}

// Returns a LaTeX string if v is recognizable, otherwise null.
// Handles: integers, rationals, rational multiples of atoms (pi, e, sqrt, ln, cbrt, pi*sqrt).
function recognizeExact(v, maxDen = 120, tol = 1e-7) {
  if (!isFinite(v)) return null;

  const sign  = v < 0 ? '-' : '';
  const abs   = Math.abs(v);

  if (abs < tol) return '0';

  // Pure integer
  if (Math.abs(abs - Math.round(abs)) < tol) return String(Math.round(v));

  // Pure rational p/q
  for (let q = 2; q <= maxDen; q++) {
    const p = Math.round(abs * q);
    if (p === 0) continue;
    if (Math.abs(p / q - abs) < tol) {
      const g = gcd(p, q);
      return `${sign}\\dfrac{${p/g}}{${q/g}}`;
    }
  }

  // Rational multiple of each atom: v = (p/q) * atom
  for (const { val, tex } of getAtoms()) {
    if (val === 0) continue;
    const ratio    = abs / val;
    const ratioAbs = Math.abs(ratio);

    // Integer multiple
    const intR = Math.round(ratio);
    if (intR !== 0 && Math.abs(ratio - intR) < tol) {
      if (intR ===  1) return `${sign}${tex}`;
      if (intR === -1) return `${sign}-${tex}`;
      return `${sign}${intR}${tex}`;
    }

    // Fractional multiple p/q
    for (let q = 2; q <= maxDen; q++) {
      const p = Math.round(ratioAbs * q);
      if (p === 0) continue;
      if (Math.abs(p / q - ratioAbs) < tol) {
        const g = gcd(p, q);
        const pr = p / g, qr = q / g;
        const numerTex = pr === 1 ? tex : `${pr}${tex}`;
        return `${sign}\\dfrac{${numerTex}}{${qr}}`;
      }
    }
  }

  return null; // not recognized
}

// Public display helper: recognized exact form, or fixed decimal fallback.
function numToLatex(v) {
  return recognizeExact(v) ?? (v % 1 === 0 ? String(v) : v.toFixed(4));
}


function getFormulaLatex(f1Str, f2Str, a, b, axis, volume) {
  const method = determineMethod(axis, !!f2Str);
  const k = axis.value;

  // Build the axis label string
  const axisLabel = axis.variable === 'y'
    ? (k === 0 ? 'x\\text{-axis}' : `y = ${numToLatex(k)}`)
    : (k === 0 ? 'y\\text{-axis}' : `x = ${numToLatex(k)}`);

  // Bound strings
  const aStr = numToLatex(a);
  const bStr = numToLatex(b);

  // Exact or decimal volume
  const exact = recognizeExact(volume);
  const approx = volume.toFixed(4);
  const volStr = exact ? `${exact} \\approx ${approx}` : approx;

  const mid = (a + b) / 2;

  // Build radius expression with correct sign: "f - k" or "k - f"
  function makeRadiusExpr(fStr, fVal) {
    if (k === 0) return fStr;
    const kExact    = recognizeExact(k)           ?? k.toFixed(4);
    const kAbsExact = recognizeExact(Math.abs(k)) ?? Math.abs(k).toFixed(4);
    if (fVal >= k) {
      const sub = k > 0 ? ` - ${kAbsExact}` : ` + ${kAbsExact}`;
      return `${fStr}${sub}`;
    } else {
      return `(${kExact}) - (${fStr})`;
    }
  }
  function makeShellExpr(fStr, fVal) {
    if (k === 0) return fStr;
    const kExact    = recognizeExact(k)           ?? k.toFixed(4);
    const kAbsExact = recognizeExact(Math.abs(k)) ?? Math.abs(k).toFixed(4);
    if (fVal >= k) {
      const sub = k > 0 ? ` - ${kAbsExact}` : ` + ${kAbsExact}`;
      return `${fStr}${sub}`;
    } else {
      return `(${kExact}) - (${fStr})`;
    }
  }
    function makeHeightExpr(f1Str, f2Str, f1Val, f2Val) {
  if (f1Val >= f2Val) {
    return `(${f1Str}) - (${f2Str})`;
  } else {
    return `(${f2Str}) - (${f1Str})`;
  }
}
 
  let title, formula;

  if (method === 'disk') {
    title = 'Disk Method';
    let fMid;
    try { fMid = math.evaluate(f1Str, { x: mid }); } catch(e) { fMid = 0; }
    formula = `V = \\pi \\int_{${aStr}}^{${bStr}} \\left[${makeRadiusExpr(f1Str, fMid)}\\right]^2 \\, dx = ${volStr}`;

  } else if (method === 'washer') {
    title = 'Washer Method';
    let fv1, fv2;
    try { fv1 = math.evaluate(f1Str, { x: mid }); } catch(e) { fv1 = 0; }
    try { fv2 = math.evaluate(f2Str, { x: mid }); } catch(e) { fv2 = 0; }
    const d1 = Math.abs(fv1 - k), d2 = Math.abs(fv2 - k);
    const [outerStr, outerVal, innerStr, innerVal] = d1 >= d2
      ? [f1Str, fv1, f2Str, fv2]
      : [f2Str, fv2, f1Str, fv1];
    formula = `V = \\pi \\int_{${aStr}}^{${bStr}} \\left(\\left[${makeRadiusExpr(outerStr, outerVal)}\\right]^2 - \\left[${makeRadiusExpr(innerStr, innerVal)}\\right]^2\\right) dx = ${volStr}`;

  } else {
    title = 'Shell Method';
     let fv1, fv2;
    try { fv1 = math.evaluate(f1Str, { x: mid }); } catch(e) { fv1 = 0; }
    try { fv2 = math.evaluate(f2Str, { x: mid }); } catch(e) { fv2 = 0; }
    const d1 = Math.abs(fv1 - k), d2 = Math.abs(fv2 - k);
    const [outerStr, outerVal, innerStr, innerVal] = d1 >= d2
      ? [f1Str, fv1, f2Str, fv2]
      : [f2Str, fv2, f1Str, fv1];
   
      try { fMid = math.evaluate(f1Str, { x: mid }); } catch(e) { fMid = 0; }
    formula = `V = 2\\pi \\int_{${aStr}}^{${bStr}} [${makeShellExpr(f1Str, fMid)}] \\cdot [${makeHeightExpr(f1Str, f2Str, fv1, fv2)}] \\, dx = ${volStr}`;
  }

  return { title, formula, axisLabel };
}

// ─── Evaluate function string safely ─────────────────────────────────────────
// math.js natively handles pi, e, sqrt, sin, cos, etc.
function makeEvalFn(str) {
  const compiled = math.compile(str);
  return x => {
    const v = compiled.evaluate({ x });
    return typeof v === 'number' ? v : Number(v);
  };
}

// ─── Main update ──────────────────────────────────────────────────────────────
document.getElementById('updateBtn').addEventListener('click', () => {
  const f1Str = document.getElementById('funcInput').value.trim();
  const f2Str = document.getElementById('funcInput2').value.trim();
  const axisStr = document.getElementById('axisInput').value.trim();
  const aVal = evalNum(document.getElementById('startInput').value);
  const bVal = evalNum(document.getElementById('endInput').value);

  // Validation
  if (!f1Str) return alert('Please enter f(x).');
  if (isNaN(aVal) || isNaN(bVal)) return alert('Please enter valid bounds a and b.');
  if (aVal >= bVal) return alert('Bound a must be less than b.');
  if (!axisStr) return alert('Please enter an axis of rotation (e.g. y=0, x=0, y=2).');

  const axis = parseAxis(axisStr);
  if (!axis) return alert('Invalid axis format. Use y=0, x=2, y=-1, etc.');

  let f1, f2;
  try { f1 = makeEvalFn(f1Str); f1(0); } catch(e) { return alert('Error in f(x): ' + e.message); }
  if (f2Str) {
    try { f2 = makeEvalFn(f2Str); f2(0); } catch(e) { return alert('Error in g(x): ' + e.message); }
  }

  clearScene();

  // Build solid
  try {
    const geo = buildSolid(f1, f2 || null, aVal, bVal, axis);
    const mat = new THREE.MeshPhongMaterial({
      color: 0x0088ff,
      emissive: 0x001133,
      specular: 0x88ccff,
      shininess: 60,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide
    });
    solidMesh = new THREE.Mesh(geo, mat);
    scene.add(solidMesh);

    // Wireframe
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x00eeff,
      wireframe: true,
      transparent: true,
      opacity: 0.08
    });
    wireMesh = new THREE.Mesh(geo.clone(), wireMat);
    scene.add(wireMesh);
  } catch(e) {
    console.error('Geometry error:', e);
  }

  // Build curves
  curveLine = buildCurve(f1, aVal, bVal, 0x00ffaa);
  scene.add(curveLine);
  if (f2) {
    curveLine2 = buildCurve(f2, aVal, bVal, 0xff6688);
    scene.add(curveLine2);
  }

  // Axis line
  axisLine = buildAxisLine(axis, aVal, bVal);
  scene.add(axisLine);

  // Volume & formula
  const volume = computeVolume(f1, f2 || null, aVal, bVal, axis);
  const { title, formula, axisLabel } = getFormulaLatex(f1Str, f2Str || null, aVal, bVal, axis, volume);

  const uiEl = document.getElementById('ui');
  const titleEl = document.getElementById('methodTitle');
  const formulaEl = document.getElementById('volumeFormula');

  uiEl.style.display = 'block';
  titleEl.textContent = title;

  katex.render(formula, formulaEl, { throwOnError: false, displayMode: true });

  // Auto-frame camera
  const center = new THREE.Vector3((aVal + bVal) / 2, 0, 0);
  const span = Math.max(bVal - aVal, 4);
  camera.position.set(center.x + span, span * 0.8, span * 1.4);
  controls.target.copy(center);
  controls.update();
});

// ─── Render loop ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});