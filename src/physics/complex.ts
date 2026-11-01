// Minimal complex arithmetic for the in-browser material previews and the mock solver.

export class C {
  constructor(
    readonly re: number,
    readonly im = 0,
  ) {}
  static of(v: number | C): C {
    return typeof v === "number" ? new C(v, 0) : v;
  }
  add(o: number | C): C {
    const b = C.of(o);
    return new C(this.re + b.re, this.im + b.im);
  }
  sub(o: number | C): C {
    const b = C.of(o);
    return new C(this.re - b.re, this.im - b.im);
  }
  mul(o: number | C): C {
    const b = C.of(o);
    return new C(this.re * b.re - this.im * b.im, this.re * b.im + this.im * b.re);
  }
  div(o: number | C): C {
    const b = C.of(o);
    const d = b.re * b.re + b.im * b.im;
    return new C((this.re * b.re + this.im * b.im) / d, (this.im * b.re - this.re * b.im) / d);
  }
  neg(): C {
    return new C(-this.re, -this.im);
  }
  conj(): C {
    return new C(this.re, -this.im);
  }
  abs2(): number {
    return this.re * this.re + this.im * this.im;
  }
  abs(): number {
    return Math.hypot(this.re, this.im);
  }
  /** Principal square root (Im >= 0 for the branch cut used with exp(-iωt) materials). */
  sqrt(): C {
    const r = this.abs();
    const re = Math.sqrt((r + this.re) / 2);
    const im = Math.sign(this.im || 1) * Math.sqrt(Math.max(0, (r - this.re) / 2));
    return new C(re, im);
  }
  /** cot of a complex argument (needed by the Mie log-derivative). */
  static cot(z: C): C {
    // cot z = cos z / sin z
    const cos = new C(Math.cos(z.re) * Math.cosh(z.im), -Math.sin(z.re) * Math.sinh(z.im));
    const sin = new C(Math.sin(z.re) * Math.cosh(z.im), Math.cos(z.re) * Math.sinh(z.im));
    return cos.div(sin);
  }
}
