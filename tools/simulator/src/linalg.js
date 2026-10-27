// Small dense linear algebra for the fit.

// Solve M x = b for a symmetric positive definite M (row-major, n x n) by
// Cholesky. Returns null if M is not positive definite.
export function solveSPD(M, b, n) {
  const Lm = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= Lm[i * n + k] * Lm[j * n + k];
      if (i === j) {
        if (s <= 0 || !isFinite(s)) return null;
        Lm[i * n + i] = Math.sqrt(s);
      } else Lm[i * n + j] = s / Lm[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= Lm[i * n + k] * y[k]; y[i] = s / Lm[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= Lm[k * n + i] * x[k]; x[i] = s / Lm[i * n + i]; }
  return x;
}
