import { ButtonControl } from '../primitives/ButtonControl';

interface IndentGuideProps {
  onToggleChildren: () => void;
}

export function IndentGuide({ onToggleChildren }: IndentGuideProps) {
  return (
    <ButtonControl
      className="indent-guide"
      tabIndex={-1}
      title="Toggle children"
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
