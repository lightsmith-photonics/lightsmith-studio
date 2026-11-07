// Starting scenes. Each is a plain spec, exactly what `lightsmith solve` reads.

import { FDTD_TEMPLATES } from "../api/mock/snapshots";
import type { Json, JsonObject } from "../schema/schema";

const Au = { kind: "library", name: "Au", dataset: "Johnson-Christy" };
const Ag = { kind: "library", name: "Ag", dataset: "Johnson-Christy" };
const Si = { kind: "library", name: "Si", dataset: "Green-2008" };
const SiO2 = { kind: "library", name: "SiO2", dataset: "Malitson" };

const base = (extra: JsonObject): JsonObject => ({
  kind: "scattering",
  schema_version: "0.1",
  medium_index: 1.33,
  illumination: { kind: "plane_wave", direction: [0, 0, 1], polarization: [1, 0, 0] },
  wavelengths: { start_nm: 400, stop_nm: 800, num: 81 },
  ...extra,
});

const sphere = (r: number, material: Json, position: number[] = [0, 0, 0]) => ({
  shape: { kind: "sphere", radius_nm: r },
  material,
  position_nm: position,
});

export interface Template {
  id: string;
  name: string;
  description: string;
  spec: JsonObject;
}

export const TEMPLATES: Template[] = [
  {
    id: "sphere",
    name: "Gold sphere",
    description: "40 nm Au sphere in water: the Mie reference case.",
    spec: base({ particles: [sphere(40, Au)] }),
  },
  {
    id: "dimer",
    name: "Dimer",
    description: "Two 40 nm Au spheres with a 5 nm gap, polarised along the dimer axis.",
    spec: base({
      particles: [sphere(40, Au, [-42.5, 0, 0]), sphere(40, Au, [42.5, 0, 0])],
      wavelengths: { start_nm: 450, stop_nm: 900, num: 61 },
      outputs: {
        cross_sections: true,
        near_field: { plane: "xy", offset_nm: 0, half_width_nm: 120, points: 81, wavelengths_nm: [600] },
        far_field: null,
      },
    }),
  },
  {
    id: "core-shell",
    name: "Core–shell",
    description: "Silica core (30 nm) with a 10 nm gold shell.",
    spec: base({
      particles: [
        {
          shape: { kind: "layered_sphere", core_radius_nm: 30, shells: [{ thickness_nm: 10, material: Au }] },
          material: SiO2,
          position_nm: [0, 0, 0],
        },
      ],
      wavelengths: { start_nm: 450, stop_nm: 1100, num: 66 },
    }),
  },
  {
    id: "rod",
    name: "Nanorod",
    description: "Au rod (20 × 80 nm) excited along its long axis.",
    spec: base({
      particles: [{ shape: { kind: "cylinder", radius_nm: 10, length_nm: 80 }, material: Au, position_nm: [0, 0, 0] }],
      illumination: { kind: "plane_wave", direction: [1, 0, 0], polarization: [0, 0, 1] },
      wavelengths: { start_nm: 450, stop_nm: 1100, num: 66 },
      options: { dda: { dipoles_per_diameter: 24 } },
    }),
  },
  {
    id: "spheroid",
    name: "Silver spheroid",
    description: "Prolate Ag spheroid (20/40 nm semi-axes).",
    spec: base({
      particles: [{ shape: { kind: "spheroid", semi_axis_xy_nm: 20, semi_axis_z_nm: 40 }, material: Ag, position_nm: [0, 0, 0] }],
      illumination: { kind: "plane_wave", direction: [1, 0, 0], polarization: [0, 0, 1] },
      wavelengths: { start_nm: 320, stop_nm: 800, num: 61 },
    }),
  },
  {
    id: "trimer",
    name: "Trimer",
    description: "Three 30 nm Au spheres on an equilateral triangle.",
    spec: base({
      particles: [0, 1, 2].map((i) => {
        const a = (i * 2 * Math.PI) / 3 + Math.PI / 2;
        const R = 36;
        return sphere(30, Au, [Math.round(R * Math.cos(a) * 100) / 100, Math.round(R * Math.sin(a) * 100) / 100, 0]);
      }),
      wavelengths: { start_nm: 450, stop_nm: 900, num: 61 },
    }),
  },
  {
    id: "dielectric",
    name: "Silicon sphere",
    description: "75 nm Si sphere in air: magnetic and electric dipole resonances.",
    spec: base({
      medium_index: 1.0,
      particles: [sphere(75, Si)],
      wavelengths: { start_nm: 450, stop_nm: 1000, num: 111 },
      outputs: {
        cross_sections: true,
        near_field: null,
        far_field: { theta_deg: Array.from({ length: 37 }, (_, i) => i * 5), phi_deg: [0, 90], wavelengths_nm: [700] },
      },
    }),
  },
  {
    id: "substrate",
    name: "Sphere on glass",
    description: "40 nm Au sphere resting on a silica substrate.",
    spec: base({
      medium_index: 1.0,
      particles: [sphere(40, Au, [0, 0, 40])],
      substrate: { material: SiO2, interface_z_nm: 0 },
      illumination: { kind: "plane_wave", direction: [0, 0, -1], polarization: [1, 0, 0] },
    }),
  },
  // FDTD set-ups, defined in scripts/make_fixtures.py so the library has checked, laid out and solved each one.
  ...FDTD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, spec: t.spec })),
];

export const DEFAULT_SPEC: JsonObject = TEMPLATES[0].spec;

/** Particle presets for the "Add particle" menu. */
export const PARTICLE_PRESETS: { id: string; name: string; particle: JsonObject }[] = [
  { id: "sphere", name: "Sphere", particle: sphere(30, Au) },
  { id: "spheroid", name: "Spheroid", particle: { shape: { kind: "spheroid", semi_axis_xy_nm: 20, semi_axis_z_nm: 35 }, material: Au, position_nm: [0, 0, 0] } },
  { id: "cylinder", name: "Cylinder", particle: { shape: { kind: "cylinder", radius_nm: 15, length_nm: 60 }, material: Au, position_nm: [0, 0, 0] } },
  {
    id: "layered_sphere",
    name: "Layered sphere",
    particle: { shape: { kind: "layered_sphere", core_radius_nm: 25, shells: [{ thickness_nm: 8, material: Au }] }, material: SiO2, position_nm: [0, 0, 0] },
  },
];
