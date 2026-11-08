// A text label at a point of the 3D scene: a plain DOM element over the canvas, moved every frame. (drei's <Html>
// mounts a separate React root per label and unmounts it during the scene's commit: React 19 logs a race for each
// label and throws an uncaught removeChild error on every tab switch away from the scene.)

import { useFrame, useThree } from "@react-three/fiber";
import { Children, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Vector3, type Group } from "three";

const P = new Vector3();

export function SceneLabel(props: { position: [number, number, number] | number[]; center?: boolean; className?: string; color?: string; children: ReactNode }) {
  const group = useRef<Group>(null);
  const gl = useThree((s) => s.gl);
  const el = useMemo(() => document.createElement("div"), []);
  useLayoutEffect(() => {
    el.style.cssText = "position:absolute;top:0;left:0;transform-origin:0 0;pointer-events:none;";
    gl.domElement.parentNode?.appendChild(el);
    return () => el.remove();
  }, [gl, el]);
  const text = Children.toArray(props.children).join("");
  useLayoutEffect(() => {
    el.className = props.className ?? "";
    el.style.color = props.color ?? "";
    el.textContent = text;
  }, [el, props.className, props.color, text]);
  useFrame(({ camera, size }) => {
    if (!group.current) return;
    group.current.getWorldPosition(P).project(camera);
    el.style.display = Math.abs(P.z) > 1 ? "none" : "";
    el.style.transform = `translate3d(${((P.x + 1) / 2) * size.width}px,${((1 - P.y) / 2) * size.height}px,0)${props.center ? " translate(-50%,-50%)" : ""}`;
  });
  return <group ref={group} position={props.position as [number, number, number]} />;
}
