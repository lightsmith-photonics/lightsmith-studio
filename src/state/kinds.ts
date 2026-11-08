// Problem kinds as the user sees them. The list of kinds always comes from the live schema;
// this table only adds friendly names and an icon, and a kind it does not know still works
// (generic editors, schema description, schema defaults).

import kindTemplates from "../generated/kind_templates.json";
import type { JsonObject } from "../schema/schema";

export interface KindMeta {
  label: string;
  icon: string;
  blurb: string;
  /** Result kind its solvers return (for the results viewer). */
  result?: string;
}

export const KIND_META: Record<string, KindMeta> = {
  scattering: { label: "Scattering", icon: "◉", blurb: "Particles and clusters: cross sections, near and far fields (Mie, T-matrix, BEM, DDA, FDTD, quasistatic).", result: "cross_sections" },
  layer_stack: { label: "Thin films", icon: "☰", blurb: "Planar multilayers: R, T, A vs wavelength, angle and polarization (TMM, RCWA, FDTD).", result: "spectrum" },
  periodic: { label: "Gratings & metasurfaces", icon: "⫼", blurb: "1D/2D periodic patterned layers: R, T, A and diffraction orders (RCWA, FDTD).", result: "spectrum" },
  mode: { label: "Waveguide modes", icon: "▭", blurb: "Cross-section eigenmodes: n_eff, n_g, loss and field profiles (FDE).", result: "modes" },
  device: { label: "Devices", icon: "⧉", blurb: "Waveguide devices with ports: S-parameters (EME, BPM, FDFD, FDTD).", result: "sparameters" },
  bands: { label: "Photonic bands", icon: "≋", blurb: "Photonic-crystal band structure along a k-path (PWE).", result: "bands" },
  circuit: { label: "Circuits", icon: "⌁", blurb: "Netlists of compact models: circuit S-parameters.", result: "sparameters" },
  optimization: { label: "Inverse design", icon: "✦", blurb: "Topology-optimise a device's design region for an S-parameter objective.", result: "optimization" },
  emission: { label: "Dipole emission", icon: "✺", blurb: "A point dipole near particles: Purcell factor, radiative decay, efficiency and radiation pattern (Mie, FDTD).", result: "emission" },
};

export function kindMeta(kind: string, schemaTitle?: string): KindMeta {
  return KIND_META[kind] ?? { label: schemaTitle || kind, icon: "◇", blurb: "" };
}

/** Example spec per kind, each one solved by the library when the snapshot was made. */
export const KIND_TEMPLATES = kindTemplates as unknown as Record<string, JsonObject>;

export function specKind(spec: JsonObject): string {
  return typeof spec.kind === "string" ? spec.kind : "scattering";
}
