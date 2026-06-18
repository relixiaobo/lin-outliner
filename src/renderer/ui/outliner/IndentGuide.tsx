import type { CSSProperties } from 'react';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';

interface IndentGuideProps {
  guideFor?: string;
  flatMetrics?: {
    top: number;
    height: number;
    marginLeft: number;
  };
  onToggleChildren: () => void;
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
      '--flat-indent-guide-margin-left': `${Math.max(0, flatMetrics.marginLeft)}px`,
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
        onToggleChildren();
      }}
    >
      <span className="indent-guide-line" />
    </ButtonControl>
  );
}
