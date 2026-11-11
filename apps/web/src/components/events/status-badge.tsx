import type { EventStatus } from '@festpass/shared';
import { Badge } from '@/components/ui/badge';

const tone = { DRAFT: 'warning', PUBLISHED: 'success', CLOSED: 'neutral' } as const;
const label = { DRAFT: 'Draft', PUBLISHED: 'Published', CLOSED: 'Closed' };

export function StatusBadge({ status }: { status: EventStatus }) {
  return <Badge tone={tone[status]}>{label[status]}</Badge>;
}
