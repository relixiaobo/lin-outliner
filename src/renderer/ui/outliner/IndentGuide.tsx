import type { CSSProperties } from 'react';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';

interface IndentGuideProps {
  guideFor?: string;
  flatMetrics?: {
    left: number;
    top: number;
    height: number;
  };
  onToggleChildren: (anchorElement?: HTMLElement | null) => void;
}

export function IndentGuide({
  flatMetrics,
  guideFor,
  onToggleChildren,
}: IndentGuideProps) {
  const t = useT();
  const flatStyle = flatMetrics
    ? ({
      '--flat-indent-guide-height': `${Math.max(0, flatMetrics.height)}px`,
      '--flat-indent-guide-left': `${Math.max(0, flatMetrics.left)}px`,
      '--flat-indent-guide-top': `${Math.max(0, flatMetrics.top)}px`,
    } as CSSProperties)
    : undefined;
  return (
    <ButtonControl
      className={[
        'indent-guide',
        flatMetrics ? 'indent-guide--flat' : '',
      ].filter(Boolean).join(' ')}
      data-guide-node-id={guideFor}
      style={flatStyle}
      tabIndex={-1}
      title={t.outliner.field.toggleChildren}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleChildren(event.currentTarget);
      }}
    >
      <span className="indent-guide-line" />
    </ButtonControl>
  );
}
