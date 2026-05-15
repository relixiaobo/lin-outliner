import { forwardRef, type HTMLAttributes } from 'react';

interface MenuSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  preserveSelection?: boolean;
}

export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface(
  { children, preserveSelection = false, ...surfaceProps },
  ref,
) {
  return (
    <div
      {...surfaceProps}
      data-preserve-selection={preserveSelection ? 'true' : undefined}
      ref={ref}
    >
      {children}
    </div>
  );
});
