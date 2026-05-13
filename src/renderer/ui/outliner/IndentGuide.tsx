interface IndentGuideProps {
  onToggleChildren: () => void;
}

export function IndentGuide({ onToggleChildren }: IndentGuideProps) {
  return (
    <button
      className="indent-guide"
      type="button"
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
    </button>
  );
}
