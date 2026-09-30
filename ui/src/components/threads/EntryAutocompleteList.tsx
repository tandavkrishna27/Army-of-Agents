/**
 * EntryAutocompleteList — the @mention suggestion popover used by EntryComposer.
 *
 * Now a thin delegate over the shared ComposerMentionMenu (approved mock v2:
 * one mention picker on every composer surface). Keeps the legacy
 * `entry-autocomplete*` testids so existing Discussion tests and e2e specs
 * keep passing.
 */
import {
  ComposerMentionMenu,
  type MentionOption,
} from "@/components/composer/ComposerMentionMenu";

export type EntrySuggestion = MentionOption;

export interface EntryAutocompleteListProps {
  suggestions: EntrySuggestion[];
  selectionIndex: number;
  onSelect: (suggestion: EntrySuggestion) => void;
  onHover?: (index: number) => void;
}

export function EntryAutocompleteList({
  suggestions,
  selectionIndex,
  onSelect,
  onHover,
}: EntryAutocompleteListProps) {
  return (
    <ComposerMentionMenu
      options={suggestions}
      selectionIndex={selectionIndex}
      onSelect={onSelect}
      onHover={onHover}
      testIdPrefix="entry-autocomplete"
    />
  );
}
