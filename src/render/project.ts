/**
 * World → screen projection for HUD elements (name plates, floating numbers).
 *
 * Points behind the camera must be rejected before projecting: with the reversed
 * depth buffer, projected depth no longer tells front from back (a point behind the
 * camera lands mirrored, in front of the viewer, with an in-range NDC z), so the test
 * is done in camera space instead.
 */
import * as THREE from 'three';

const _view = new THREE.Vector3();

/**
 * Projects `v` (world space) to NDC in place. Returns false, leaving `v` unchanged,
 * if the point is not in front of the camera's near plane.
 */
export function projectToNdc(v: THREE.Vector3, cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): boolean {
  _view.copy(v).applyMatrix4(cam.matrixWorldInverse);
  if (_view.z > -cam.near) return false;
  v.project(cam);
  return true;
}
