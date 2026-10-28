// Hub owns all file, image and search access. A model executor cannot acquire tools.
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => 'AIPA Hub model executor has no tool permissions');
}
