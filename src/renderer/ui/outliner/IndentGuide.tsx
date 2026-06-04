import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';

interface IndentGuideProps {
  onToggleChildren: () => void;
}

export function IndentGuide({ onToggleChildren }: IndentGuideProps) {
  const t = useT();
  return (
    <ButtonControl
      className="indent-guide"
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
