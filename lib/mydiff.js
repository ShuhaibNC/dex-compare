"use strict";

// Myers O(ND) diff with a cutoff. Returns an array of aligned rows:
//   { l: string|null, r: string|null, t: 'eq'|'del'|'add' }
// or null if the edit distance exceeds the bounded work limit.

function diffLines(a, b, maxD) {
  maxD = maxD || 4000;
  const N = a.length, M = b.length;
  const MAX = N + M;
  // Trace snapshots grow with the edit distance; cap them to bound memory use.
  const MAX_TRACE_DISTANCE = 1200;
  const limit = Math.min(maxD, MAX, MAX_TRACE_DISTANCE);
  const v = new Int32Array(2 * limit + 3);
  const offset = limit + 1;
  const trace = [];
  let found = -1;

  for (let d = 0; d <= limit; d++) {
    const vv = v.slice();
    trace.push(vv);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null; // too big

  // backtrack
  const rows = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { rows.push({ t: "eq", l: a[x - 1], r: b[y - 1] }); x--; y--; }
    if (x === prevX) { rows.push({ t: "add", l: null, r: b[y - 1] }); y--; }
    else { rows.push({ t: "del", l: a[x - 1], r: null }); x--; }
  }
  while (x > 0 && y > 0) { rows.push({ t: "eq", l: a[x - 1], r: b[y - 1] }); x--; y--; }
  while (x > 0) { rows.push({ t: "del", l: a[x - 1], r: null }); x--; }
  while (y > 0) { rows.push({ t: "add", l: null, r: b[y - 1] }); y--; }
  rows.reverse();
  return rows;
}

module.exports = { diffLines };
