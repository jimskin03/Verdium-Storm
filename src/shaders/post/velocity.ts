/**
 * Per-object velocity.
 *
 * The camera's own contribution to motion is recovered exactly from the depth
 * buffer downstream, so this pass only has to supply what depth cannot know:
 * the *extra* screen displacement caused by an object moving in world space.
 * Storing that delta rather than the full vector means the buffer is zero for
 * every static pixel, so it can be cleared and left alone whenever nothing in
 * the scene has actually moved — which, in an RTS, is most of the frame.
 *
 * The shader is built from three's own vertex chunks so instanced meshes
 * (vegetation, debris) and skinned meshes (infantry) transform identically to
 * the way they were rasterised into the colour buffer.
 */

export const VELOCITY_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>

uniform mat4 uPrevModelMatrix;
uniform mat4 uPrevViewProjection;

varying vec4 vClipStatic;
varying vec4 vClipMoved;

void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>

  vec4 localPos = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    localPos = instanceMatrix * localPos;
  #endif

  vec4 worldPos = modelMatrix * localPos;
  vec4 prevWorldPos = uPrevModelMatrix * localPos;

  // Both reprojected with the previous view-projection: the difference is
  // purely the object's own motion, free of any camera component.
  vClipStatic = uPrevViewProjection * worldPos;
  vClipMoved  = uPrevViewProjection * prevWorldPos;

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const VELOCITY_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tDepth;
uniform vec2 uResolution;

varying vec4 vClipStatic;
varying vec4 vClipMoved;

void main() {
  // The velocity target cannot share the scene's depth attachment (the same
  // texture is bound for reading), so depth testing is done by hand against the
  // opaque depth buffer instead.
  float sceneDepth = texture2D(tDepth, gl_FragCoord.xy / uResolution).r;
  if (sceneDepth < gl_FragCoord.z - 1e-5) discard;

  vec2 uvStatic = (vClipStatic.xy / vClipStatic.w) * 0.5 + 0.5;
  vec2 uvMoved  = (vClipMoved.xy / vClipMoved.w) * 0.5 + 0.5;

  gl_FragColor = vec4(uvMoved - uvStatic, 0.0, 1.0);
}
`;
