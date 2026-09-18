import DocsPage from '@/components/docs/DocsPage';
import { resolveDocsTopic } from '@/lib/docs/navigation';

/** Query URLs render the selected article on the server for readers without JS. */
export default async function Page({ searchParams }: {
  searchParams: Promise<{ topic?: string | string[] }>;
}) {
  const { topic } = await searchParams;
  return <DocsPage initialTopic={resolveDocsTopic(typeof topic === 'string' ? topic : '')} />;
}
