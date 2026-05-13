import type { CSSProperties } from 'react';

interface NodeBulletDotProps {
  style?: CSSProperties;
}

export function NodeBulletDot({ style }: NodeBulletDotProps) {
  return <span aria-hidden="true" className="row-bullet-dot" style={style} />;
}
