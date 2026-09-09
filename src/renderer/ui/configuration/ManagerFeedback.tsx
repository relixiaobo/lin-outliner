import { SettingsFeedback } from './SettingsFeedback';

export function ManagerFeedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  return <SettingsFeedback feedback={{ error, notice }} />;
}
