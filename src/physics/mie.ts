// Mie theory for a homogeneous sphere (Bohren & Huffman's BHMIE), plus a
// quasi-static spheroid polarizability. Used only by the in-browser mock
// server, so Studio can be developed and demoed without the Python stack.

import { C } from "./complex";

export interface MieOut {
  qext: number;
  qsca: number;
  an: C[];
  bn: C[];
}

/** Mie coefficients for size parameter x and relative index m (Im m >= 0 is loss). */
export function mieCoefficients(m: C, x: number): MieOut {
  const nstop = Math.max(2, Math.round(x + 4 * Math.cbrt(x) + 2));
  const mx = m.mul(x);
  const nmx = Math.round(Math.max(nstop, mx.abs()) + 16);
  const D: C[] = new Array(nmx + 1).fill(new C(0));
  for (let n = nmx; n >= 1; n--) {
    const nOverMx = new C(n).div(mx);
    D[n - 1] = nOverMx.sub(new C(1).div(D[n].add(nOverMx)));
  }
  let psi0 = Math.cos(x);
  let psi1 = Math.sin(x);
  let chi0 = -Math.sin(x);
  let chi1 = Math.cos(x);
  let xi1 = new C(psi1, -chi1);
  let qsca = 0;
  let qext = 0;
  const an: C[] = [];
  const bn: C[] = [];
  for (let n = 1; n <= nstop; n++) {
    const psi = ((2 * n - 1) * psi1) / x - psi0;
    const chi = ((2 * n - 1) * chi1) / x - chi0;
    const xi = new C(psi, -chi);
    const da = D[n].div(m).add(n / x);
    const db = m.mul(D[n]).add(n / x);
    const a = da.mul(psi).sub(psi1).div(da.mul(xi).sub(xi1));
    const b = db.mul(psi).sub(psi1).div(db.mul(xi).sub(xi1));
    an.push(a);
    bn.push(b);
    qsca += (2 * n + 1) * (a.abs2() + b.abs2());
    qext += (2 * n + 1) * (a.re + b.re);
    psi0 = psi1;
    psi1 = psi;
    chi0 = chi1;
    chi1 = chi;
    xi1 = new C(psi1, -chi1);
  }
  return { qext: (2 / (x * x)) * qext, qsca: (2 / (x * x)) * qsca, an, bn };
}

/** Amplitude scattering functions S1, S2 at scattering angle theta (radians). */
export function amplitudes(an: C[], bn: C[], theta: number): { s1: C; s2: C } {
  const mu = Math.cos(theta);
  let piPrev = 0; // pi_{n-1}
  let pin = 1; // pi_n, starting at pi_1
  let s1 = new C(0);
  let s2 = new C(0);
  for (let n = 1; n <= an.length; n++) {
    const taun = n * mu * pin - (n + 1) * piPrev;
    const f = (2 * n + 1) / (n * (n + 1));
    s1 = s1.add(an[n - 1].mul(pin).add(bn[n - 1].mul(taun)).mul(f));
    s2 = s2.add(an[n - 1].mul(taun).add(bn[n - 1].mul(pin)).mul(f));
    const next = ((2 * n + 1) / n) * mu * pin - ((n + 1) / n) * piPrev;
    piPrev = pin;
    pin = next;
  }
  return { s1, s2 };
}

/** Depolarization factors (L_xy, L_z) of a spheroid with semi-axes a (x, y) and c (z). */
export function depolarization(a: number, c: number): [number, number] {
  if (Math.abs(a - c) / Math.max(a, c) < 1e-6) return [1 / 3, 1 / 3];
  let Lz: number;
  if (c > a) {
    const e = Math.sqrt(1 - (a * a) / (c * c));
    Lz = ((1 - e * e) / (e * e)) * ((1 / (2 * e)) * Math.log((1 + e) / (1 - e)) - 1);
  } else {
    const e = Math.sqrt(1 - (c * c) / (a * a));
    Lz = (1 / (e * e)) * (1 - (Math.sqrt(1 - e * e) / e) * Math.asin(e));
  }
  return [(1 - Lz) / 2, Lz];
}

/**
 * Quasi-static (radiatively corrected) polarizability in nm^3 of a spheroid
 * along one principal axis; epsRel = eps_particle / eps_medium.
 */
export function spheroidPolarizability(volume: number, L: number, epsRel: C, k: number): C {
  const a0 = epsRel.sub(1).div(epsRel.sub(1).mul(L).add(1)).mul(volume / (4 * Math.PI));
  // radiative reaction: alpha / (1 - i 2/3 k^3 alpha)
  return a0.div(new C(1).sub(new C(0, (2 / 3) * k ** 3).mul(a0)));
}
