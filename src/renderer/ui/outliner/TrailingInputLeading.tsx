import { RowMarker } from './RowMarker';

interface TrailingInputLeadingProps {
  hasContent: boolean;
}

export function TrailingInputLeading({ hasContent }: TrailingInputLeadingProps) {
  return (
    <span className="row-leading trailing-leading">
      <span className="row-chevron-spacer" />
      <span className="row-bullet-button inert">
        <RowMarker
          hasChildren={false}
          expanded={false}
          variant="content"
          className={hasContent ? undefined : 'dimmed'}
        />
      </span>
    </span>
  );
}
